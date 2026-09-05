package main

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// rateLimiter is a fixed-window counter keyed by client IP, used to blunt
// password-guessing against the auth endpoints.
//
// In-memory (not Redis) on purpose: it is one more moving part to deploy, and
// a per-instance limit still raises the cost of a brute-force attempt by
// orders of magnitude. The window resets rather than sliding, so a determined
// attacker can burst 2x the limit across a boundary — acceptable for the
// threat this defends against, and noted here so it isn't mistaken for a bug.
type rateLimiter struct {
	mu       sync.Mutex
	hits     map[string]*window
	limit    int
	interval time.Duration
}

type window struct {
	count   int
	resetAt time.Time
}

func newRateLimiter(limit int, interval time.Duration) *rateLimiter {
	rl := &rateLimiter{
		hits:     make(map[string]*window),
		limit:    limit,
		interval: interval,
	}
	go rl.reap()
	return rl
}

// reap drops expired windows so the map doesn't grow once per unique client IP
// for the lifetime of the process.
func (rl *rateLimiter) reap() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		rl.mu.Lock()
		for key, w := range rl.hits {
			if now.After(w.resetAt) {
				delete(rl.hits, key)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *rateLimiter) allow(key string) (bool, time.Duration) {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	w, ok := rl.hits[key]
	if !ok || now.After(w.resetAt) {
		rl.hits[key] = &window{count: 1, resetAt: now.Add(rl.interval)}
		return true, 0
	}

	w.count++
	if w.count > rl.limit {
		return false, time.Until(w.resetAt)
	}
	return true, 0
}

func (rl *rateLimiter) middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// gin's ClientIP honours X-Forwarded-For only for trusted proxies,
		// which main.go configures — otherwise any client could spoof the
		// header and get a fresh bucket per request.
		ok, retryAfter := rl.allow(c.ClientIP())
		if !ok {
			c.Header("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "too many attempts — please wait a moment and try again",
			})
			return
		}
		c.Next()
	}
}
