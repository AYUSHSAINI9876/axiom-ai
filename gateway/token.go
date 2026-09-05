package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	// Access tokens are deliberately short-lived: they are bearer credentials
	// held in the browser and cannot be revoked server-side before they expire.
	// The refresh token (revocable, rotated on every use) carries session
	// longevity instead.
	defaultAccessTTL  = 15 * time.Minute
	defaultRefreshTTL = 30 * 24 * time.Hour

	issuer = "axiom-ai"
)

type Claims struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	jwt.RegisteredClaims
}

type TokenIssuer struct {
	secret     []byte
	accessTTL  time.Duration
	refreshTTL time.Duration
}

// newTokenIssuer reads JWT_SECRET, falling back to a random per-process secret.
//
// The fallback is a development convenience, never a shipped default: a
// hardcoded secret in source would let anyone forge tokens against every
// deployment. A random one means tokens simply stop validating after a
// restart, which is a visible annoyance rather than a silent vulnerability.
func newTokenIssuer() (*TokenIssuer, error) {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return nil, fmt.Errorf("generate ephemeral JWT secret: %w", err)
		}
		secret = base64.RawURLEncoding.EncodeToString(buf)
		log.Println("WARNING: JWT_SECRET is not set — generated an ephemeral secret. " +
			"All sessions will be invalidated on restart. Set JWT_SECRET in production.")
	} else if len(secret) < 32 {
		log.Println("WARNING: JWT_SECRET is shorter than 32 characters; use a longer random value.")
	}

	return &TokenIssuer{
		secret:     []byte(secret),
		accessTTL:  durationFromEnv("ACCESS_TOKEN_TTL_MINUTES", time.Minute, defaultAccessTTL),
		refreshTTL: durationFromEnv("REFRESH_TOKEN_TTL_DAYS", 24*time.Hour, defaultRefreshTTL),
	}, nil
}

func durationFromEnv(key string, unit, fallback time.Duration) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		log.Printf("ignoring invalid %s=%q, using default", key, raw)
		return fallback
	}
	return time.Duration(n) * unit
}

func (t *TokenIssuer) AccessTTL() time.Duration  { return t.accessTTL }
func (t *TokenIssuer) RefreshTTL() time.Duration { return t.refreshTTL }

func (t *TokenIssuer) Issue(user *User) (string, error) {
	now := time.Now().UTC()
	claims := Claims{
		Email: user.Email,
		Name:  user.Name,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			Issuer:    issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(t.accessTTL)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(t.secret)
}

var ErrBadToken = errors.New("invalid or expired access token")

func (t *TokenIssuer) Verify(raw string) (*Claims, error) {
	claims := &Claims{}
	// WithValidMethods pins HS256. Without it, a token whose header says
	// "alg":"none" — or an RS256 token whose "key" is this HMAC secret — would
	// be accepted, which is the classic JWT algorithm-confusion bypass.
	token, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) {
		return t.secret, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
	)
	if err != nil || !token.Valid {
		return nil, ErrBadToken
	}
	if claims.Subject == "" {
		return nil, ErrBadToken
	}
	return claims, nil
}
