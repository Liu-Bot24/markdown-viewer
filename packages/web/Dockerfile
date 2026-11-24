# MD Viewer Web. Build from the repository root:
#   docker build -f packages/web/Dockerfile -t mdview-web .
# Only the core and web packages go in; the Electron binary of the Windows edition is never downloaded.
#
# The base image is the official Node image. By default it comes from the AWS ECR Public
# mirror of Docker's official images; to pull it from Docker Hub instead:
#   docker build --build-arg NODE_IMAGE=node:22-bookworm-slim ...
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace @mdv/web --workspace @mdv/core --include-workspace-root
COPY packages/core packages/core
COPY packages/web packages/web
COPY assets/icon.png assets/icon.png
RUN node packages/web/scripts/build.mjs && rm -f packages/web/dist/public/*.map packages/web/dist/public/chunks/*.map

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --workspace @mdv/web && npm cache clean --force

FROM ${NODE_IMAGE}
# ffmpeg and the Intel media driver: on-demand H.264 transcoding (Quick Sync / VAAPI when
# /dev/dri is passed in, software otherwise) for videos the browser cannot play.
# The Intel driver exists only for x86-64; other architectures transcode in software.
ARG TARGETARCH
RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini $([ "${TARGETARCH:-amd64}" = amd64 ] && echo intel-media-va-driver-non-free) \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/core/src/shared packages/core/src/shared
COPY packages/core/src/node packages/core/src/node
COPY packages/web/package.json packages/web/package.json
COPY packages/web/src/server packages/web/src/server
COPY packages/web/src/search packages/web/src/search
COPY --from=build /src/packages/web/dist/public packages/web/dist/public
RUN mkdir -p /roots /state /cache && chown node:node /state /cache
ENV NODE_ENV=production MDV_PORT=8080 LIBVA_DRIVER_NAME=iHD
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.MDV_PORT||8080)+'/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/web/src/server/main.js"]
