package main

import (
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
func newTestGateway(t *testing.T, mlServiceURL string) *httptest.Server {
	t.Helper()
	t.Setenv("ML_SERVICE_URL", mlServiceURL)
	router, err := newRouter()
	if err != nil {
		t.Fatalf("newRouter() error: %v", err)
	}
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
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

	gateway := newTestGateway(t, backend.URL)

	resp, err := http.Post(gateway.URL+"/api/chat", "application/json", strings.NewReader(`{"query":"hi"}`))
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

	gateway := newTestGateway(t, backend.URL)

	resp, err := http.Post(gateway.URL+"/api/chat/stream", "application/json", strings.NewReader(`{"query":"hi"}`))
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
	gateway := newTestGateway(t, "http://127.0.0.1:1")

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
	gateway := newTestGateway(t, "http://127.0.0.1:1")

	resp, err := http.Post(gateway.URL+"/api/chat", "application/json", strings.NewReader(`{"query":"hi"}`))
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
	gateway := newTestGateway(t, "http://127.0.0.1:1")

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
