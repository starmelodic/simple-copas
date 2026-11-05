# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.*json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=6000 \
    DATA_DIR=/data
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json index.js ./
COPY src ./src
COPY public ./public
USER app
VOLUME ["/data"]
EXPOSE 6000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:6000/api/health || exit 1
CMD ["node", "index.js"]
