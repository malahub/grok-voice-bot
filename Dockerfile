# Multi-stage build: compile TypeScript, run slim Node runtime.
# TLS is terminated by Coolify's Traefik proxy at the edge, so the app
# only needs to serve plain HTTP on PORT (8080).
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm ci && npx tsc

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/index.js"]