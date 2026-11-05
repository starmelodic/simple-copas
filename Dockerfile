# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=6000 \
    DATA_DIR=/data \
    LEGACY_PASTES_DIR=none
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
 && apk add --no-cache su-exec \
 && mkdir -p /data && chown app:app /data
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=root:root package.json index.js ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 6000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "index.js"]
