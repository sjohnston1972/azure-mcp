# Multi-stage: install + build with full deps, run with prod-only deps.

# ── build stage ────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
# Install deps based on lockfile if present; falls back to a fresh
# install when the lockfile hasn't been generated yet (first build).
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ──────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# docker-cli lets us spawn `docker run -i --rm mcr.microsoft.com/.../azure-mcp`
# as a child process and talk to it over stdio. The host's docker.sock
# is mounted in via compose. See DECISIONS.md "Azure MCP transport".
RUN apk add --no-cache docker-cli
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
