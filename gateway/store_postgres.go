package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

type postgresStore struct {
	db *sql.DB
}

// Timestamps are stored as Unix seconds (BIGINT) rather than TIMESTAMPTZ so
// the value round-trips identically regardless of the session time zone.
const schema = `
CREATE TABLE IF NOT EXISTS users (
	id            TEXT PRIMARY KEY,
	email         TEXT NOT NULL UNIQUE,
	name          TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	created_at    BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
	token_hash TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at BIGINT NOT NULL,
	revoked    BOOLEAN NOT NULL DEFAULT FALSE,
	created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
`

func (s *postgresStore) init() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// A managed database often isn't accepting connections the instant the
	// gateway starts, so retry briefly rather than crash-looping the container.
	var lastErr error
	for attempt := range 10 {
		if err := s.db.PingContext(ctx); err != nil {
			lastErr = err
			log.Printf("waiting for postgres (attempt %d): %v", attempt+1, err)
			select {
			case <-ctx.Done():
				return fmt.Errorf("ping postgres: %w", lastErr)
			case <-time.After(2 * time.Second):
			}
			continue
		}
		lastErr = nil
		break
	}
	if lastErr != nil {
		return fmt.Errorf("ping postgres: %w", lastErr)
	}

	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	return nil
}

func (s *postgresStore) Close() error { return s.db.Close() }

func (s *postgresStore) CreateUser(ctx context.Context, email, name, password string) (*User, error) {
	email = normalizeEmail(email)
	name = strings.TrimSpace(name)
	if err := validateCredentials(email, name, password); err != nil {
		return nil, err
	}

	hash, err := hashPassword(password)
	if err != nil {
		return nil, err
	}
	id, err := newID("usr_")
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
		id, email, name, hash, now.Unix(),
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate key") {
			return nil, ErrEmailTaken
		}
		return nil, fmt.Errorf("insert user: %w", err)
	}

	return &User{ID: id, Email: email, Name: name, PasswordHash: hash, CreatedAt: now}, nil
}

func scanUser(row *sql.Row) (*User, error) {
	var u User
	var created int64
	if err := row.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	u.CreatedAt = time.Unix(created, 0).UTC()
	return &u, nil
}

func (s *postgresStore) UserByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, email, name, password_hash, created_at FROM users WHERE email = $1`,
		normalizeEmail(email)))
}

func (s *postgresStore) UserByID(ctx context.Context, id string) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, email, name, password_hash, created_at FROM users WHERE id = $1`, id))
}

func (s *postgresStore) Authenticate(ctx context.Context, email, password string) (*User, error) {
	return authenticate(ctx, s, email, password)
}

func (s *postgresStore) StoreRefreshToken(ctx context.Context, userID, digest string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO refresh_tokens (token_hash, user_id, expires_at, revoked, created_at)
		 VALUES ($1, $2, $3, FALSE, $4)`,
		digest, userID, expiresAt.Unix(), time.Now().UTC().Unix())
	return err
}

// ConsumeRefreshToken validates and rotates a refresh token in one step.
//
// The UPDATE ... WHERE revoked = FALSE is the atomic claim: two concurrent
// refreshes with the same token both read revoked = FALSE, but only one gets a
// row back from the update, so exactly one wins. Doing the check as a separate
// SELECT would let both proceed.
func (s *postgresStore) ConsumeRefreshToken(ctx context.Context, token string) (*User, error) {
	digest := hashToken(token)

	var userID string
	var expiresAt int64
	err := s.db.QueryRowContext(ctx,
		`UPDATE refresh_tokens SET revoked = TRUE
		 WHERE token_hash = $1 AND revoked = FALSE
		 RETURNING user_id, expires_at`, digest,
	).Scan(&userID, &expiresAt)

	if errors.Is(err, sql.ErrNoRows) {
		// Either the token never existed, or it was already consumed. The
		// second case is a theft signal: a stolen token being replayed after
		// the real client already rotated it. Revoke the whole session family
		// so neither party keeps a live token.
		var owner string
		if lookupErr := s.db.QueryRowContext(ctx,
			`SELECT user_id FROM refresh_tokens WHERE token_hash = $1`, digest,
		).Scan(&owner); lookupErr == nil {
			if revokeErr := s.RevokeAllForUser(ctx, owner); revokeErr != nil {
				log.Printf("failed to revoke sessions after refresh-token reuse for %s: %v", owner, revokeErr)
			}
			return nil, ErrTokenReused
		}
		return nil, ErrTokenInvalid
	}
	if err != nil {
		return nil, err
	}

	if time.Now().UTC().Unix() >= expiresAt {
		return nil, ErrTokenInvalid
	}
	return s.UserByID(ctx, userID)
}

func (s *postgresStore) RevokeRefreshToken(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`, hashToken(token))
	return err
}

func (s *postgresStore) RevokeAllForUser(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, userID)
	return err
}

// PurgeExpiredTokens drops rows that can no longer authenticate anything, so
// the table doesn't grow without bound over the life of a deployment.
func (s *postgresStore) PurgeExpiredTokens(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM refresh_tokens WHERE expires_at < $1`, time.Now().UTC().Unix())
	return err
}
