# tabkennel: one logged-in browser for you and your agents
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TABKENNEL_HOME=/data \
    TABKENNEL_BIND=0.0.0.0 \
    TABKENNEL_SANDBOX=false \
    NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && apt-get update \
 && apt-get install -y --no-install-recommends xvfb ffmpeg fonts-liberation fonts-noto-color-emoji fonts-noto-cjk ca-certificates \
 && node node_modules/playwright-core/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache \
 && mkdir -p /data && chown node:node /data

COPY bin ./bin
COPY --from=build /app/dist ./dist

USER node
VOLUME /data
EXPOSE 8083 9230
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8083/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bin/tabkennel.js", "start"]
