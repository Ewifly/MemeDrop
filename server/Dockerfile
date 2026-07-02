FROM node:20-alpine

# Utilisateur non-root pour ne pas tourner en root dans le conteneur
RUN addgroup -S memedrop && adduser -S memedrop -G memedrop

WORKDIR /app

# Installe les dependances a partir du lockfile pour un build reproductible
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8787
ENV CONFIG_PATH=/data/config.json

# Volume pour persister la config (token bot, salons) entre redeploiements
VOLUME ["/data"]
RUN mkdir -p /data && chown -R memedrop:memedrop /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

USER memedrop

CMD ["node", "server.js"]