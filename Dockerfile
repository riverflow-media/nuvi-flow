FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG APP_UID=1000
ARG APP_GID=1000
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/Squipy411/personal-media-addon
LABEL org.opencontainers.image.title="Personal Media Addon" \
      org.opencontainers.image.description="Private Stremio-compatible personal media server" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.source="$SOURCE_URL"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && groupmod --gid "$APP_GID" node \
  && usermod --uid "$APP_UID" --gid "$APP_GID" node
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=60500 DATABASE_PATH=/app/data/media.db \
    FFPROBE_PATH=/app/node_modules/ffprobe-static/bin/linux/x64/ffprobe
EXPOSE 60500
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:60500/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/index.js"]
