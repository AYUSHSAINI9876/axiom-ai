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
	r, err := newRouter()
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

func newRouter() (*gin.Engine, error) {
	r := gin.Default()

	r.Use(cors.New(cors.Config{
		AllowOrigins:     allowedOrigins(),
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "Axiom Gateway Online"})
	})

	proxy, err := newMLServiceProxy()
	if err != nil {
		return nil, err
	}

	// A single reverse proxy handles every /api/* route (chat, chat/stream,
	// documents, upload, health) by forwarding to the equivalent path on
	// ml-service. httputil.ReverseProxy transparently supports JSON, multipart
	// uploads, and chunked/SSE streaming, so no route needs bespoke handling.
	r.Any("/api/*path", func(c *gin.Context) {
		c.Request.URL.Path = c.Param("path")
		proxy.ServeHTTP(c.Writer, c.Request)
	})

	return r, nil
}

func newMLServiceProxy() (*httputil.ReverseProxy, error) {
	mlServiceURL := os.Getenv("ML_SERVICE_URL")
	if mlServiceURL == "" {
		mlServiceURL = "http://ml-service:8000"
	}

	target, err := url.Parse(mlServiceURL)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	// A negative FlushInterval flushes each write to the client immediately,
	// which is required for SSE token streaming to reach the browser without
	// being buffered until the response completes.
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("ML service proxy error: %v", err)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"ML service unreachable"}`))
	}

	return proxy, nil
}
