package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func postJSON(t *testing.T, url string, payload any) (*http.Response, map[string]any) {
	t.Helper()

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	raw, _ := io.ReadAll(resp.Body)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	return resp, decoded
}

func TestRegisterIssuesASessionAndHidesThePasswordHash(t *testing.T) {
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	resp, body := postJSON(t, gateway.URL+"/auth/register", map[string]string{
		"email": "ada@example.com", "name": "Ada Lovelace", "password": "analytical-engine",
	})

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", resp.StatusCode, body)
	}
	if body["access_token"] == "" || body["access_token"] == nil {
		t.Fatal("expected an access_token in the response")
	}
	if body["refresh_token"] == "" || body["refresh_token"] == nil {
		t.Fatal("expected a refresh_token in the response")
	}

	user, ok := body["user"].(map[string]any)
	if !ok {
		t.Fatalf("expected a user object, got %v", body["user"])
	}
	if user["email"] != "ada@example.com" {
		t.Fatalf("expected the registered email back, got %v", user["email"])
	}
	// The hash must never cross the wire, under any key name.
	for _, key := range []string{"password", "password_hash", "PasswordHash"} {
		if _, present := user[key]; present {
			t.Fatalf("user object leaked %q", key)
		}
	}
}

func TestRegisterRejectsDuplicateEmailAndWeakPassword(t *testing.T) {
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	if resp, _ := postJSON(t, gateway.URL+"/auth/register", map[string]string{
		"email": "dup@example.com", "name": "First", "password": "long-enough-password",
	}); resp.StatusCode != http.StatusOK {
		t.Fatalf("setup registration failed with %d", resp.StatusCode)
	}

	t.Run("duplicate email", func(t *testing.T) {
		resp, _ := postJSON(t, gateway.URL+"/auth/register", map[string]string{
			"email": "dup@example.com", "name": "Second", "password": "another-good-password",
		})
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("expected 409 for a duplicate email, got %d", resp.StatusCode)
		}
	})

	t.Run("email is matched case-insensitively", func(t *testing.T) {
		resp, _ := postJSON(t, gateway.URL+"/auth/register", map[string]string{
			"email": "DUP@Example.com", "name": "Third", "password": "another-good-password",
		})
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("expected 409 — email case must not create a second account, got %d", resp.StatusCode)
		}
	})

	t.Run("short password", func(t *testing.T) {
		resp, _ := postJSON(t, gateway.URL+"/auth/register", map[string]string{
			"email": "short@example.com", "name": "Short", "password": "abc",
		})
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("expected 400 for a short password, got %d", resp.StatusCode)
		}
	})

	t.Run("malformed email", func(t *testing.T) {
		resp, _ := postJSON(t, gateway.URL+"/auth/register", map[string]string{
			"email": "not-an-email", "name": "Nope", "password": "long-enough-password",
		})
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("expected 400 for a malformed email, got %d", resp.StatusCode)
		}
	})
}

func TestLoginRejectsWrongPasswordWithoutRevealingTheAccountExists(t *testing.T) {
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	postJSON(t, gateway.URL+"/auth/register", map[string]string{
		"email": "grace@example.com", "name": "Grace", "password": "nanosecond-wire",
	})

	wrongResp, wrongBody := postJSON(t, gateway.URL+"/auth/login", map[string]string{
		"email": "grace@example.com", "password": "not-the-password",
	})
	unknownResp, unknownBody := postJSON(t, gateway.URL+"/auth/login", map[string]string{
		"email": "nobody@example.com", "password": "not-the-password",
	})

	if wrongResp.StatusCode != http.StatusUnauthorized || unknownResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for both, got %d and %d", wrongResp.StatusCode, unknownResp.StatusCode)
	}
	// Identical wording is the point: a different message for an unknown email
	// would turn the login form into an account-enumeration oracle.
	if wrongBody["error"] != unknownBody["error"] {
		t.Fatalf("login errors differ and leak account existence: %q vs %q",
			wrongBody["error"], unknownBody["error"])
	}
}

func TestLoginSucceedsAndTheTokenReachesProtectedRoutes(t *testing.T) {
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	postJSON(t, gateway.URL+"/auth/register", map[string]string{
		"email": "alan@example.com", "name": "Alan Turing", "password": "enigma-bombe-1936",
	})
	resp, body := postJSON(t, gateway.URL+"/auth/login", map[string]string{
		"email": "alan@example.com", "password": "enigma-bombe-1936",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected a successful login, got %d: %v", resp.StatusCode, body)
	}

	req, _ := http.NewRequest(http.MethodGet, gateway.URL+"/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+body["access_token"].(string))
	meResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer meResp.Body.Close()

	if meResp.StatusCode != http.StatusOK {
		t.Fatalf("expected /auth/me to accept the access token, got %d", meResp.StatusCode)
	}
	var me struct {
		User publicUser `json:"user"`
	}
	_ = json.NewDecoder(meResp.Body).Decode(&me)
	if me.User.Email != "alan@example.com" {
		t.Fatalf("expected the signed-in user back, got %+v", me.User)
	}
}

// The whole point of the gateway's auth layer: without a token, the ML service
// is unreachable. A regression here would silently expose every user's corpus.
func TestProtectedRoutesRejectUnauthenticatedRequests(t *testing.T) {
	reached := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	gateway, _ := newTestGateway(t, backend.URL)

	for _, tc := range []struct{ name, header string }{
		{"no header", ""},
		{"empty bearer", "Bearer "},
		{"not a bearer scheme", "Basic dXNlcjpwYXNz"},
		{"garbage token", "Bearer not-a-real-jwt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, gateway.URL+"/api/documents", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("request error: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d", resp.StatusCode)
			}
		})
	}

	if reached {
		t.Fatal("an unauthenticated request reached the ML service")
	}
}

// The ML service scopes documents by the X-Axiom-User-Id header and has no auth
// of its own, so it trusts that header completely. If the gateway forwarded a
// client-supplied one, any user could read any other user's corpus by sending
// the header themselves.
func TestClientSuppliedIdentityHeadersAreStripped(t *testing.T) {
	var seenID, seenEmail string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenID = r.Header.Get(headerUserID)
		seenEmail = r.Header.Get(headerUserEmail)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	gateway, store := newTestGateway(t, backend.URL)

	req := authedRequest(t, store, http.MethodGet, gateway.URL+"/api/documents", "")
	req.Header.Set(headerUserID, "usr_victim")
	req.Header.Set(headerUserEmail, "victim@example.com")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()

	if seenID == "usr_victim" {
		t.Fatal("the gateway forwarded a client-supplied user id — corpus isolation is bypassable")
	}
	if seenEmail == "victim@example.com" {
		t.Fatal("the gateway forwarded a client-supplied user email")
	}
	if !strings.HasPrefix(seenID, "usr_") {
		t.Fatalf("expected the authenticated user id downstream, got %q", seenID)
	}
	if seenEmail != "proxy-test@example.com" {
		t.Fatalf("expected the authenticated email downstream, got %q", seenEmail)
	}
}

func TestRefreshRotatesTheTokenAndDetectsReuse(t *testing.T) {
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	_, session := postJSON(t, gateway.URL+"/auth/register", map[string]string{
		"email": "rotate@example.com", "name": "Rotate", "password": "rotation-is-good",
	})
	first := session["refresh_token"].(string)

	resp, refreshed := postJSON(t, gateway.URL+"/auth/refresh", map[string]string{"refresh_token": first})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected the first refresh to succeed, got %d: %v", resp.StatusCode, refreshed)
	}
	second := refreshed["refresh_token"].(string)
	if second == first {
		t.Fatal("the refresh token was not rotated — a leaked token would stay valid forever")
	}

	// Replaying the consumed token is the theft signal.
	replayResp, _ := postJSON(t, gateway.URL+"/auth/refresh", map[string]string{"refresh_token": first})
	if replayResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 when replaying a consumed refresh token, got %d", replayResp.StatusCode)
	}

	// …and it must invalidate the attacker's freshly-minted token too.
	afterResp, _ := postJSON(t, gateway.URL+"/auth/refresh", map[string]string{"refresh_token": second})
	if afterResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected reuse detection to revoke the whole session family, got %d", afterResp.StatusCode)
	}
}

func TestLogoutRevokesTheRefreshToken(t *testing.T) {
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	_, session := postJSON(t, gateway.URL+"/auth/register", map[string]string{
		"email": "bye@example.com", "name": "Bye", "password": "see-you-later",
	})
	refresh := session["refresh_token"].(string)

	if resp, _ := postJSON(t, gateway.URL+"/auth/logout", map[string]string{"refresh_token": refresh}); resp.StatusCode != http.StatusOK {
		t.Fatalf("expected logout to succeed, got %d", resp.StatusCode)
	}

	resp, _ := postJSON(t, gateway.URL+"/auth/refresh", map[string]string{"refresh_token": refresh})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected a revoked token to be rejected, got %d", resp.StatusCode)
	}
}

func TestExpiredAccessTokenIsRejected(t *testing.T) {
	gateway, store := newTestGateway(t, "http://127.0.0.1:1")

	user, err := store.CreateUser(context.Background(), "expired@example.com", "Expired", "time-flies-fast")
	if err != nil {
		t.Fatalf("CreateUser() error: %v", err)
	}

	issuer, err := newTokenIssuer()
	if err != nil {
		t.Fatalf("newTokenIssuer() error: %v", err)
	}
	// A negative TTL mints a token that was already expired when signed.
	issuer.accessTTL = -time.Minute

	expired, err := issuer.Issue(user)
	if err != nil {
		t.Fatalf("Issue() error: %v", err)
	}

	req, _ := http.NewRequest(http.MethodGet, gateway.URL+"/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+expired)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected an expired access token to be rejected, got %d", resp.StatusCode)
	}
}

// A token signed with a different secret must not validate — this is what stops
// a token minted by some other deployment (or an attacker's own key) working.
func TestTokenSignedWithAnotherSecretIsRejected(t *testing.T) {
	t.Setenv("JWT_SECRET", "the-real-secret-value-for-this-service")
	real, err := newTokenIssuer()
	if err != nil {
		t.Fatalf("newTokenIssuer() error: %v", err)
	}

	t.Setenv("JWT_SECRET", "a-completely-different-attacker-secret")
	attacker, err := newTokenIssuer()
	if err != nil {
		t.Fatalf("newTokenIssuer() error: %v", err)
	}

	forged, err := attacker.Issue(&User{ID: "usr_forged", Email: "forged@example.com", Name: "Forged"})
	if err != nil {
		t.Fatalf("Issue() error: %v", err)
	}

	if _, err := real.Verify(forged); err == nil {
		t.Fatal("a token signed with a different secret was accepted")
	}
}

func TestDemoSignInWorksAndIsIdempotent(t *testing.T) {
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	first, firstBody := postJSON(t, gateway.URL+"/auth/demo", map[string]string{})
	if first.StatusCode != http.StatusOK {
		t.Fatalf("expected the demo sign-in to succeed, got %d: %v", first.StatusCode, firstBody)
	}

	// A second call must reuse the account rather than fail on the unique email.
	second, secondBody := postJSON(t, gateway.URL+"/auth/demo", map[string]string{})
	if second.StatusCode != http.StatusOK {
		t.Fatalf("expected a repeat demo sign-in to succeed, got %d: %v", second.StatusCode, secondBody)
	}

	firstUser := firstBody["user"].(map[string]any)
	secondUser := secondBody["user"].(map[string]any)
	if firstUser["id"] != secondUser["id"] {
		t.Fatal("repeat demo sign-ins created different accounts")
	}
}

func TestRateLimiterBlocksAfterTheConfiguredNumberOfAttempts(t *testing.T) {
	rl := newRateLimiter(3, time.Minute)

	for i := range 3 {
		if ok, _ := rl.allow("198.51.100.7"); !ok {
			t.Fatalf("attempt %d should have been allowed", i+1)
		}
	}
	if ok, retryAfter := rl.allow("198.51.100.7"); ok {
		t.Fatal("the fourth attempt should have been blocked")
	} else if retryAfter <= 0 {
		t.Fatal("a blocked attempt should report a positive Retry-After")
	}

	// Buckets are per key, so one noisy client can't lock everyone out.
	if ok, _ := rl.allow("203.0.113.9"); !ok {
		t.Fatal("a different client should have its own budget")
	}
}

func TestBearerToken(t *testing.T) {
	cases := map[string]string{
		"Bearer abc":  "abc",
		"bearer abc":  "abc", // the scheme is case-insensitive per RFC 6750
		"BEARER abc":  "abc",
		"Bearer  abc": "abc",
		"Basic abc":   "",
		"abc":         "",
		"":            "",
		"Bearer ":     "",
	}
	for header, want := range cases {
		if got := bearerToken(header); got != want {
			t.Errorf("bearerToken(%q) = %q, want %q", header, got, want)
		}
	}
}
