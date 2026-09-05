package main

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// memoryStore is the Postgres-free implementation used by the test suite and
// by a bare `go run` with no DATABASE_URL. It holds everything in maps behind
// a single mutex — correct for the handful of operations auth performs, and
// deliberately not durable.
type memoryStore struct {
	mu     sync.RWMutex
	users  map[string]*User // keyed by id
	byMail map[string]string
	tokens map[string]*storedToken
}

type storedToken struct {
	userID    string
	expiresAt time.Time
	revoked   bool
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		users:  make(map[string]*User),
		byMail: make(map[string]string),
		tokens: make(map[string]*storedToken),
	}
}

func (s *memoryStore) Close() error { return nil }

func (s *memoryStore) CreateUser(_ context.Context, email, name, password string) (*User, error) {
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

	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.byMail[email]; exists {
		return nil, ErrEmailTaken
	}

	user := &User{ID: id, Email: email, Name: name, PasswordHash: hash, CreatedAt: time.Now().UTC()}
	s.users[id] = user
	s.byMail[email] = id
	return copyUser(user), nil
}

// Callers get a copy so a mutation on the returned value can't reach into the
// map that other requests are reading.
func copyUser(u *User) *User {
	clone := *u
	return &clone
}

func (s *memoryStore) UserByEmail(_ context.Context, email string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	id, ok := s.byMail[normalizeEmail(email)]
	if !ok {
		return nil, ErrUserNotFound
	}
	return copyUser(s.users[id]), nil
}

func (s *memoryStore) UserByID(_ context.Context, id string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	user, ok := s.users[id]
	if !ok {
		return nil, ErrUserNotFound
	}
	return copyUser(user), nil
}

func (s *memoryStore) Authenticate(ctx context.Context, email, password string) (*User, error) {
	return authenticate(ctx, s, email, password)
}

func (s *memoryStore) StoreRefreshToken(_ context.Context, userID, digest string, expiresAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[digest] = &storedToken{userID: userID, expiresAt: expiresAt}
	return nil
}

func (s *memoryStore) ConsumeRefreshToken(ctx context.Context, token string) (*User, error) {
	digest := hashToken(token)

	s.mu.Lock()
	stored, ok := s.tokens[digest]
	if !ok {
		s.mu.Unlock()
		return nil, ErrTokenInvalid
	}
	if stored.revoked {
		// Replay of an already-rotated token: treat it as theft and drop every
		// session for the user. Mirrors the Postgres implementation.
		owner := stored.userID
		for _, t := range s.tokens {
			if t.userID == owner {
				t.revoked = true
			}
		}
		s.mu.Unlock()
		log.Printf("refresh-token reuse detected for %s; revoked all sessions", owner)
		return nil, ErrTokenReused
	}
	if time.Now().UTC().After(stored.expiresAt) {
		s.mu.Unlock()
		return nil, ErrTokenInvalid
	}
	stored.revoked = true
	userID := stored.userID
	s.mu.Unlock()

	return s.UserByID(ctx, userID)
}

func (s *memoryStore) RevokeRefreshToken(_ context.Context, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if stored, ok := s.tokens[hashToken(token)]; ok {
		stored.revoked = true
	}
	return nil
}

func (s *memoryStore) RevokeAllForUser(_ context.Context, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.tokens {
		if t.userID == userID {
			t.revoked = true
		}
	}
	return nil
}

func (s *memoryStore) PurgeExpiredTokens(_ context.Context) error {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	for digest, t := range s.tokens {
		if now.After(t.expiresAt) {
			delete(s.tokens, digest)
		}
	}
	return nil
}

// authenticate is shared by both stores: the password comparison and the
// enumeration-resistant dummy hash are identical either way, so only the user
// lookup differs.
func authenticate(ctx context.Context, s Store, email, password string) (*User, error) {
	user, err := s.UserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
			return nil, ErrInvalidLogin
		}
		return nil, err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, ErrInvalidLogin
	}
	return user, nil
}
