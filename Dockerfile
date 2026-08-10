# Build stage
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS build
WORKDIR /app

# Version from release tag (passed via --build-arg)
ARG APP_VERSION=dev

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci
COPY . .

# Build frontend and server (pass version to Vite)
ENV APP_VERSION=${APP_VERSION}
RUN npm run build
RUN npm run build:server

# Litestream binary for continuous SQLite replication (multi-arch manifest)
FROM litestream/litestream:0.3.13@sha256:027eda2a89a86015b9797d2129d4dd447e8953097b4190e1d5a30b73e76d8d58 AS litestream

# Production
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Copy built frontend
COPY --from=build /app/dist ./dist

# Copy compiled server files (JS, not TS)
COPY --from=build /app/dist-server ./dist-server

# Install production dependencies with build tools in a single layer, then remove
# Also install su-exec for privilege dropping in entrypoint
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && apk add --no-cache su-exec

# Create data directory for SQLite and set ownership
RUN mkdir -p /app/data && chown -R node:node /app/data

# Copy entrypoint script
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Litestream: binary and config; replication only activates when
# LITESTREAM_BUCKET is set (see docker/entrypoint.sh and docs/backup.md)
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
# COPY preserves the source file mode; force world-readable so the 'node'
# user can load the config after privileges are dropped
COPY --chmod=644 docker/litestream.yml /etc/litestream.yml

# Environment variables
ENV NODE_ENV=production
ENV PORT=3080
ENV DATA_DIR=/app/data

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3080) + '/api/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/index.js"]
