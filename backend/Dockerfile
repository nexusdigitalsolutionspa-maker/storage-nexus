# ==============================================================================
# STAGE 1: Build the static Go binary
# ==============================================================================
FROM golang:1.25 AS builder

WORKDIR /app

# Copy dependency definitions and download them first (cached layer)
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the binary statically with memory limits (GOGC and GOMAXPROCS) to prevent VPS OOM crashes
RUN GOGC=20 GOMAXPROCS=1 CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o main ./cmd/api/main.go > /tmp/build.log 2>&1 || (cat /tmp/build.log >&2 && exit 1)

# ==============================================================================
# STAGE 2: Run the binary in a lightweight Alpine container
# ==============================================================================
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata curl

WORKDIR /app

# Copy the binary from the builder
COPY --from=builder /app/main .

# Copy resources if needed (e.g. logo for email template)
COPY logo.png ./logo.png

EXPOSE 8080

CMD ["./main"]
