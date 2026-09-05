package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// newTestGateway boots the real gateway router on a real httptest server.
// httputil.ReverseProxy (via Gin's response writer) probes the writer for
// http.CloseNotifier support, which httptest.NewRecorder() doesn't satisfy
// and panics on — only a genuine net/http server's ResponseWriter works here,
// so this is exercised end-to-end over real HTTP rather than via ServeHTTP
// against a recorder.
func newTestGateway(t *testing.T, mlServiceURL string) (*httptest.Server, Store) {
	t.Helper()
	t.Setenv("ML_SERVICE_URL", mlServiceURL)
	t.Setenv("DATABASE_URL", "")
	t.Setenv("JWT_SECRET", "test-secret-that-is-long-enough-to-be-fine")

	store := newMemoryStore()
	router, err := newRouter(store)
	if err != nil {
		t.Fatalf("newRouter() error: %v", err)
	}
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server, store
}

// authedRequest builds a request carrying a valid access token for a freshly
// created account, so proxy tests exercise the authenticated path.
func authedRequest(t *testing.T, store Store, method, url, body string) *http.Request {
	t.Helper()

	user, err := store.CreateUser(context.Background(), "proxy-test@example.com", "Proxy Tester", "correct-horse-battery")
	if err != nil {
		t.Fatalf("CreateUser() error: %v", err)
	}
	tokens, err := newTokenIssuer()
	if err != nil {
		t.Fatalf("newTokenIssuer() error: %v", err)
	}
	access, err := tokens.Issue(user)
	if err != nil {
		t.Fatalf("Issue() error: %v", err)
	}

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("request build error: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+access)
	return req
}

func TestChatProxyForwardsJSON(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat" {
			t.Errorf("expected backend path /chat, got %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"response":"hello from ml-service"}`))
	}))
	defer backend.Close()

	gateway, store := newTestGateway(t, backend.URL)

	resp, err := http.DefaultClient.Do(authedRequest(t, store, http.MethodPost, gateway.URL+"/api/chat", `{"query":"hi"}`))
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), "hello from ml-service") {
		t.Fatalf("expected proxied body, got: %s", body)
	}
}

func TestChatStreamProxyForwardsSSE(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/stream" {
			t.Errorf("expected backend path /chat/stream, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for _, chunk := range []string{
			`data: {"type": "token", "content": "Hel"}` + "\n\n",
			`data: {"type": "token", "content": "lo"}` + "\n\n",
			`data: {"type": "done"}` + "\n\n",
		} {
			io.WriteString(w, chunk)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer backend.Close()

	gateway, store := newTestGateway(t, backend.URL)

	resp, err := http.DefaultClient.Do(authedRequest(t, store, http.MethodPost, gateway.URL+"/api/chat/stream", `{"query":"hi"}`))
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("expected text/event-stream content type, got %s", ct)
	}
	for _, want := range []string{`"type": "token"`, `"type": "done"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("expected body to contain %q, got: %s", want, body)
		}
	}
}

func TestHealthEndpointDoesNotProxy(t *testing.T) {
	// Point at a deliberately unreachable address to prove /health never touches ml-service.
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	resp, err := http.Get(gateway.URL + "/health")
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected /health to succeed without touching ml-service, got %d", resp.StatusCode)
	}
}

func TestUnreachableMLServiceReturnsBadGateway(t *testing.T) {
	gateway, store := newTestGateway(t, "http://127.0.0.1:1")

	resp, err := http.DefaultClient.Do(authedRequest(t, store, http.MethodPost, gateway.URL+"/api/chat", `{"query":"hi"}`))
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502 Bad Gateway, got %d", resp.StatusCode)
	}
}

func TestPort(t *testing.T) {
	t.Run("defaults to 8080", func(t *testing.T) {
		t.Setenv("PORT", "")
		if got := port(); got != "8080" {
			t.Fatalf("expected default port 8080, got %s", got)
		}
	})

	t.Run("honours PORT", func(t *testing.T) {
		t.Setenv("PORT", "9090")
		if got := port(); got != "9090" {
			t.Fatalf("expected port 9090, got %s", got)
		}
	})
}

func TestAllowedOrigins(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want []string
	}{
		{"unset falls back to localhost", "", []string{"http://localhost:3000"}},
		{"single origin", "https://axiom.example.com", []string{"https://axiom.example.com"}},
		{
			"comma separated list is split and trimmed",
			"https://a.example.com , https://b.example.com",
			[]string{"https://a.example.com", "https://b.example.com"},
		},
		{"blank entries are dropped", " , , ", []string{"http://localhost:3000"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CORS_ALLOWED_ORIGINS", tc.env)
			got := allowedOrigins()
			if len(got) != len(tc.want) {
				t.Fatalf("expected %v, got %v", tc.want, got)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("expected %v, got %v", tc.want, got)
				}
			}
		})
	}
}

// The gateway is the only origin the browser talks to, so a misconfigured
// CORS_ALLOWED_ORIGINS silently breaks every request from a deployed frontend.
// This asserts the configured origin actually reaches the response headers.
func TestCORSAllowsConfiguredOrigin(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "https://axiom.example.com")
	gateway, _ := newTestGateway(t, "http://127.0.0.1:1")

	req, err := http.NewRequest(http.MethodGet, gateway.URL+"/health", nil)
	if err != nil {
		t.Fatalf("request build error: %v", err)
	}
	req.Header.Set("Origin", "https://axiom.example.com")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://axiom.example.com" {
		t.Fatalf("expected configured origin to be allowed, got %q", got)
	}
}

func TestMLServiceTarget(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want string
	}{
		{"unset falls back to the compose service name", "", "http://ml-service:8000"},
		{"explicit http url is used as-is", "http://localhost:8000", "http://localhost:8000"},
		{"https is preserved", "https://ml.example.com", "https://ml.example.com"},
		// Render's blueprint resolves a sibling service to a bare host:port.
		// url.Parse reads that as scheme "axiom-ml-service" with an opaque
		// body, so without the fix the proxy has no host to dial.
		{"bare host:port gets an http scheme", "axiom-ml-service:8000", "http://axiom-ml-service:8000"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ML_SERVICE_URL", tc.env)
			target, err := mlServiceTarget()
			if err != nil {
				t.Fatalf("mlServiceTarget() error: %v", err)
			}
			if got := target.String(); got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
			if target.Host == "" {
				t.Fatal("target has no host — the proxy would have nowhere to dial")
			}
		})
	}
}

// On hosts where the ML service must be publicly routable, the shared secret is
// the only thing stopping a direct call with a forged X-Axiom-User-Id.
func TestGatewaySharedSecretIsAttachedAndNotSpoofable(t *testing.T) {
	var seen string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get(headerGatewayKey)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	t.Setenv("GATEWAY_SHARED_SECRET", "the-real-shared-secret")
	gateway, store := newTestGateway(t, backend.URL)

	req := authedRequest(t, store, http.MethodGet, gateway.URL+"/api/documents", "")
	req.Header.Set(headerGatewayKey, "attacker-supplied-value")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request error: %v", err)
	}
	defer resp.Body.Close()

	if seen != "the-real-shared-secret" {
		t.Fatalf("expected the configured shared secret downstream, got %q", seen)
	}
}
