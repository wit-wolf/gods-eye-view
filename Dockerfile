# Volo — single-container image for Azure Container Apps (or any OCI runtime).
# Multi-stage: build the Vite client, then run the Node production server.

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app

# Client-embedded keys (build-time). Restrict these in the provider consoles
# (Google: HTTP referrer; Cesium: URL restriction). Never bake server secrets here.
ARG GOOGLE_MAPS_API_KEY=
ARG CESIUM_ION_TOKEN=
ENV GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY \
    CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Non-root user (node image ships uid 1000 "node")
RUN mkdir -p /app/.gev-cache /app/.gev-logs \
  && chown -R node:node /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server/index.js"]
