package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/mail"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrEmailTaken     = errors.New("an account with that email already exists")
	ErrInvalidLogin   = errors.New("incorrect email or password")
	ErrUserNotFound   = errors.New("user not found")
	ErrTokenInvalid   = errors.New("refresh token is invalid or expired")
	ErrTokenReused    = errors.New("refresh token was already used")
	ErrWeakPassword   = errors.New("password must be at least 8 characters")
	ErrInvalidEmail   = errors.New("that doesn't look like a valid email address")
	ErrNameRequired   = errors.New("name is required")
	ErrPasswordLength = errors.New("password must be at most 72 bytes")
)

// User is the persisted account record. PasswordHash never reaches a response
// body — see toPublicUser in auth.go.
type User struct {
	ID           string
	Email        string
	Name         string
	PasswordHash string
	CreatedAt    time.Time
}

// Store is the persistence surface the auth handlers depend on. Two
// implementations satisfy it: Postgres for real deployments, and an in-memory
// map for tests and for a zero-dependency local run.
type Store interface {
	CreateUser(ctx context.Context, email, name, password string) (*User, error)
	UserByEmail(ctx context.Context, email string) (*User, error)
	UserByID(ctx context.Context, id string) (*User, error)
	Authenticate(ctx context.Context, email, password string) (*User, error)

	StoreRefreshToken(ctx context.Context, userID, digest string, expiresAt time.Time) error
	ConsumeRefreshToken(ctx context.Context, token string) (*User, error)
	RevokeRefreshToken(ctx context.Context, token string) error
	RevokeAllForUser(ctx context.Context, userID string) error
	PurgeExpiredTokens(ctx context.Context) error

	Close() error
}

// openStore connects to Postgres when DATABASE_URL is set and otherwise falls
// back to the in-memory store.
//
// The fallback keeps `go run ./gateway` working with no services attached, but
// it is not a deployment mode: accounts vanish on restart, and separate
// instances don't share them. Both compose and the Render blueprint set
// DATABASE_URL, so the real path is what actually gets exercised.
func openStore() (Store, error) {
	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		log.Println("WARNING: DATABASE_URL is not set — using the in-memory auth store. " +
			"Accounts will not survive a restart. Set DATABASE_URL to a Postgres DSN for real use.")
		return newMemoryStore(), nil
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	// Managed Postgres plans cap connections tightly (Render's smallest allows
	// well under a hundred), and this service needs only a handful.
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	s := &postgresStore{db: db}
	if err := s.init(); err != nil {
		_ = db.Close()
		return nil, err
	}
	log.Println("auth store: postgres")
	return s, nil
}

// ---- shared credential rules ----

const (
	// bcrypt silently truncates anything past 72 bytes, so a longer password
	// would authenticate on its first 72 bytes only. Reject it explicitly
	// rather than quietly weakening the credential.
	maxPasswordBytes = 72
	minPasswordChars = 8
)

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func validateCredentials(email, name, password string) error {
	if strings.TrimSpace(name) == "" {
		return ErrNameRequired
	}
	if _, err := mail.ParseAddress(email); err != nil {
		return ErrInvalidEmail
	}
	if len([]rune(password)) < minPasswordChars {
		return ErrWeakPassword
	}
	if len(password) > maxPasswordBytes {
		return ErrPasswordLength
	}
	return nil
}

func newID(prefix string) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(buf), nil
}

// newRefreshToken returns the opaque token handed to the client and the
// SHA-256 digest stored in the database. Only the digest is persisted, so a
// database leak yields no usable session tokens. SHA-256 (not bcrypt) is
// correct here: the input is 256 bits from crypto/rand, so there is no
// low-entropy guess to brute-force.
func newRefreshToken() (token string, digest string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(buf)
	return token, hashToken(token), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// A valid bcrypt digest of an arbitrary string. Comparing against it on the
// unknown-email path burns the same CPU as a real check, so response latency
// doesn't become an account-enumeration oracle.
var dummyHash = []byte("$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy")

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}
