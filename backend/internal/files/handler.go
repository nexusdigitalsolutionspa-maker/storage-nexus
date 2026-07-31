package files

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"gorm.io/gorm"

	"nexus-storage/backend/internal/auth"
	"nexus-storage/backend/internal/db"
	"nexus-storage/backend/internal/models"
	"nexus-storage/backend/internal/storage"
)

// RequestUploadReq payload for requesting presigned PUT URL
type RequestUploadReq struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MimeType string `json:"mime_type"`
	FolderID string `json:"folder_id"` // Optional
}

// RequestUpload generates the presigned PUT URL after limits validation
func RequestUpload(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)

	req := new(RequestUploadReq)
	if err := c.BodyParser(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	// 1. Sanitizar nombre de archivo para prevenir Path Traversal
	filename := filepath.Base(req.Name)
	if filename == "." || filename == "/" || filename == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid filename"})
	}

	// 2. Fetch User and Plan limits
	var user models.User
	if err := db.DB.Preload("Plan").First(&user, claims.UserID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "User not found"})
	}

	// 3. Validar tamaño del archivo contra límites del Plan
	if req.Size > user.Plan.MaxFileSizeBytes {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{
			"error": fmt.Sprintf("File size exceeds your plan's maximum limit of %s.", formatBytes(user.Plan.MaxFileSizeBytes)),
		})
	}

	// 4. Validar cuota disponible
	if user.StorageUsed+req.Size > user.Plan.StorageLimitBytes {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"error": "Insufficient storage quota. Upgrade your plan or delete some files.",
		})
	}

	// 5. Check folder existence and ownership if folder_id is provided
	var folderIDPtr *uuid.UUID
	if req.FolderID != "" {
		fUUID, err := uuid.Parse(req.FolderID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid folder_id format"})
		}

		var folder models.Folder
		if err := db.DB.Where("id = ? AND user_id = ?", fUUID, user.ID).First(&folder).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Target folder not found"})
		}
		folderIDPtr = &fUUID
	}

	// 6. Generar UUID para el archivo y clave de almacenamiento única
	fileID := uuid.New()
	// Formato: uploads/user_uuid/file_uuid/filename
	storageKey := fmt.Sprintf("uploads/%s/%s/%s", user.ID.String(), fileID.String(), filename)

	// 7. Generar URL Firmada de MinIO (expiración: 5 minutos)
	presignedURL, err := storage.GeneratePresignedUploadURL(storageKey, req.MimeType, 5*time.Minute)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate upload URL"})
	}

	// 8. Registrar archivo con estado 'uploading' en PostgreSQL
	fileMetadata := models.File{
		Base: models.Base{
			ID: fileID,
		},
		Name:       filename,
		Size:       req.Size,
		MimeType:   req.MimeType,
		FolderID:   folderIDPtr,
		UserID:     user.ID,
		StorageKey: storageKey,
		ScanStatus: "uploading",
	}

	if err := db.DB.Create(&fileMetadata).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to register file upload"})
	}

	return c.JSON(fiber.Map{
		"file_id":       fileID,
		"storage_key":   storageKey,
		"presigned_url": presignedURL.String(),
	})
}

// MinioWebhook receives upload notifications from MinIO
func MinioWebhook(c *fiber.Ctx) error {
	// Verificar webhook secret para evitar spoofing
	token := c.Get("Authorization")
	if token == "" {
		token = c.Query("token")
	}

	secret := os.Getenv("WEBHOOK_SECRET")
	if secret != "" {
		expectedToken := "Bearer " + secret
		if token != expectedToken && token != secret {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Unauthorized webhook call"})
		}
	}

	// Estructura de notificación MinIO (S3 Event format)
	type MinioEvent struct {
		Key    string `json:"Key"`
		Records []struct {
			EventName string `json:"eventName"`
			S3        struct {
				Object struct {
					Key  string `json:"key"`
					Size int64  `json:"size"`
				} `json:"object"`
			} `json:"s3"`
		} `json:"Records"`
	}

	var payload MinioEvent
	if err := c.BodyParser(&payload); err != nil {
		// Log error, but return 200/400. Fiber body parser can fail if MinIO structure is slightly different.
		// Let's try raw read if parsing fails.
		raw := c.Body()
		if err := json.Unmarshal(raw, &payload); err != nil {
			log.Printf("Webhook parser error: %v", err)
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid notification payload"})
		}
	}

	if len(payload.Records) == 0 {
		return c.JSON(fiber.Map{"status": "ignored", "reason": "empty records"})
	}

	for _, record := range payload.Records {
		// MinIO object keys are URL-encoded inside the webhook payload
		decodedKey, err := url.QueryUnescape(record.S3.Object.Key)
		if err != nil {
			decodedKey = record.S3.Object.Key
		}

		// Key: uploads/user_uuid/file_uuid/filename
		parts := strings.Split(decodedKey, "/")
		if len(parts) < 4 || parts[0] != "uploads" {
			continue
		}

		userUUIDStr := parts[1]
		fileUUIDStr := parts[2]

		fileUUID, err := uuid.Parse(fileUUIDStr)
		if err != nil {
			log.Printf("Invalid file UUID in webhook key: %s", fileUUIDStr)
			continue
		}

		userUUID, err := uuid.Parse(userUUIDStr)
		if err != nil {
			log.Printf("Invalid user UUID in webhook key: %s", userUUIDStr)
			continue
		}

		// Buscar archivo registrado en estado 'uploading'
		var file models.File
		if err := db.DB.Where("id = ? AND user_id = ? AND scan_status = 'uploading'", fileUUID, userUUID).First(&file).Error; err != nil {
			log.Printf("No matching uploading file found for ID: %s", fileUUIDStr)
			continue
		}

		// Sniff MIME type real leyendo los primeros 512 bytes de MinIO
		realMimeType := file.MimeType
		reader, err := storage.MinioClient.GetObject(
			context.Background(),
			storage.BucketName,
			file.StorageKey,
			minio.GetObjectOptions{},
		)
		if err == nil {
			// Read first 512 bytes for sniffing
			buffer := make([]byte, 512)
			n, readErr := reader.Read(buffer)
			reader.Close()

			if readErr == nil || readErr == io.EOF {
				detectedType := http.DetectContentType(buffer[:n])
				// Clean parameters like ; charset=utf-8
				if idx := strings.Index(detectedType, ";"); idx != -1 {
					detectedType = detectedType[:idx]
				}
				realMimeType = detectedType
				log.Printf("MIME Sniffing result for file %s: %s (declared: %s)", file.Name, realMimeType, file.MimeType)
			}
		} else {
			log.Printf("Failed to get object for MIME sniffing: %v", err)
		}

		// Transacción para actualizar tamaño, tipo MIME, cambiar estado y actualizar cuota del usuario
		err = db.DB.Transaction(func(tx *gorm.DB) error {
			// 1. Actualizar archivo
			file.Size = record.S3.Object.Size
			file.MimeType = realMimeType
			file.ScanStatus = "pending" // Esperando análisis antivirus
			if err := tx.Save(&file).Error; err != nil {
				return err
			}

			// 2. Actualizar almacenamiento consumido en el usuario
			if err := tx.Model(&models.User{}).Where("id = ?", userUUID).
				UpdateColumn("storage_used", gorm.Expr("storage_used + ?", file.Size)).Error; err != nil {
				return err
			}

			return nil
		})

		if err != nil {
			log.Printf("Database transaction failed for webhook file %s: %v", file.Name, err)
			continue
		}

		// Actividad en auditoría
		db.LogActivity(&userUUID, "FILE_UPLOAD", "127.0.0.1", fmt.Sprintf("File uploaded: %s (%s)", file.Name, formatBytes(file.Size)))

		// Encolar tarea de escaneo antivirus (Asíncrona)
		EnqueueFileScan(file.ID)
	}

	return c.JSON(fiber.Map{"status": "processed"})
}

// ListDirectory lists files and folders inside a given directory
func ListDirectory(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	folderIDStr := c.Query("folder_id")

	var folders []models.Folder
	var files []models.File

	queryFolders := db.DB.Where("user_id = ?", claims.UserID)
	queryFiles := db.DB.Where("user_id = ? AND scan_status != 'uploading'", claims.UserID)

	var currentFolderID *uuid.UUID
	if folderIDStr != "" && folderIDStr != "null" && folderIDStr != "root" {
		fUUID, err := uuid.Parse(folderIDStr)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid folder_id format"})
		}
		currentFolderID = &fUUID

		queryFolders = queryFolders.Where("parent_id = ?", fUUID)
		queryFiles = queryFiles.Where("folder_id = ?", fUUID)
	} else {
		queryFolders = queryFolders.Where("parent_id IS NULL")
		queryFiles = queryFiles.Where("folder_id IS NULL")
	}

	if err := queryFolders.Find(&folders).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch folders"})
	}

	if err := queryFiles.Find(&files).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch files"})
	}

	// Construir migas de pan (breadcrumbs) para navegación
	var breadcrumbs []fiber.Map
	if currentFolderID != nil {
		tempID := *currentFolderID
		for {
			var f models.Folder
			if err := db.DB.First(&f, tempID).Error; err != nil {
				break
			}
			breadcrumbs = append([]fiber.Map{{
				"id":   f.ID,
				"name": f.Name,
			}}, breadcrumbs...)

			if f.ParentID == nil {
				break
			}
			tempID = *f.ParentID
		}
	}

	return c.JSON(fiber.Map{
		"folders":     folders,
		"files":       files,
		"breadcrumbs": breadcrumbs,
	})
}

// CreateFolder creates a new folder
type CreateFolderReq struct {
	Name     string `json:"name"`
	ParentID string `json:"parent_id"` // Optional
}

func CreateFolder(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	req := new(CreateFolderReq)
	if err := c.BodyParser(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.Name == "" || strings.ContainsAny(req.Name, `/\<>:"|?*`) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid folder name"})
	}

	var parentIDPtr *uuid.UUID
	parentPath := ""

	if req.ParentID != "" && req.ParentID != "root" {
		pUUID, err := uuid.Parse(req.ParentID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid parent_id format"})
		}
		parentIDPtr = &pUUID

		var parentFolder models.Folder
		if err := db.DB.Where("id = ? AND user_id = ?", pUUID, claims.UserID).First(&parentFolder).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Parent folder not found"})
		}
		parentPath = parentFolder.Path
	}

	fullPath := parentPath + "/" + req.Name

	// Check folder collision
	var existing models.Folder
	err := db.DB.Where("user_id = ? AND name = ? AND (parent_id = ? OR (parent_id IS NULL AND ?))",
		claims.UserID, req.Name, parentIDPtr, parentIDPtr == nil).First(&existing).Error
	if err == nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Folder with this name already exists in directory"})
	}

	folder := models.Folder{
		Name:     req.Name,
		Path:     fullPath,
		ParentID: parentIDPtr,
		UserID:   claims.UserID,
	}

	if err := db.DB.Create(&folder).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to create folder"})
	}

	db.LogActivity(&claims.UserID, "FOLDER_CREATE", c.IP(), fmt.Sprintf("Created folder: %s", folder.Path))

	return c.Status(fiber.StatusCreated).JSON(folder)
}

// RenameFile renames a file metadata
type RenameReq struct {
	Name string `json:"name"`
}

func RenameFile(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	fileID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid file ID"})
	}

	req := new(RenameReq)
	c.BodyParser(req)
	if req.Name == "" || strings.ContainsAny(req.Name, `/\<>:"|?*`) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid file name"})
	}

	var file models.File
	if err := db.DB.Where("id = ? AND user_id = ?", fileID, claims.UserID).First(&file).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "File not found"})
	}

	oldName := file.Name
	file.Name = req.Name
	db.DB.Save(&file)

	db.LogActivity(&claims.UserID, "FILE_RENAME", c.IP(), fmt.Sprintf("Renamed file from %s to %s", oldName, file.Name))

	return c.JSON(file)
}

// RenameFolder renames a folder
func RenameFolder(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	folderID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid folder ID"})
	}

	req := new(RenameReq)
	c.BodyParser(req)
	if req.Name == "" || strings.ContainsAny(req.Name, `/\<>:"|?*`) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid folder name"})
	}

	var folder models.Folder
	if err := db.DB.Where("id = ? AND user_id = ?", folderID, claims.UserID).First(&folder).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Folder not found"})
	}

	oldName := folder.Name
	folder.Name = req.Name
	// Path should theoretically update, but name is the main identifier.
	folder.Path = filepath.Dir(folder.Path) + "/" + req.Name
	db.DB.Save(&folder)

	db.LogActivity(&claims.UserID, "FOLDER_RENAME", c.IP(), fmt.Sprintf("Renamed folder from %s to %s", oldName, folder.Name))

	return c.JSON(folder)
}

// MoveReq handles both file and folder moves
type MoveReq struct {
	TargetFolderID string `json:"target_folder_id"` // empty or "root" for root folder
}

func MoveFile(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	fileID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid file ID"})
	}

	req := new(MoveReq)
	c.BodyParser(req)

	var file models.File
	if err := db.DB.Where("id = ? AND user_id = ?", fileID, claims.UserID).First(&file).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "File not found"})
	}

	var targetUUID *uuid.UUID
	if req.TargetFolderID != "" && req.TargetFolderID != "root" {
		tUUID, err := uuid.Parse(req.TargetFolderID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid target_folder_id format"})
		}
		targetUUID = &tUUID

		var folder models.Folder
		if err := db.DB.Where("id = ? AND user_id = ?", tUUID, claims.UserID).First(&folder).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Target folder not found"})
		}
	}

	file.FolderID = targetUUID
	db.DB.Save(&file)

	db.LogActivity(&claims.UserID, "FILE_MOVE", c.IP(), fmt.Sprintf("Moved file %s", file.Name))

	return c.JSON(file)
}

// DeleteFile deletes a file metadata and from storage
func DeleteFile(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	fileID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid file ID"})
	}

	var file models.File
	if err := db.DB.Where("id = ? AND user_id = ?", fileID, claims.UserID).First(&file).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "File not found"})
	}

	// Delete from MinIO first
	if err := storage.DeleteObject(file.StorageKey); err != nil {
		// Log warning, but proceed to delete from DB to prevent deadlocks
		log.Printf("Warning: failed to delete physical object %s from MinIO: %v", file.StorageKey, err)
	}

	// Update user storage used in a transaction
	err = db.DB.Transaction(func(tx *gorm.DB) error {
		// Deduct user storage (only if file was successfully uploaded)
		if file.ScanStatus != "uploading" {
			if err := tx.Model(&models.User{}).Where("id = ?", file.UserID).
				UpdateColumn("storage_used", gorm.Expr("storage_used - ?", file.Size)).Error; err != nil {
				return err
			}
		}

		// Permanent hard delete or soft delete?
		// Requisitos: "eliminar (con papelera/restaurar)"
		// Let's use soft delete. To empty trash, they delete permanently.
		// For simplicity, GORM .Delete() does a soft delete if DeletedAt is present.
		// Since we want to display a Trash folder, soft deleted items have DeletedAt NOT NULL.
		// When listing files, GORM automatically excludes soft-deleted files unless we use .Unscoped().
		// So standard files list excludes soft deleted ones, which act as "Trash".
		if err := tx.Delete(&file).Error; err != nil {
			return err
		}
		return nil
	})

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to delete file"})
	}

	db.LogActivity(&claims.UserID, "FILE_DELETE", c.IP(), fmt.Sprintf("Soft deleted file: %s", file.Name))

	return c.JSON(fiber.Map{"message": "File moved to trash"})
}

// DeleteFolder soft deletes folder
func DeleteFolder(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	folderID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid folder ID"})
	}

	var folder models.Folder
	if err := db.DB.Where("id = ? AND user_id = ?", folderID, claims.UserID).First(&folder).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Folder not found"})
	}

	// Soft delete the folder
	if err := db.DB.Delete(&folder).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to delete folder"})
	}

	db.LogActivity(&claims.UserID, "FOLDER_DELETE", c.IP(), fmt.Sprintf("Soft deleted folder: %s", folder.Name))

	return c.JSON(fiber.Map{"message": "Folder moved to trash"})
}

// GetDownloadURL gets a presigned GET URL for download
func GetDownloadURL(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	fileID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid file ID"})
	}

	var file models.File
	if err := db.DB.Where("id = ? AND user_id = ?", fileID, claims.UserID).First(&file).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "File not found"})
	}

	if file.ScanStatus == "infected" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "File is blocked because it was flagged as infected."})
	}

	// Generar URL de descarga de MinIO (15 minutos de validez)
	downloadURL, err := storage.GeneratePresignedDownloadURL(file.StorageKey, file.Name, 15*time.Minute)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate download URL"})
	}

	// Incrementar contador de descargas
	db.DB.Model(&file).UpdateColumn("download_count", gorm.Expr("download_count + 1"))

	db.LogActivity(&claims.UserID, "FILE_DOWNLOAD", c.IP(), fmt.Sprintf("Downloaded file: %s", file.Name))

	return c.JSON(fiber.Map{
		"download_url": downloadURL.String(),
	})
}

// GetPreviewURL gets a presigned GET URL for inline browser preview
func GetPreviewURL(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	fileID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid file ID"})
	}

	var file models.File
	if err := db.DB.Where("id = ? AND user_id = ?", fileID, claims.UserID).First(&file).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "File not found"})
	}

	if file.ScanStatus == "infected" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Preview blocked. File is infected."})
	}

	previewURL, err := storage.GeneratePresignedViewURL(file.StorageKey, 15*time.Minute)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate preview URL"})
	}

	return c.JSON(fiber.Map{
		"preview_url": previewURL.String(),
	})
}

// Helper formatting utilities
func formatBytes(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}
