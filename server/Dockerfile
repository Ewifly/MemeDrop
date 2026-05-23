FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]
ENV CONFIG_PATH=/data/config.json
CMD ["node", "server.js"]
