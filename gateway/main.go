package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// shutdownTimeout bounds how long in-flight requests (including open SSE
// streams) get to finish after a SIGINT/SIGTERM before the process exits.
const shutdownTimeout = 15 * time.Second

func main() {
	store, err := openStore()
	if err != nil {
		log.Fatalf("failed to open auth store: %v", err)
	}
	defer func() { _ = store.Close() }()

	if err := store.PurgeExpiredTokens(context.Background()); err != nil {
		log.Printf("could not purge expired refresh tokens at startup: %v", err)
	}

	r, err := newRouter(store)
	if err != nil {
		log.Fatalf("failed to configure gateway: %v", err)
	}

	srv := &http.Server{
		Addr:    ":" + port(),
		Handler: r,
		// ReadHeaderTimeout bounds slow-header (Slowloris) clients. ReadTimeout
		// and WriteTimeout are deliberately left at zero: WriteTimeout is an
		// absolute deadline on the whole response, which would truncate long
		// SSE token streams mid-answer, and ReadTimeout would cap large
		// document uploads.
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Serve in the background so the main goroutine can wait on signals.
	serveErr := make(chan error, 1)
	go func() {
		log.Printf("Axiom Gateway listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	// SIGTERM is what `docker stop` and Kubernetes send; without handling it the
	// container would be killed mid-stream after the grace period.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serveErr:
		if err != nil {
			log.Fatalf("gateway server error: %v", err)
		}
	case sig := <-stop:
		log.Printf("received %s, shutting down gracefully", sig)
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown failed, forcing close: %v", err)
			_ = srv.Close()
		}
		log.Println("gateway stopped")
	}
}

func port() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "8080"
}

// allowedOrigins reads the browser origins permitted to call this gateway.
// It is configurable so a deployed frontend isn't stuck on the localhost
// default baked in for development.
func allowedOrigins() []string {
	raw := os.Getenv("CORS_ALLOWED_ORIGINS")
	if raw == "" {
		return []string{"http://localhost:3000"}
	}

	var origins []string
	for _, o := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	if len(origins) == 0 {
		return []string{"http://localhost:3000"}
	}
	return origins
}

// corsConfig builds the CORS policy, with a wildcard-subdomain escape hatch for
// Vercel preview deployments (every PR gets its own generated hostname, so an
// exact-match list can't cover them).
func corsConfig() cors.Config {
	cfg := cors.Config{
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}

	var exact []string
	var suffixes []string
	for _, origin := range allowedOrigins() {
		if strings.HasPrefix(origin, "https://*.") {
			suffixes = append(suffixes, strings.TrimPrefix(origin, "https://*"))
			continue
		}
		exact = append(exact, origin)
	}
	cfg.AllowOrigins = exact

	if len(suffixes) > 0 {
		cfg.AllowOriginFunc = func(origin string) bool {
			for _, allowed := range exact {
				if origin == allowed {
					return true
				}
			}
			for _, suffix := range suffixes {
				// Require the https:// scheme as well as the suffix, so
				// "https://evil.com/?x=.vercel.app" can't slip through.
				if strings.HasPrefix(origin, "https://") && strings.HasSuffix(origin, suffix) {
					return true
				}
			}
			return false
		}
	}

	return cfg
}

func newRouter(store Store) (*gin.Engine, error) {
	r := gin.Default()

	// Managed hosts (Render, Fly, Vercel) terminate TLS at their edge and pass
	// the real client address in X-Forwarded-For. Trusting it is what makes the
	// auth rate limiter key on the actual caller instead of the proxy.
	if trusted := os.Getenv("TRUSTED_PROXIES"); trusted != "" {
		if trusted == "*" {
			_ = r.SetTrustedProxies(nil)
			r.ForwardedByClientIP = true
		} else if err := r.SetTrustedProxies(strings.Split(trusted, ",")); err != nil {
			return nil, err
		}
	} else {
		// Default: trust nothing, so X-Forwarded-For is ignored and ClientIP
		// is the real socket address.
		if err := r.SetTrustedProxies(nil); err != nil {
			return nil, err
		}
	}

	r.Use(cors.New(corsConfig()))

	tokens, err := newTokenIssuer()
	if err != nil {
		return nil, err
	}

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "Axiom Gateway Online",
			"auth":    "enabled",
			"version": version,
		})
	})

	handler := &authHandler{store: store, tokens: tokens}

	// 20 attempts per 15 minutes per IP across all credential endpoints.
	// Generous enough that a person fumbling a password is never blocked,
	// tight enough that online guessing is impractical.
	limiter := newRateLimiter(20, 15*time.Minute)

	auth := r.Group("/auth")
	{
		auth.POST("/register", limiter.middleware(), handler.register)
		auth.POST("/login", limiter.middleware(), handler.login)
		// Refresh is not rate limited by the credential bucket: a legitimate
		// client refreshes on a timer, and the token itself is unguessable.
		auth.POST("/refresh", handler.refresh)
		auth.POST("/logout", handler.logout)
		auth.GET("/me", requireAuth(tokens), handler.me)
	}

	proxy, err := newMLServiceProxy()
	if err != nil {
		return nil, err
	}

	// A single reverse proxy handles every /api/* route (chat, chat/stream,
	// documents, upload, health) by forwarding to the equivalent path on
	// ml-service. httputil.ReverseProxy transparently supports JSON, multipart
	// uploads, and chunked/SSE streaming, so no route needs bespoke handling.
	//
	// requireAuth guards the whole group: the ML service has no auth of its own
	// and is not exposed publicly, so this is the only thing standing between
	// an anonymous caller and every user's corpus.
	r.Group("/api", requireAuth(tokens)).Any("/*path", func(c *gin.Context) {
		c.Request.URL.Path = c.Param("path")
		proxy.ServeHTTP(c.Writer, c.Request)
	})

	return r, nil
}

// version is overridden at build time with -ldflags "-X main.version=…".
var version = "dev"

// headerGatewayKey proves to the ML service that a request came through this
// gateway. See the matching comment in ml-service/main.py: it is what keeps a
// publicly-routable ML service from accepting a forged X-Axiom-User-Id.
const headerGatewayKey = "X-Axiom-Gateway-Key"

func mlServiceTarget() (*url.URL, error) {
	raw := strings.TrimSpace(os.Getenv("ML_SERVICE_URL"))
	if raw == "" {
		raw = "http://ml-service:8000"
	}
	// Render's blueprint resolves a sibling service to a bare "host:port", which
	// url.Parse reads as a scheme ("host") with an opaque body rather than a
	// hostname — leaving the proxy with nowhere to dial.
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	return url.Parse(raw)
}

func newMLServiceProxy() (*httputil.ReverseProxy, error) {
	target, err := mlServiceTarget()
	if err != nil {
		return nil, err
	}

	sharedSecret := os.Getenv("GATEWAY_SHARED_SECRET")

	proxy := httputil.NewSingleHostReverseProxy(target)

	// Wrap (rather than replace) the director NewSingleHostReverseProxy built,
	// so the standard host/path rewriting still happens.
	baseDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		baseDirector(req)
		if sharedSecret != "" {
			req.Header.Set(headerGatewayKey, sharedSecret)
		}
	}

	// A negative FlushInterval flushes each write to the client immediately,
	// which is required for SSE token streaming to reach the browser without
	// being buffered until the response completes.
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("ML service proxy error: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"ML service unreachable"}`))
	}

	return proxy, nil
}
