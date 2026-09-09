package main

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Headers the gateway sets on proxied requests so the ML service can scope
// documents and retrieval to the authenticated user.
const (
	headerUserID    = "X-Axiom-User-Id"
	headerUserEmail = "X-Axiom-User-Email"
	contextUserKey  = "axiomUser"
)

type authHandler struct {
	store  Store
	tokens *TokenIssuer
}

type registerRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type publicUser struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

func toPublicUser(u *User) publicUser {
	return publicUser{ID: u.ID, Email: u.Email, Name: u.Name, CreatedAt: u.CreatedAt.Format(time.RFC3339)}
}

type sessionResponse struct {
	User         publicUser `json:"user"`
	AccessToken  string     `json:"access_token"`
	RefreshToken string     `json:"refresh_token"`
	ExpiresIn    int        `json:"expires_in"`
	TokenType    string     `json:"token_type"`
}

// issueSession mints an access/refresh pair for a freshly authenticated user.
func (h *authHandler) issueSession(c *gin.Context, user *User) {
	access, err := h.tokens.Issue(user)
	if err != nil {
		log.Printf("failed to sign access token: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start a session"})
		return
	}

	refresh, digest, err := newRefreshToken()
	if err != nil {
		log.Printf("failed to generate refresh token: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start a session"})
		return
	}

	expiresAt := time.Now().UTC().Add(h.tokens.RefreshTTL())
	if err := h.store.StoreRefreshToken(c.Request.Context(), user.ID, digest, expiresAt); err != nil {
		log.Printf("failed to persist refresh token: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start a session"})
		return
	}

	c.JSON(http.StatusOK, sessionResponse{
		User:         toPublicUser(user),
		AccessToken:  access,
		RefreshToken: refresh,
		ExpiresIn:    int(h.tokens.AccessTTL().Seconds()),
		TokenType:    "Bearer",
	})
}

func (h *authHandler) register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "malformed request body"})
		return
	}

	user, err := h.store.CreateUser(c.Request.Context(), req.Email, req.Name, req.Password)
	if err != nil {
		switch {
		case errors.Is(err, ErrEmailTaken):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		case errors.Is(err, ErrInvalidEmail), errors.Is(err, ErrWeakPassword),
			errors.Is(err, ErrNameRequired), errors.Is(err, ErrPasswordLength):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			log.Printf("register failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create the account"})
		}
		return
	}

	h.issueSession(c, user)
}

func (h *authHandler) login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "malformed request body"})
		return
	}

	user, err := h.store.Authenticate(c.Request.Context(), req.Email, req.Password)
	if err != nil {
		if errors.Is(err, ErrInvalidLogin) {
			// One message for both "no such account" and "wrong password" —
			// distinguishing them would confirm which emails are registered.
			c.JSON(http.StatusUnauthorized, gin.H{"error": ErrInvalidLogin.Error()})
			return
		}
		log.Printf("login failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not sign you in"})
		return
	}

	h.issueSession(c, user)
}

func (h *authHandler) refresh(c *gin.Context) {
	var req refreshRequest
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.RefreshToken) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a refresh_token is required"})
		return
	}

	user, err := h.store.ConsumeRefreshToken(c.Request.Context(), req.RefreshToken)
	if err != nil {
		switch {
		case errors.Is(err, ErrTokenReused):
			c.JSON(http.StatusUnauthorized, gin.H{"error": "session expired — please sign in again"})
		case errors.Is(err, ErrTokenInvalid), errors.Is(err, ErrUserNotFound):
			c.JSON(http.StatusUnauthorized, gin.H{"error": ErrTokenInvalid.Error()})
		default:
			log.Printf("refresh failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not refresh the session"})
		}
		return
	}

	h.issueSession(c, user)
}

func (h *authHandler) logout(c *gin.Context) {
	var req refreshRequest
	// A logout with a missing or unknown token is still a successful logout:
	// the client's goal (no live session) is satisfied either way.
	if err := c.ShouldBindJSON(&req); err == nil && strings.TrimSpace(req.RefreshToken) != "" {
		if err := h.store.RevokeRefreshToken(c.Request.Context(), req.RefreshToken); err != nil {
			log.Printf("logout revoke failed: %v", err)
		}
	}
	c.JSON(http.StatusOK, gin.H{"message": "signed out"})
}

func (h *authHandler) me(c *gin.Context) {
	claims, ok := c.Get(contextUserKey)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}
	user, err := h.store.UserByID(c.Request.Context(), claims.(*Claims).Subject)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": toPublicUser(user)})
}

// requireAuth rejects requests without a valid access token and stamps the
// caller's identity onto the request for downstream handlers and the proxy.
func requireAuth(tokens *TokenIssuer) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Strip any client-supplied copies of the headers the ML service trusts,
		// before they can reach it. Without this, a caller could simply send
		// `X-Axiom-User-Id: <someone else>` and read another user's corpus:
		// the ML service trusts these headers precisely because the gateway is
		// the only thing that sets them. The gateway key is stripped for the
		// same reason — it must never be echoed back from client input.
		c.Request.Header.Del(headerUserID)
		c.Request.Header.Del(headerUserEmail)
		c.Request.Header.Del(headerGatewayKey)

		raw := bearerToken(c.GetHeader("Authorization"))
		if raw == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}

		claims, err := tokens.Verify(raw)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": ErrBadToken.Error()})
			return
		}

		c.Set(contextUserKey, claims)
		c.Request.Header.Set(headerUserID, claims.Subject)
		c.Request.Header.Set(headerUserEmail, claims.Email)
		c.Next()
	}
}

func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
