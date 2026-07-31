package main

import (
	"log"
	"os"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"

	"nexus-storage/backend/internal/admin"
	"nexus-storage/backend/internal/auth"
	"nexus-storage/backend/internal/db"
	"nexus-storage/backend/internal/files"
	"nexus-storage/backend/internal/links"
	"nexus-storage/backend/internal/middleware"
	"nexus-storage/backend/internal/storage"
)

func main() {
	log.Println("Starting Nexus Storage Backend API...")

	// 1. Initialize databases and configurations
	db.Connect()
	middleware.InitRedis()
	storage.InitializeMinio()

	// 2. Setup Fiber Router
	app := fiber.New(fiber.Config{
		AppName: "Nexus Storage HTTP API v1.0",
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			log.Printf("Internal Server Error: %v", err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "An unexpected error occurred on the server.",
			})
		},
	})

	// 3. Middlewares
	app.Use(recover.New())
	app.Use(logger.New())

	// Configure CORS explicitly (no "*" in production)
	allowedOrigins := "http://localhost:5173,http://localhost:5174"
	if os.Getenv("ENV") == "production" {
		allowedOrigins = os.Getenv("CLIENT_FRONTEND_URL") + "," + os.Getenv("ADMIN_FRONTEND_URL")
	}
	app.Use(cors.New(cors.Config{
		AllowOrigins:     allowedOrigins,
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization, X-API-Key",
		AllowMethods:     "GET, POST, PUT, DELETE, OPTIONS",
		AllowCredentials: true,
	}))

	// 4. API Endpoints Configuration
	api := app.Group("/api/v1")

	// --- Auth & Profile Routes ---
	authGroup := api.Group("/auth")
	authGroup.Post("/register", auth.Register)
	authGroup.Post("/login", auth.Login)
	authGroup.Post("/refresh", auth.Refresh)
	authGroup.Post("/logout", auth.Logout)
	authGroup.Get("/profile", middleware.RequireAuth, auth.GetProfile)

	// --- API Keys Management ---
	authGroup.Post("/keys", middleware.RequireAuth, auth.GenerateApiKey)
	authGroup.Get("/keys", middleware.RequireAuth, auth.ListApiKeys)
	authGroup.Delete("/keys/:id", middleware.RequireAuth, auth.RevokeApiKey)

	// --- Storage Files & Folders Routes (Rate Limited) ---
	filesGroup := api.Group("/files")
	filesGroup.Post("/upload-request", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("write"), files.RequestUpload)
	filesGroup.Get("/list", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("read"), files.ListDirectory)
	filesGroup.Post("/folders", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("write"), files.CreateFolder)
	filesGroup.Put("/rename/:id", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("write"), files.RenameFile)
	filesGroup.Put("/folders/rename/:id", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("write"), files.RenameFolder)
	filesGroup.Put("/move/:id", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("write"), files.MoveFile)
	filesGroup.Delete("/:id", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("delete"), files.DeleteFile)
	filesGroup.Delete("/folders/:id", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("delete"), files.DeleteFolder)
	filesGroup.Get("/download/:id", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("read"), files.GetDownloadURL)
	filesGroup.Get("/preview/:id", middleware.RequireApiKeyOrJWT, middleware.RateLimiter, middleware.CheckScope("read"), files.GetPreviewURL)

	// --- Public Shared Links (Exempt from JWT auth, rate limited by IP) ---
	sharesGroup := api.Group("/shares")
	sharesGroup.Post("/", middleware.RequireApiKeyOrJWT, middleware.CheckScope("write"), links.CreateShareLink)
	sharesGroup.Get("/", middleware.RequireApiKeyOrJWT, middleware.CheckScope("read"), links.ListShareLinks)
	sharesGroup.Delete("/:id", middleware.RequireApiKeyOrJWT, middleware.CheckScope("delete"), links.RevokeShareLink)
	sharesGroup.Get("/info/:token", middleware.RateLimiter, links.GetShareLinkInfo)
	sharesGroup.Post("/download/:token", middleware.RateLimiter, links.DownloadSharedFile)

	// --- MinIO Event Webhook (Authentication checked internally) ---
	api.Post("/files/webhook", files.MinioWebhook)

	// --- Admin Panel Endpoints (Strict Admin privileges check) ---
	adminGroup := api.Group("/admin")
	adminGroup.Use(middleware.RequireAuth)
	adminGroup.Use(middleware.RequireAdmin)
	adminGroup.Get("/stats", admin.GetStats)
	adminGroup.Get("/clients", admin.ListClients)
	adminGroup.Put("/clients/:id/suspend", admin.ToggleSuspendClient)
	adminGroup.Put("/clients/:id/plan", admin.UpdateClientPlan)
	adminGroup.Get("/plans", admin.ListPlans)
	adminGroup.Post("/plans", admin.CreatePlan)
	adminGroup.Put("/plans/:id", admin.UpdatePlan)
	adminGroup.Delete("/plans/:id", admin.DeletePlan)
	adminGroup.Get("/logs", admin.ListAuditLogs)

	// 5. Start Server
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Backend HTTP Server starting on port %s...", port)
	if err := app.Listen(":" + port); err != nil {
		log.Fatalf("Server failed to listen: %v", err)
	}
}
