# Multi-stage: Build TS + Caddy with auto HTTPS
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm ci && npx tsc

# Runtime with Caddy for TLS termination
FROM caddy:2-alpine
WORKDIR /app

# Copy Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

# Copy node app
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --omit=dev && npm i -g pm2@5.3.0

# Expose both ports
EXPOSE 8080 443
ENV PORT=8080

# Start Caddy (auto TLS) + Node app
CMD caddy run --config /etc/caddy/Caddyfile &
pm2-runtime dist/index.js