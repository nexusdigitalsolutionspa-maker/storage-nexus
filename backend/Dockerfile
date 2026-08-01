# ==============================================================================
# Run the precompiled Go binary in a lightweight Alpine container
# ==============================================================================
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata curl

WORKDIR /app

# Copy the precompiled Linux binary from context
COPY main .

# Ensure execution permissions
RUN chmod +x main

# Copy resources if needed (e.g. logo for email template)
COPY logo.png ./logo.png

EXPOSE 8080

CMD ["./main"]
