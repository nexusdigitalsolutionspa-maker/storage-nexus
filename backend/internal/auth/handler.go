package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"nexus-storage/backend/internal/db"
	"nexus-storage/backend/internal/models"
)

// JWT Claims
type Claims struct {
	UserID uuid.UUID `json:"user_id"`
	Role   string    `json:"role"`
	jwt.RegisteredClaims
}

// GenerateJWT generates an access token (15m expiration)
func GenerateJWT(userID uuid.UUID, role string) (string, error) {
	secret := []byte(os.Getenv("JWT_SECRET"))

	claims := Claims{
		UserID: userID,
		Role:   role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "nexus-storage",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

// GenerateRefreshToken generates a new refresh token, saves it to db, and returns raw token
func GenerateRefreshToken(userID uuid.UUID) (string, error) {
	// Generate random bytes
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	rawToken := hex.EncodeToString(b)

	// Hash the token for database storage
	hash := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(hash[:])

	// Save to DB (expires in 7 days)
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	refreshToken := models.RefreshToken{
		UserID:    userID,
		TokenHash: tokenHash,
		ExpiresAt: expiresAt,
	}

	if err := db.DB.Create(&refreshToken).Error; err != nil {
		return "", err
	}

	return rawToken, nil
}

// Register Request
type RegisterReq struct {
	Name     string `json:"name" validate:"required"`
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required,min=6"`
}

// Register Client
func Register(c *fiber.Ctx) error {
	req := new(RegisterReq)
	if err := c.BodyParser(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.Name == "" || req.Email == "" || len(req.Password) < 6 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Missing required fields or password too short (min 6)"})
	}

	// Retrieve default Básico plan
	var basicPlan models.Plan
	if err := db.DB.Where("name = ?", "Básico").First(&basicPlan).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Base plan not initialized"})
	}

	// Encrypt password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Password hashing failed"})
	}

	user := models.User{
		Name:         req.Name,
		Email:        strings.ToLower(req.Email),
		PasswordHash: string(hashedPassword),
		Role:         "client",
		PlanID:       basicPlan.ID,
		IsSuspended:  false,
	}

	if err := db.DB.Create(&user).Error; err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique") {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Email already registered"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to create user"})
	}

	// Log audit
	db.LogActivity(&user.ID, "USER_REGISTER", c.IP(), fmt.Sprintf("User registered with email: %s", user.Email))

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"message": "User registered successfully",
		"user": fiber.Map{
			"id":    user.ID,
			"name":  user.Name,
			"email": user.Email,
			"role":  user.Role,
		},
	})
}

// Login Request
type LoginReq struct {
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required"`
}

// Login Client or Admin
func Login(c *fiber.Ctx) error {
	req := new(LoginReq)
	if err := c.BodyParser(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	var user models.User
	if err := db.DB.Preload("Plan").Where("email = ?", strings.ToLower(req.Email)).First(&user).Error; err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid email or password"})
	}

	if user.IsSuspended {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Account is suspended. Please contact support."})
	}

	// Check password
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid email or password"})
	}

	// Generate JWT Access Token
	accessToken, err := GenerateJWT(user.ID, user.Role)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate access token"})
	}

	// Generate Refresh Token
	refreshToken, err := GenerateRefreshToken(user.ID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate refresh token"})
	}

	// Set Refresh Token in httpOnly Cookie for security
	c.Cookie(&fiber.Cookie{
		Name:     "refresh_token",
		Value:    refreshToken,
		Expires:  time.Now().Add(7 * 24 * time.Hour),
		HTTPOnly: true,
		Secure:   os.Getenv("ENV") == "production", // Enable in production
		SameSite: "Lax",
		Path:     "/",
	})

	db.LogActivity(&user.ID, "USER_LOGIN", c.IP(), "User logged in successfully")

	return c.JSON(fiber.Map{
		"access_token": accessToken,
		"user": fiber.Map{
			"id":           user.ID,
			"name":         user.Name,
			"email":        user.Email,
			"role":         user.Role,
			"storage_used": user.StorageUsed,
			"plan": fiber.Map{
				"name":                user.Plan.Name,
				"storage_limit_bytes": user.Plan.StorageLimitBytes,
				"max_file_size_bytes": user.Plan.MaxFileSizeBytes,
			},
		},
	})
}

// Refresh Token request uses Cookie (highly secure)
func Refresh(c *fiber.Ctx) error {
	rawToken := c.Cookies("refresh_token")
	if rawToken == "" {
		// Fallback to body read if cookies are not used (e.g. CLI/external apps)
		type FallbackReq struct {
			RefreshToken string `json:"refresh_token"`
		}
		var freq FallbackReq
		if err := c.BodyParser(&freq); err == nil {
			rawToken = freq.RefreshToken
		}
	}

	if rawToken == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Refresh token is required"})
	}

	// Hash token to compare in database
	hash := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(hash[:])

	var dbToken models.RefreshToken
	if err := db.DB.Where("token_hash = ? AND revoked = false AND expires_at > ?", tokenHash, time.Now()).First(&dbToken).Error; err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid or expired refresh token"})
	}

	// Fetch user details
	var user models.User
	if err := db.DB.Preload("Plan").First(&user, dbToken.UserID).Error; err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "User associated with token not found"})
	}

	if user.IsSuspended {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Account is suspended"})
	}

	// Revoke old refresh token (Token Rotation)
	dbToken.Revoked = true
	db.DB.Save(&dbToken)

	// Generate new access and refresh tokens
	newAccessToken, err := GenerateJWT(user.ID, user.Role)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate access token"})
	}

	newRawRefreshToken, err := GenerateRefreshToken(user.ID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate refresh token"})
	}

	// Set cookie
	c.Cookie(&fiber.Cookie{
		Name:     "refresh_token",
		Value:    newRawRefreshToken,
		Expires:  time.Now().Add(7 * 24 * time.Hour),
		HTTPOnly: true,
		Secure:   os.Getenv("ENV") == "production",
		SameSite: "Lax",
		Path:     "/",
	})

	return c.JSON(fiber.Map{
		"access_token":  newAccessToken,
		"refresh_token": newRawRefreshToken, // Return in body for API clients
	})
}

// Logout revokes refresh token
func Logout(c *fiber.Ctx) error {
	rawToken := c.Cookies("refresh_token")
	if rawToken != "" {
		hash := sha256.Sum256([]byte(rawToken))
		tokenHash := hex.EncodeToString(hash[:])

		var dbToken models.RefreshToken
		if err := db.DB.Where("token_hash = ?", tokenHash).First(&dbToken).Error; err == nil {
			dbToken.Revoked = true
			db.DB.Save(&dbToken)
		}
	}

	// Clear Cookie
	c.Cookie(&fiber.Cookie{
		Name:     "refresh_token",
		Value:    "",
		Expires:  time.Now().Add(-1 * time.Hour),
		HTTPOnly: true,
		Path:     "/",
	})

	// Try to get current user from locals (if authenticated)
	if u := c.Locals("user"); u != nil {
		claims := u.(*Claims)
		db.LogActivity(&claims.UserID, "USER_LOGOUT", c.IP(), "User logged out")
	}

	return c.JSON(fiber.Map{"message": "Logged out successfully"})
}

// GetProfile returns current user's details and real-time usage stats
func GetProfile(c *fiber.Ctx) error {
	claims := c.Locals("user").(*Claims)

	var user models.User
	if err := db.DB.Preload("Plan").First(&user, claims.UserID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "User not found"})
	}

	// Count files and folders
	var fileCount int64
	var folderCount int64
	db.DB.Model(&models.File{}).Where("user_id = ?", user.ID).Count(&fileCount)
	db.DB.Model(&models.Folder{}).Where("user_id = ?", user.ID).Count(&folderCount)

	return c.JSON(fiber.Map{
		"id":           user.ID,
		"name":         user.Name,
		"email":        user.Email,
		"role":         user.Role,
		"is_suspended": user.IsSuspended,
		"storage_used": user.StorageUsed,
		"file_count":   fileCount,
		"folder_count": folderCount,
		"plan": fiber.Map{
			"id":                  user.Plan.ID,
			"name":                user.Plan.Name,
			"storage_limit_bytes": user.Plan.StorageLimitBytes,
			"max_file_size_bytes": user.Plan.MaxFileSizeBytes,
		},
	})
}

// API KEYS FUNCTIONALITY

type CreateApiKeyReq struct {
	Name   string   `json:"name" validate:"required"`
	Scopes []string `json:"scopes" validate:"required"`
}

// GenerateApiKey generates a new developer API key
func GenerateApiKey(c *fiber.Ctx) error {
	claims := c.Locals("user").(*Claims)

	req := new(CreateApiKeyReq)
	if err := c.BodyParser(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.Name == "" || len(req.Scopes) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Name and scopes are required"})
	}

	// Generate key bytes
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate key"})
	}
	rawKey := "ns_key_" + hex.EncodeToString(b)

	// Hash key
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	// Validate scopes
	validScopes := []string{"read", "write", "delete", "admin"}
	var cleanScopes []string
	for _, sc := range req.Scopes {
		scLower := strings.ToLower(sc)
		for _, vs := range validScopes {
			if scLower == vs {
				cleanScopes = append(cleanScopes, scLower)
				break
			}
		}
	}

	if len(cleanScopes) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "No valid scopes provided"})
	}

	apiKey := models.ApiKey{
		UserID:  claims.UserID,
		KeyHash: keyHash,
		Name:    req.Name,
		Scopes:  strings.Join(cleanScopes, ","),
	}

	if err := db.DB.Create(&apiKey).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to save API key"})
	}

	db.LogActivity(&claims.UserID, "API_KEY_CREATE", c.IP(), fmt.Sprintf("Created API Key: %s", req.Name))

	// Return rawKey ONLY ONCE
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"message": "API key generated successfully. Save it now, it will not be shown again.",
		"key":     rawKey,
		"details": fiber.Map{
			"id":         apiKey.ID,
			"name":       apiKey.Name,
			"scopes":     cleanScopes,
			"created_at": apiKey.CreatedAt,
		},
	})
}

// ListApiKeys list active api keys for user
func ListApiKeys(c *fiber.Ctx) error {
	claims := c.Locals("user").(*Claims)

	var keys []models.ApiKey
	if err := db.DB.Where("user_id = ?", claims.UserID).Find(&keys).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch API keys"})
	}

	type ApiKeyDetails struct {
		ID         uuid.UUID  `json:"id"`
		Name       string     `json:"name"`
		Scopes     []string   `json:"scopes"`
		LastUsedAt *time.Time `json:"last_used_at,omitempty"`
		CreatedAt  time.Time  `json:"created_at"`
	}

	var response []ApiKeyDetails
	for _, k := range keys {
		response = append(response, ApiKeyDetails{
			ID:         k.ID,
			Name:       k.Name,
			Scopes:     strings.Split(k.Scopes, ","),
			LastUsedAt: k.LastUsedAt,
			CreatedAt:  k.CreatedAt,
		})
	}

	return c.JSON(response)
}

// RevokeApiKey revokes and deletes an API key
func RevokeApiKey(c *fiber.Ctx) error {
	claims := c.Locals("user").(*Claims)
	idStr := c.Params("id")
	keyID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid API Key ID"})
	}

	var key models.ApiKey
	if err := db.DB.Where("id = ? AND user_id = ?", keyID, claims.UserID).First(&key).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "API Key not found"})
	}

	// Hard delete the API key so it is permanently revoked
	if err := db.DB.Unscoped().Delete(&key).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to revoke API key"})
	}

	db.LogActivity(&claims.UserID, "API_KEY_REVOKE", c.IP(), fmt.Sprintf("Revoked API Key: %s", key.Name))

	return c.JSON(fiber.Map{"message": "API key revoked successfully"})
}
