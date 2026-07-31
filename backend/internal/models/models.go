package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Base model using UUID instead of uint IDs for enhanced security
type Base struct {
	ID        uuid.UUID      `gorm:"type:uuid;primary_key;default:gen_random_uuid()" json:"id"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"deleted_at,omitempty"`
}

// BeforeCreate hook to generate UUIDs
func (base *Base) BeforeCreate(tx *gorm.DB) error {
	if base.ID == uuid.Nil {
		base.ID = uuid.New()
	}
	return nil
}

// Plan represents user storage plans
type Plan struct {
	Base
	Name              string `gorm:"uniqueIndex;not null" json:"name"` // Básico, Profesional, Empresarial
	StorageLimitBytes int64  `gorm:"not null" json:"storage_limit_bytes"`
	MaxFileSizeBytes  int64  `gorm:"not null" json:"max_file_size_bytes"`
	PriceMonthly      float64 `gorm:"not null" json:"price_monthly"`
	Users             []User `gorm:"foreignKey:PlanID" json:"users,omitempty"`
}

// User represents both customers and administrators
type User struct {
	Base
	Name         string         `gorm:"not null" json:"name"`
	Email        string         `gorm:"uniqueIndex;not null" json:"email"`
	PasswordHash string         `gorm:"not null" json:"-"`
	Role         string         `gorm:"type:varchar(20);default:'client'" json:"role"` // 'client' or 'admin'
	PlanID       uuid.UUID      `gorm:"type:uuid;not null" json:"plan_id"`
	Plan         Plan           `gorm:"foreignKey:PlanID" json:"plan"`
	IsSuspended  bool           `gorm:"default:false" json:"is_suspended"`
	StorageUsed  int64          `gorm:"default:0" json:"storage_used"` // Cache value, updated via files and webhooks
	Files        []File         `gorm:"foreignKey:UserID" json:"files,omitempty"`
	Folders      []Folder       `gorm:"foreignKey:UserID" json:"folders,omitempty"`
	ApiKeys      []ApiKey       `gorm:"foreignKey:UserID" json:"api_keys,omitempty"`
	AuditLogs    []AuditLog     `gorm:"foreignKey:UserID" json:"audit_logs,omitempty"`
}

// RefreshToken implements JWT token rotation
type RefreshToken struct {
	ID        uuid.UUID `gorm:"type:uuid;primary_key;default:gen_random_uuid()" json:"id"`
	UserID    uuid.UUID `gorm:"type:uuid;not null" json:"user_id"`
	TokenHash string    `gorm:"uniqueIndex;not null" json:"token_hash"`
	ExpiresAt time.Time `gorm:"not null" json:"expires_at"`
	Revoked   bool      `gorm:"default:false" json:"revoked"`
	CreatedAt time.Time `json:"created_at"`
}

// ApiKey provides secure keys for external developer access
type ApiKey struct {
	Base
	UserID     uuid.UUID `gorm:"type:uuid;not null" json:"user_id"`
	KeyHash    string    `gorm:"uniqueIndex;not null" json:"key_hash"` // SHA-256 hash of API key
	Name       string    `gorm:"not null" json:"name"`                 // e.g. "Production Server Key"
	Scopes     string    `gorm:"not null" json:"scopes"`               // comma-separated: e.g. "read,write"
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
}

// Folder represents virtual folders in Google Drive style
type Folder struct {
	Base
	Name     string    `gorm:"not null" json:"name"`
	Path     string    `gorm:"not null" json:"path"` // e.g. "/Documents/Images"
	ParentID *uuid.UUID `gorm:"type:uuid;index" json:"parent_id"`
	UserID   uuid.UUID `gorm:"type:uuid;not null;index" json:"user_id"`
	Files    []File    `gorm:"foreignKey:FolderID" json:"files,omitempty"`
}

// File represents file metadata associated with MinIO objects
type File struct {
	Base
	Name         string     `gorm:"not null" json:"name"`
	Size         int64      `gorm:"not null" json:"size_bytes"`
	MimeType     string     `gorm:"not null" json:"mime_type"`
	FolderID     *uuid.UUID `gorm:"type:uuid;index" json:"folder_id"`
	UserID       uuid.UUID  `gorm:"type:uuid;not null;index" json:"user_id"`
	StorageKey   string     `gorm:"uniqueIndex;not null" json:"storage_key"` // MinIO path: uuid/filename
	DownloadCount int64      `gorm:"default:0" json:"download_count"`
	ScanStatus   string     `gorm:"type:varchar(20);default:'pending'" json:"scan_status"` // 'pending', 'clean', 'infected'
	ShareLinks   []ShareLink `gorm:"foreignKey:FileID" json:"share_links,omitempty"`
}

// ShareLink represents shareable links with optional expiration and passwords
type ShareLink struct {
	ID           uuid.UUID `gorm:"type:uuid;primary_key;default:gen_random_uuid()" json:"id"`
	FileID       uuid.UUID `gorm:"type:uuid;not null;index" json:"file_id"`
	File         File      `gorm:"foreignKey:FileID" json:"file"`
	UserID       uuid.UUID `gorm:"type:uuid;not null" json:"user_id"`
	Token        string    `gorm:"uniqueIndex;not null" json:"token"` // Unique link hash
	PasswordHash string    `json:"-"`                                 // Optional password bcrypt hash
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	DownloadCount int64     `gorm:"default:0" json:"download_count"`
	CreatedAt    time.Time `json:"created_at"`
}

// AuditLog records security and system actions
type AuditLog struct {
	ID        uuid.UUID `gorm:"type:uuid;primary_key;default:gen_random_uuid()" json:"id"`
	UserID    *uuid.UUID `gorm:"type:uuid;index" json:"user_id,omitempty"`
	Action    string    `gorm:"not null" json:"action"` // e.g. "USER_LOGIN", "FILE_UPLOAD"
	IPAddress string    `json:"ip_address"`
	Details   string    `json:"details"`
	CreatedAt time.Time `json:"created_at"`
}
