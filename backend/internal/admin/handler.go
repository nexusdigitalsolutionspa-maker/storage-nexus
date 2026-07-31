package admin

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"nexus-storage/backend/internal/auth"
	"nexus-storage/backend/internal/db"
	"nexus-storage/backend/internal/models"
	"nexus-storage/backend/internal/storage"
)

// GetStats returns global metrics for the admin dashboard
func GetStats(c *fiber.Ctx) error {
	var totalClients int64
	var suspendedClients int64
	var totalFiles int64
	var totalStorageUsed int64
	var totalPlans int64

	db.DB.Model(&models.User{}).Where("role = ?", "client").Count(&totalClients)
	db.DB.Model(&models.User{}).Where("role = ? AND is_suspended = true", "client").Count(&suspendedClients)
	db.DB.Model(&models.File{}).Where("scan_status != 'uploading'").Count(&totalFiles)
	db.DB.Model(&models.Plan{}).Count(&totalPlans)

	// Sum storage used
	row := db.DB.Model(&models.User{}).Where("role = 'client'").Select("COALESCE(SUM(storage_used), 0)").Row()
	row.Scan(&totalStorageUsed)

	// Simulación del estado de los servidores de almacenamiento (Nodes)
	// En un escenario real, esto se consulta con APIs de MinIO (mc admin info) o Prometheus.
	// Retornamos datos simulados extremadamente profesionales.
	nodes := []fiber.Map{
		{
			"id":             "nexus-node-01",
			"address":        "minio:9000",
			"status":         "online",
			"uptime":         "15 days, 4 hours",
			"disk_total":     1000 * 1024 * 1024 * 1024, // 1TB
			"disk_used":      totalStorageUsed + (12 * 1024 * 1024 * 1024), // Add some dummy OS usage
			"cpu_usage":      14.5, // %
			"memory_usage":   38.2, // %
			"disk_health":    "healthy",
			"active_conns":   42,
		},
		{
			"id":             "nexus-node-02",
			"address":        "minio-replica:9000 (simulated)",
			"status":         "online",
			"uptime":         "15 days, 4 hours",
			"disk_total":     1000 * 1024 * 1024 * 1024,
			"disk_used":      totalStorageUsed + (8 * 1024 * 1024 * 1024),
			"cpu_usage":      8.9,
			"memory_usage":   22.4,
			"disk_health":    "healthy",
			"active_conns":   12,
		},
	}

	return c.JSON(fiber.Map{
		"stats": fiber.Map{
			"total_clients":     totalClients,
			"active_clients":    totalClients - suspendedClients,
			"suspended_clients": suspendedClients,
			"total_files":       totalFiles,
			"total_storage_used": totalStorageUsed,
			"total_plans":       totalPlans,
		},
		"nodes": nodes,
	})
}

// ListClients returns a detailed user list
func ListClients(c *fiber.Ctx) error {
	var users []models.User
	if err := db.DB.Preload("Plan").Where("role = ?", "client").Order("created_at DESC").Find(&users).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch clients"})
	}

	type UserRes struct {
		ID           uuid.UUID   `json:"id"`
		Name         string      `json:"name"`
		Email        string      `json:"email"`
		IsSuspended  bool        `json:"is_suspended"`
		StorageUsed  int64       `json:"storage_used"`
		CreatedAt    time.Time   `json:"created_at"`
		Plan         models.Plan `json:"plan"`
	}

	var response []UserRes
	for _, u := range users {
		response = append(response, UserRes{
			ID:          u.ID,
			Name:        u.Name,
			Email:       u.Email,
			IsSuspended: u.IsSuspended,
			StorageUsed: u.StorageUsed,
			CreatedAt:   u.CreatedAt,
			Plan:        u.Plan,
		})
	}

	return c.JSON(response)
}

// ToggleSuspendClient suspends or reactivates a user account
type SuspendReq struct {
	Suspend bool `json:"suspend"`
}

func ToggleSuspendClient(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	userID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid user ID"})
	}

	req := new(SuspendReq)
	c.BodyParser(req)

	var user models.User
	if err := db.DB.First(&user, userID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Client not found"})
	}

	if user.Role == "admin" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Cannot suspend administrator accounts"})
	}

	user.IsSuspended = req.Suspend
	db.DB.Save(&user)

	action := "CLIENT_REACTIVATE"
	details := fmt.Sprintf("Reactivated account: %s", user.Email)
	if req.Suspend {
		action = "CLIENT_SUSPEND"
		details = fmt.Sprintf("Suspended account: %s", user.Email)
	}

	db.LogActivity(&claims.UserID, action, c.IP(), details)

	return c.JSON(fiber.Map{
		"message":      "User status updated successfully",
		"is_suspended": user.IsSuspended,
	})
}

// UpdateClientPlan upgrades/downgrades a user plan
type UpdatePlanReq struct {
	PlanID string `json:"plan_id"`
}

func UpdateClientPlan(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	userID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid user ID"})
	}

	req := new(UpdatePlanReq)
	c.BodyParser(req)

	planUUID, err := uuid.Parse(req.PlanID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid plan ID format"})
	}

	var plan models.Plan
	if err := db.DB.First(&plan, planUUID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Target plan not found"})
	}

	var user models.User
	if err := db.DB.First(&user, userID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Client not found"})
	}

	oldPlanID := user.PlanID
	user.PlanID = plan.ID
	db.DB.Save(&user)

	db.LogActivity(&claims.UserID, "CLIENT_PLAN_CHANGE", c.IP(),
		fmt.Sprintf("Changed user %s plan from %s to %s", user.Email, oldPlanID, plan.Name))

	return c.JSON(fiber.Map{
		"message": fmt.Sprintf("Client plan successfully updated to %s", plan.Name),
		"plan":    plan,
	})
}

// CRUD PLANS

func ListPlans(c *fiber.Ctx) error {
	var plans []models.Plan
	if err := db.DB.Order("price_monthly ASC").Find(&plans).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch plans"})
	}
	return c.JSON(plans)
}

type CreatePlanReq struct {
	Name              string  `json:"name"`
	StorageLimitBytes int64   `json:"storage_limit_bytes"`
	MaxFileSizeBytes  int64   `json:"max_file_size_bytes"`
	PriceMonthly      float64 `json:"price_monthly"`
}

func CreatePlan(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	req := new(CreatePlanReq)
	if err := c.BodyParser(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.Name == "" || req.StorageLimitBytes <= 0 || req.MaxFileSizeBytes <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Missing or invalid plan attributes"})
	}

	plan := models.Plan{
		Name:              req.Name,
		StorageLimitBytes: req.StorageLimitBytes,
		MaxFileSizeBytes:  req.MaxFileSizeBytes,
		PriceMonthly:      req.PriceMonthly,
	}

	if err := db.DB.Create(&plan).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to create plan"})
	}

	db.LogActivity(&claims.UserID, "PLAN_CREATE", c.IP(), fmt.Sprintf("Created plan %s ($%.2f/mo)", plan.Name, plan.PriceMonthly))

	return c.Status(fiber.StatusCreated).JSON(plan)
}

func UpdatePlan(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	planUUID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid plan ID"})
	}

	req := new(CreatePlanReq)
	c.BodyParser(req)

	var plan models.Plan
	if err := db.DB.First(&plan, planUUID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Plan not found"})
	}

	plan.Name = req.Name
	plan.StorageLimitBytes = req.StorageLimitBytes
	plan.MaxFileSizeBytes = req.MaxFileSizeBytes
	plan.PriceMonthly = req.PriceMonthly

	if err := db.DB.Save(&plan).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to update plan"})
	}

	db.LogActivity(&claims.UserID, "PLAN_UPDATE", c.IP(), fmt.Sprintf("Updated plan %s details", plan.Name))

	return c.JSON(plan)
}

func DeletePlan(c *fiber.Ctx) error {
	claims := c.Locals("user").(*auth.Claims)
	idStr := c.Params("id")
	planUUID, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid plan ID"})
	}

	var plan models.Plan
	if err := db.DB.First(&plan, planUUID).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Plan not found"})
	}

	// Check if users are assigned to this plan
	var count int64
	db.DB.Model(&models.User{}).Where("plan_id = ?", plan.ID).Count(&count)
	if count > 0 {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error": fmt.Sprintf("Cannot delete plan. There are %d users active on this plan. Reassign them first.", count),
		})
	}

	db.DB.Delete(&plan)

	db.LogActivity(&claims.UserID, "PLAN_DELETE", c.IP(), fmt.Sprintf("Deleted plan %s", plan.Name))

	return c.JSON(fiber.Map{"message": "Plan deleted successfully"})
}

// AUDIT TRAIL

// ListAuditLogs returns global logs for security monitoring
func ListAuditLogs(c *fiber.Ctx) error {
	var logs []models.AuditLog
	// Retrieve last 150 audit entries with associated user info
	if err := db.DB.Order("created_at DESC").Limit(150).Find(&logs).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch audit logs"})
	}

	type AuditRes struct {
		ID        uuid.UUID  `json:"id"`
		UserID    *uuid.UUID `json:"user_id,omitempty"`
		Action    string     `json:"action"`
		IPAddress string     `json:"ip_address"`
		Details   string     `json:"details"`
		CreatedAt time.Time  `json:"created_at"`
	}

	var response []AuditRes
	for _, l := range logs {
		response = append(response, AuditRes{
			ID:        l.ID,
			UserID:    l.UserID,
			Action:    l.Action,
			IPAddress: l.IPAddress,
			Details:   l.Details,
			CreatedAt: l.CreatedAt,
		})
	}

	return c.JSON(response)
}
