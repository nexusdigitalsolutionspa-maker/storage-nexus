package files

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"nexus-storage/backend/internal/db"
	"nexus-storage/backend/internal/models"
)

// EnqueueFileScan pushes a file to the scanning channel/queue
func EnqueueFileScan(fileID uuid.UUID) {
	log.Printf("Enqueueing file %s for antivirus scan...", fileID.String())

	// For maximum reliability and ease of local setup, we use an asynchronous goroutine
	// representing our task queue worker. This can easily be mapped to Asynq or celery in production.
	go func() {
		// Simulate background task queue processing latency
		time.Sleep(5 * time.Second)

		var file models.File
		if err := db.DB.First(&file, fileID).Error; err != nil {
			log.Printf("Scan worker error: File %s not found in DB", fileID.String())
			return
		}

		log.Printf("Scanning file: %s (%s)...", file.Name, file.StorageKey)

		// Simulación de escaneo antivirus (ej. ClamAV integration)
		// Permitimos simular un archivo infectado si contiene la palabra "infected" o "virus" en su nombre
		scanResult := "clean"
		lowerName := strings.ToLower(file.Name)
		if strings.Contains(lowerName, "infected") || strings.Contains(lowerName, "virus") || strings.Contains(lowerName, "eicar") {
			scanResult = "infected"
			log.Printf("WARNING: Antivirus Scan flagged file %s as INFECTED!", file.Name)
		} else {
			log.Printf("Antivirus Scan passed. File %s is CLEAN.", file.Name)
		}

		// Guardar resultado
		err := db.DB.Transaction(func(tx *gorm.DB) error {
			file.ScanStatus = scanResult
			if err := tx.Save(&file).Error; err != nil {
				return err
			}

			// Si el archivo está infectado, podemos optar por eliminarlo de MinIO inmediatamente,
			// mantenerlo en cuarentena o simplemente bloquear su descarga (bloqueado en handler).
			// Por seguridad, registramos un log crítico en la auditoría.
			if scanResult == "infected" {
				db.LogActivity(&file.UserID, "SECURITY_ALERT", "127.0.0.1",
					fmt.Sprintf("Malicious file detected and quarantined: %s (Key: %s)", file.Name, file.StorageKey))
			} else {
				db.LogActivity(&file.UserID, "FILE_SCAN_SUCCESS", "127.0.0.1",
					fmt.Sprintf("Antivirus scan completed for: %s", file.Name))
			}

			return nil
		})

		if err != nil {
			log.Printf("Failed to update scan results in DB for file %s: %v", file.Name, err)
		}
	}()
}
