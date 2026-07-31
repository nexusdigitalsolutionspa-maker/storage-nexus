package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"nexus-storage/backend/internal/auth"
	"nexus-storage/backend/internal/db"
	"nexus-storage/backend/internal/models"
)

var RedisClient *redis.Client

// InitRedis Rate Limiter setup
func InitRedis() {
	addr := fmt.Sprintf("%s:%s", os.Getenv("REDIS_HOST"), os.Getenv("REDIS_PORT"))
	pass := os.Getenv("REDIS_PASSWORD")

	RedisClient = redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: pass,
		DB:       0,
	})

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := RedisClient.Ping(ctx).Result()
	if err != nil {
		logFatal(fmt.Sprintf("Could not connect to Redis: %v", err))
	}
	fmt.Println("Successfully connected to Redis.")
}

func logFatal(msg string) {
	fmt.Println("[FATAL] " + msg)
	os.Exit(1)
}

// RequireAuth authenticates user via JWT (standard login sessions)
func RequireAuth(c *fiber.Ctx) error {
	authHeader := c.Get("Authorization")
	if authHeader == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Missing Authorization header"})
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid Authorization header format. Must be Bearer <token>"})
	}

	tokenStr := parts[1]
	secret := []byte(os.Getenv("JWT_SECRET"))

	claims := &auth.Claims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
		return secret, nil
	})

	if err != nil || !token.Valid {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid or expired JWT token"})
	}

	// Verify user status in DB (accounts could be suspended)
	var user models.User
	if err := db.DB.First(&user, claims.UserID).Error; err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "User no longer exists"})
	}

	if user.IsSuspended {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Account suspended"})
	}

	// Save claims to context
	c.Locals("user", claims)
	c.Locals("auth_method", "jwt")
	return c.Next()
}

// RequireApiKeyOrJWT authenticates either developer API Keys or regular JWT sessions
func RequireApiKeyOrJWT(c *fiber.Ctx) error {
	authHeader := c.Get("Authorization")
	apiKeyHeader := c.Get("X-API-Key")

	tokenStr := ""
	isApiKey := false

	if apiKeyHeader != "" {
		tokenStr = apiKeyHeader
		isApiKey = true
	} else if authHeader != "" {
		parts := strings.Split(authHeader, " ")
		if len(parts) == 2 && parts[0] == "Bearer" {
			tokenStr = parts[1]
			// API keys start with 'ns_key_'
			if strings.HasPrefix(tokenStr, "ns_key_") {
				isApiKey = true
			}
		}
	}

	if tokenStr == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Authentication required. Provide JWT or API Key."})
	}

	if isApiKey {
		// Hash key to search in PostgreSQL
		hash := sha256.Sum256([]byte(tokenStr))
		keyHash := hex.EncodeToString(hash[:])

		var apiKey models.ApiKey
		if err := db.DB.Where("key_hash = ?", keyHash).First(&apiKey).Error; err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid API Key"})
		}

		// Verify user associated with API key
		var user models.User
		if err := db.DB.First(&user, apiKey.UserID).Error; err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "User associated with API Key not found"})
		}

		if user.IsSuspended {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Account suspended"})
		}

		// Update last used at asynchronously
		go func(keyID uuid.UUID) {
			now := time.Now()
			db.DB.Model(&models.ApiKey{}).Where("id = ?", keyID).Update("last_used_at", &now)
		}(apiKey.ID)

		// Create simulated claims for consistent controllers usage
		claims := &auth.Claims{
			UserID: user.ID,
			Role:   user.Role,
		}

		c.Locals("user", claims)
		c.Locals("auth_method", "api_key")
		c.Locals("api_key_scopes", strings.Split(apiKey.Scopes, ","))
		c.Locals("api_key_id", apiKey.ID.String())
		return c.Next()
	}

	// Otherwise, fall back to standard JWT auth logic
	return RequireAuth(c)
}

// RequireAdmin restricts routes to administrator roles
func RequireAdmin(c *fiber.Ctx) error {
	u := c.Locals("user")
	if u == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Authentication required"})
	}

	claims := u.(*auth.Claims)
	if claims.Role != "admin" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Forbidden. Admin privileges required."})
	}

	return c.Next()
}

// CheckScope checks scopes when using API key authentication
func CheckScope(requiredScope string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		authMethod := c.Locals("auth_method")
		if authMethod == nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Authentication required"})
		}

		// JWT session has all permissions within user's role
		if authMethod.(string) == "jwt" {
			return c.Next()
		}

		// API Key authentication validates scopes
		scopes := c.Locals("api_key_scopes")
		if scopes == nil {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Forbidden. No scopes defined for API Key."})
		}

		apiScopes := scopes.([]string)
		hasScope := false
		for _, s := range apiScopes {
			if s == requiredScope || s == "admin" {
				hasScope = true
				break
			}
		}

		if !hasScope {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": fmt.Sprintf("Forbidden. API Key lacks required scope: %s", requiredScope),
			})
		}

		return c.Next()
	}
}

// RateLimiter implements sliding window rate limiting via Redis
func RateLimiter(c *fiber.Ctx) error {
	if RedisClient == nil {
		// Redis not initialized, bypass to prevent locking system (useful for unit tests or setup)
		return c.Next()
	}

	var limitKey string
	var limitCount int
	var duration time.Duration

	// Determine if this is an API Key request or IP request
	authMethod := c.Locals("auth_method")
	apiKeyID := c.Locals("api_key_id")

	if authMethod != nil && authMethod.(string) == "api_key" && apiKeyID != nil {
		// API Key: Allow 60 requests per minute
		limitKey = fmt.Sprintf("rate:key:%s", apiKeyID.(string))
		limitCount = 60
		duration = time.Minute
	} else {
		// IP: Allow 30 requests per minute
		ip := c.IP()
		limitKey = fmt.Sprintf("rate:ip:%s", ip)
		limitCount = 30
		duration = time.Minute
	}

	ctx := context.Background()
	now := time.Now().Unix()

	// Implement sliding window rate limit using a sorted set in Redis
	// Remove records older than the window
	clearBefore := now - int64(duration.Seconds())
	
	pipe := RedisClient.TxPipeline()
	pipe.ZRemRangeByScore(ctx, limitKey, "0", fmt.Sprintf("%d", clearBefore))
	pipe.ZAdd(ctx, limitKey, redis.Z{Score: float64(now), Member: fmt.Sprintf("%d-%d", now, time.Now().Nanosecond())})
	pipe.ZCard(ctx, limitKey)
	pipe.Expire(ctx, limitKey, duration)
	
	cmds, err := pipe.Exec(ctx)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Rate limit check failed"})
	}

	// Card is the 3rd command executed (index 2)
	count, _ := cmds[2].(*redis.IntCmd).Result()

	// Expose headers
	c.Set("X-RateLimit-Limit", fmt.Sprintf("%d", limitCount))
	c.Set("X-RateLimit-Remaining", fmt.Sprintf("%d", max(0, int64(limitCount)-count)))

	if count > int64(limitCount) {
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
			"error": "Too many requests. Please try again later.",
		})
	}

	return c.Next()
}

func max(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
