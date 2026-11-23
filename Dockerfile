FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY vite.config.mjs ./
COPY src/client ./src/client
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules

COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node --from=builder /app/public/dist ./public/dist

RUN mkdir -p /app/data && chown node:node /app /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_PATH=/app/data/parking_history.db
ENV TZ=Europe/Paris

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
