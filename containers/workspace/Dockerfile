ARG WORKSPACE_IMAGE=ghcr.io/totto2727-org/monorepo/sandbox-dev:latest
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1 AS computerd
FROM node:24.19.0-bookworm-slim AS node-runtime

FROM ${WORKSPACE_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY --from=node-runtime /usr/local /usr/local
RUN corepack enable pnpm
ENV HOME=/home/sandbox
ENV PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=auto
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
CMD []
