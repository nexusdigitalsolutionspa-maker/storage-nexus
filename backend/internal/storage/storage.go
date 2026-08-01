package storage

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

var MinioClient *minio.Client
var BucketName string

// InitializeMinio configures and connects to the MinIO instance
func InitializeMinio() {
	endpoint := os.Getenv("MINIO_ENDPOINT") // minio:9000
	accessKeyID := os.Getenv("MINIO_ACCESS_KEY")
	secretAccessKey := os.Getenv("MINIO_SECRET_KEY")
	useSSL := os.Getenv("MINIO_USE_SSL") == "true"
	BucketName = os.Getenv("MINIO_BUCKET_NAME")

	var err error

	// Retry loop for MinIO startup in docker-compose
	for i := 1; i <= 5; i++ {
		MinioClient, err = minio.New(endpoint, &minio.Options{
			Creds:  credentials.NewStaticV4(accessKeyID, secretAccessKey, ""),
			Secure: useSSL,
		})
		if err == nil {
			// Check if we can list buckets to verify connection
			_, err = MinioClient.ListBuckets(context.Background())
			if err == nil {
				break
			}
		}
		log.Printf("Failed to connect to MinIO (attempt %d/5): %v. Retrying in 3 seconds...", i, err)
		time.Sleep(3 * time.Second)
	}

	if err != nil {
		log.Fatalf("Could not connect to MinIO: %v", err)
	}

	log.Println("Successfully connected to MinIO.")

	// Ensure the bucket exists
	ctx := context.Background()
	exists, err := MinioClient.BucketExists(ctx, BucketName)
	if err != nil {
		log.Fatalf("Error checking if bucket exists: %v", err)
	}

	if !exists {
		err = MinioClient.MakeBucket(ctx, BucketName, minio.MakeBucketOptions{})
		if err != nil {
			log.Fatalf("Error creating bucket %s: %v", BucketName, err)
		}
		log.Printf("Created bucket %s in MinIO.", BucketName)
	} else {
		log.Printf("Bucket %s already exists.", BucketName)
	}
}

// GeneratePresignedUploadURL generates a short-lived PUT URL for direct file upload
func GeneratePresignedUploadURL(storageKey, mimeType string, expires time.Duration) (*url.URL, error) {
	ctx := context.Background()

	// Generate presigned PUT URL
	presignedURL, err := MinioClient.PresignedPutObject(ctx, BucketName, storageKey, expires)
	if err != nil {
		return nil, fmt.Errorf("failed to generate presigned PUT URL: %w", err)
	}

	return presignedURL, nil
}

// GeneratePresignedDownloadURL generates a short-lived GET URL for direct file download
func GeneratePresignedDownloadURL(storageKey, originalName string, expires time.Duration) (*url.URL, error) {
	ctx := context.Background()

	reqParams := make(url.Values)
	// Force download behavior and specify downloaded file name
	reqParams.Set("response-content-disposition", fmt.Sprintf("attachment; filename=\"%s\"", originalName))

	presignedURL, err := MinioClient.PresignedGetObject(ctx, BucketName, storageKey, expires, reqParams)
	if err != nil {
		return nil, fmt.Errorf("failed to generate presigned GET URL: %w", err)
	}

	return presignedURL, nil
}

// GeneratePresignedViewURL generates a short-lived GET URL for inline preview (no attachment header)
func GeneratePresignedViewURL(storageKey string, expires time.Duration) (*url.URL, error) {
	ctx := context.Background()
	reqParams := make(url.Values)
	// Keep inline to view in browser
	reqParams.Set("response-content-disposition", "inline")

	presignedURL, err := MinioClient.PresignedGetObject(ctx, BucketName, storageKey, expires, reqParams)
	if err != nil {
		return nil, fmt.Errorf("failed to generate presigned preview URL: %w", err)
	}

	return presignedURL, nil
}

// DeleteObject deletes a file object from MinIO
func DeleteObject(storageKey string) error {
	ctx := context.Background()
	err := MinioClient.RemoveObject(ctx, BucketName, storageKey, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("failed to delete object from MinIO: %w", err)
	}
	return nil
}
