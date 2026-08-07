package main

import (
	"fmt"
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"nexus-storage/backend/internal/models"
)

func main() {
	dsn := "host=localhost user=postgres password=postgres dbname=nexus_storage port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var files []models.File
	db.Find(&files)
	fmt.Printf("Total files: %d\n", len(files))

	var uploadingFiles []models.File
	db.Where("scan_status = ?", "uploading").Find(&uploadingFiles)
	fmt.Printf("Uploading (phantom) files: %d\n", len(uploadingFiles))
	
	// Print any error from deleting a file
	if len(files) > 0 {
		f := files[0]
		fmt.Printf("Attempting to delete file %s (ID: %s)\n", f.Name, f.ID)
		err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Delete(&f).Error; err != nil {
				return err
			}
			return nil
		})
		fmt.Printf("Delete error: %v\n", err)
        
        fmt.Println("Deleting uploading files directly...")
        res := db.Where("scan_status = ?", "uploading").Delete(&models.File{})
        fmt.Printf("Deleted %d phantom files, error: %v\n", res.RowsAffected, res.Error)
	}
}

