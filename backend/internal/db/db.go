package db

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"nexus-storage/backend/internal/models"
)

var DB *gorm.DB

// Connect establishes connection with PostgreSQL and runs migrations
func Connect() {
	var err error

	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	dbname := os.Getenv("DB_NAME")
	sslmode := os.Getenv("DB_SSLMODE")

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=%s TimeZone=UTC",
		host, user, password, dbname, port, sslmode)

	// Configure GORM logger to show queries in development
	gormLogger := logger.Default
	if os.Getenv("ENV") == "development" {
		gormLogger = logger.Default.LogMode(logger.Info)
	}

	// Retry connection because Postgres might still be starting up in docker-compose
	for i := 1; i <= 5; i++ {
		DB, err = gorm.Open(postgres.Open(dsn), &gorm.Config{
			Logger: gormLogger,
		})
		if err == nil {
			break
		}
		log.Printf("Failed to connect to PostgreSQL database (attempt %d/5): %v. Retrying in 3 seconds...", i, err)
		time.Sleep(3 * time.Second)
	}

	if err != nil {
		log.Fatalf("Could not connect to the database: %v", err)
	}

	log.Println("Successfully connected to PostgreSQL.")

	// Run Auto-migrations
	err = DB.AutoMigrate(
		&models.Plan{},
		&models.User{},
		&models.RefreshToken{},
		&models.ApiKey{},
		&models.Folder{},
		&models.File{},
		&models.ShareLink{},
		&models.AuditLog{},
	)
	if err != nil {
		log.Fatalf("Error during database migration: %v", err)
	}

	log.Println("Database migration completed.")

	// Seed database with plans and default users
	seedData()
}

func seedData() {
	// 1. Seed Plans
	plans := []models.Plan{
		{
			Name:              "Básico",
			StorageLimitBytes: 5 * 1024 * 1024 * 1024,   // 5GB
			MaxFileSizeBytes:  50 * 1024 * 1024,         // 50MB
			PriceMonthly:      0.00,
		},
		{
			Name:              "Profesional",
			StorageLimitBytes: 50 * 1024 * 1024 * 1024,  // 50GB
			MaxFileSizeBytes:  500 * 1024 * 1024,        // 500MB
			PriceMonthly:      10.00,
		},
		{
			Name:              "Empresarial",
			StorageLimitBytes: 500 * 1024 * 1024 * 1024, // 500GB
			MaxFileSizeBytes:  5 * 1024 * 1024 * 1024,   // 5GB
			PriceMonthly:      50.00,
		},
	}

	for _, plan := range plans {
		var existing models.Plan
		if err := DB.Where("name = ?", plan.Name).First(&existing).Error; err != nil {
			// Plan does not exist, create it
			if err := DB.Create(&plan).Error; err != nil {
				log.Printf("Error seeding plan %s: %v", plan.Name, err)
			} else {
				log.Printf("Seeded plan: %s", plan.Name)
			}
		}
	}

	// Fetch basic plan to associate with default users
	var basicPlan models.Plan
	if err := DB.Where("name = ?", "Básico").First(&basicPlan).Error; err != nil {
		log.Fatalf("Could not retrieve basic plan for seeding: %v", err)
	}

	// Fetch enterprise plan for admin limits
	var enterprisePlan models.Plan
	if err := DB.Where("name = ?", "Empresarial").First(&enterprisePlan).Error; err != nil {
		log.Fatalf("Could not retrieve enterprise plan for seeding: %v", err)
	}

	// 2. Seed Default Admin User
	adminEmail := "admin@nexus.com"
	var existingAdmin models.User
	if err := DB.Where("email = ?", adminEmail).First(&existingAdmin).Error; err != nil {
		// Admin does not exist, create one
		hashedPassword, err := bcrypt.GenerateFromPassword([]byte("admin_password_123"), bcrypt.DefaultCost)
		if err != nil {
			log.Fatalf("Error hashing password for default admin: %v", err)
		}

		adminUser := models.User{
			Name:         "Nexus Admin",
			Email:        adminEmail,
			PasswordHash: string(hashedPassword),
			Role:         "admin",
			PlanID:       enterprisePlan.ID,
			IsSuspended:  false,
		}

		if err := DB.Create(&adminUser).Error; err != nil {
			log.Printf("Error seeding admin: %v", err)
		} else {
			log.Println("Seeded default administrator user (admin@nexus.com / admin_password_123).")
		}
	}

	// 3. Seed Default Client User for testing
	clientEmail := "client@nexus.com"
	var existingClient models.User
	if err := DB.Where("email = ?", clientEmail).First(&existingClient).Error; err != nil {
		// Client does not exist, create one
		hashedPassword, err := bcrypt.GenerateFromPassword([]byte("client_password_123"), bcrypt.DefaultCost)
		if err != nil {
			log.Fatalf("Error hashing password for default client: %v", err)
		}

		clientUser := models.User{
			Name:         "Test Client",
			Email:        clientEmail,
			PasswordHash: string(hashedPassword),
			Role:         "client",
			PlanID:       basicPlan.ID,
			IsSuspended:  false,
		}

		if err := DB.Create(&clientUser).Error; err != nil {
			log.Printf("Error seeding test client: %v", err)
		} else {
			log.Println("Seeded default client user (client@nexus.com / client_password_123).")
		}
	}
}

// LogActivity registers system actions in the audit log
func LogActivity(userID *uuid.UUID, action, ip, details string) {
	logEntry := models.AuditLog{
		Action:    action,
		IPAddress: ip,
		Details:   details,
	}
	if userID != nil {
		logEntry.UserID = userID
	}

	if err := DB.Create(&logEntry).Error; err != nil {
		fmt.Printf("Error saving audit log: %v\n", err)
	}
}
