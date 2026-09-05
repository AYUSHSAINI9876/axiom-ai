# ---- build ----
FROM golang:1.26-alpine AS build

WORKDIR /src

# Copy manifests first so `go mod download` is cached until dependencies change.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=0 produces a static binary that runs on a bare Alpine runtime.
# -trimpath strips local build paths; -s -w drop the symbol/DWARF tables.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/gateway .

# ---- runtime ----
FROM alpine:3.21

# ca-certificates lets the proxy dial HTTPS ML backends (e.g. a hosted
# ml-service) rather than only plaintext in-cluster addresses.
RUN apk add --no-cache ca-certificates \
    && adduser -D -u 10001 axiom

COPY --from=build /out/gateway /usr/local/bin/gateway

USER axiom

ENV PORT=8080
EXPOSE 8080

# wget is provided by busybox in the base image.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["gateway"]
