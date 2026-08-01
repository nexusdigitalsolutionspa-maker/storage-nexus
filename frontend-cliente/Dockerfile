# ==============================================================================
# STAGE 1: Build the React Application
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json ./
RUN npm install

# Copy source code and assets
COPY . .

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

# Run build
RUN npm run build

# ==============================================================================
# STAGE 2: Serve the built application with Nginx
# ==============================================================================
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy Nginx config for SPA routing
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
