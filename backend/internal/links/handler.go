package links

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"nexus-storage/backend/internal/auth"
	"nexus-storage/backend/internal/db"
	"nexus-storage/backend/internal/models"
	"nexus-storage/backend/internal/storage"
)

type CreateShareLinkReq struct {
	FileID         string `json:"file_id" validate:"required"`
	Password       string `json:"password,omitempty"`
	ExpiresInHours int    `json:"expires_in_hours,omitempty"` // Opcional (0 para ilimitado)
}

// CreateShareLink generates a new public sharing token
func CreateShareLink(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	req := new(CreateShareLinkReq)
	if err := c.BodyParser(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	fileID, err := uuid.Parse(req.FileID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid file ID format"})
	}

	var file models.File
	if err := db.DB.Where("id = ? AND user_id = ?", fileID, claims.UserID).First(&file).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "File not found"})
	}

	if file.ScanStatus == "infected" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Cannot share an infected file."})
	}

	// Generate secure cryptographically random token
	b := make([]byte, 16)
	rand.Read(b)
	token := hex.EncodeToString(b)

	var passwordHash string
	if req.Password != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Password hashing failed"})
		}
		passwordHash = string(hash)
	}

	var expiresAt *time.Time
	if req.ExpiresInHours > 0 {
		exp := time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour)
		expiresAt = &exp
	}

	shareLink := models.ShareLink{
		FileID:       file.ID,
		UserID:       claims.UserID,
		Token:        token,
		PasswordHash: passwordHash,
		ExpiresAt:    expiresAt,
	}

	if err := db.DB.Create(&shareLink).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to create share link"})
	}

	db.LogActivity(&claims.UserID, "LINK_SHARE", c.IP(), fmt.Sprintf("Shared file %s via token: %s", file.Name, token))

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"token":      token,
		"expires_at": expiresAt,
		"has_pass":   passwordHash != "",
	})
}

// GetShareLinkInfo retrieves shared file metadata without downloading it
func GetShareLinkInfo(c *fiber.Ctx) error {
	token := c.Params("token")

	var shareLink models.ShareLink
	if err := db.DB.Preload("File").Where("token = ?", token).First(&shareLink).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Shared link not found or expired"})
	}

	// Check expiration
	if shareLink.ExpiresAt != nil && shareLink.ExpiresAt.Before(time.Now()) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Shared link has expired"})
	}

	// Check if file is infected
	if shareLink.File.ScanStatus == "infected" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "This file has been flagged as malicious and is blocked."})
	}

	return c.JSON(fiber.Map{
		"name":         shareLink.File.Name,
		"size_bytes":   shareLink.File.Size,
		"mime_type":    shareLink.File.MimeType,
		"requires_pwd": shareLink.PasswordHash != "",
		"created_at":   shareLink.CreatedAt,
		"expires_at":   shareLink.ExpiresAt,
	})
}

type DownloadShareReq struct {
	Password string `json:"password,omitempty"`
}

// DownloadSharedFile verifies credentials and returns direct download link
func DownloadSharedFile(c *fiber.Ctx) error {
	token := c.Params("token")
	req := new(DownloadShareReq)
	c.BodyParser(req)

	var shareLink models.ShareLink
	if err := db.DB.Preload("File").Where("token = ?", token).First(&shareLink).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Shared link not found"})
	}

	if shareLink.ExpiresAt != nil && shareLink.ExpiresAt.Before(time.Now()) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Shared link has expired"})
	}

	if shareLink.File.ScanStatus == "infected" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "File blocked due to safety violations."})
	}

	// Verify password if protected
	if shareLink.PasswordHash != "" {
		if req.Password == "" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Password required for this shared file"})
		}
		if err := bcrypt.CompareHashAndPassword([]byte(shareLink.PasswordHash), []byte(req.Password)); err != nil {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Incorrect password"})
		}
	}

	// Generate presigned GET URL (15 minutes expiry)
	downloadURL, err := storage.GeneratePresignedDownloadURL(shareLink.File.StorageKey, shareLink.File.Name, 15*time.Minute)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate download URL"})
	}

	// Increment downloads asynchronously in transaction
	go func(slID, fileID uuid.UUID) {
		db.DB.Transaction(func(tx *gorm.DB) error {
			tx.Model(&models.ShareLink{}).Where("id = ?", slID).UpdateColumn("download_count", gorm.Expr("download_count + 1"))
			tx.Model(&models.File{}).Where("id = ?", fileID).UpdateColumn("download_count", gorm.Expr("download_count + 1"))
			return nil
		})
	}(shareLink.ID, shareLink.FileID)

	db.LogActivity(nil, "LINK_DOWNLOAD", c.IP(), fmt.Sprintf("Shared file downloaded via token: %s", token))

	return c.JSON(fiber.Map{
		"download_url": downloadURL.String(),
	})
}

// ListShareLinks returns links generated by the user
func ListShareLinks(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)

	var links []models.ShareLink
	if err := db.DB.Preload("File").Where("user_id = ?", claims.UserID).Find(&links).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch share links"})
	}

	type LinkRes struct {
		ID            uuid.UUID  `json:"id"`
		FileName      string     `json:"file_name"`
		Token         string     `json:"token"`
		HasPassword   bool       `json:"has_password"`
		ExpiresAt     *time.Time `json:"expires_at,omitempty"`
		DownloadCount int64      `json:"download_count"`
		CreatedAt     time.Time  `json:"created_at"`
	}

	var response []LinkRes
	for _, l := range links {
		response = append(response, LinkRes{
			ID:            l.ID,
			FileName:      l.File.Name,
			Token:         l.Token,
			HasPassword:   l.PasswordHash != "",
			ExpiresAt:     l.ExpiresAt,
			DownloadCount: l.DownloadCount,
			CreatedAt:     l.CreatedAt,
		})
	}

	return c.JSON(response)
}

// RevokeShareLink revokes a shared token
func RevokeShareLink(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	linkID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid share link ID"})
	}

	var link models.ShareLink
	if err := db.DB.Where("id = ? AND user_id = ?", linkID, claims.UserID).First(&link).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Share link not found"})
	}

	if err := db.DB.Delete(&link).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to revoke share link"})
	}

	db.LogActivity(&claims.UserID, "LINK_REVOKE", c.IP(), fmt.Sprintf("Revoked shared link for token: %s", link.Token))

	return c.JSON(fiber.Map{"message": "Share link revoked successfully"})
}

// ViewSharedFile streams the shared file directly to the browser for inline viewing/embedding (e.g., logo, image, PDF preview)
func ViewSharedFile(c *fiber.Ctx) error {
	token := c.Params("token")

	var shareLink models.ShareLink
	if err := db.DB.Preload("File").Where("token = ?", token).First(&shareLink).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Shared link not found"})
	}

	if shareLink.ExpiresAt != nil && shareLink.ExpiresAt.Before(time.Now()) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Shared link has expired"})
	}

	if shareLink.File.ScanStatus == "infected" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "File blocked due to safety violations."})
	}

	// If the link has a password, direct view is blocked
	if shareLink.PasswordHash != "" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Password protected files cannot be viewed directly."})
	}

	// Fetch from MinIO
	ctx := context.Background()
	object, err := storage.MinioClient.GetObject(ctx, storage.BucketName, shareLink.File.StorageKey, minio.GetObjectOptions{})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to retrieve file from storage"})
	}
	defer object.Close()

	// Get object info for content length
	info, err := object.Stat()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to read file metadata"})
	}

	// Set content headers for inline viewing
	c.Set("Content-Type", shareLink.File.MimeType)
	c.Set("Content-Length", fmt.Sprintf("%d", info.Size))
	c.Set("Content-Disposition", "inline")
	c.Set("Cache-Control", "public, max-age=31536000") // Cache for performance since it's a shared resource

	// Stream file to client
	return c.SendStream(object)
}
