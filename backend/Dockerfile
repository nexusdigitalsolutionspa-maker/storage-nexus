# ==============================================================================
# STAGE 1: Build the static Go binary
# ==============================================================================
FROM golang:1.21 AS builder

WORKDIR /app

# Copy source code
COPY . .

# Resolve and download all dependencies dynamically (print logs on error)
RUN go mod tidy > /tmp/tidy.log 2>&1 || (cat /tmp/tidy.log && exit 1)

# Build the binary statically
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o main ./cmd/api/main.go

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
