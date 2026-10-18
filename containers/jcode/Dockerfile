ARG SANDBOX_BASE=ghcr.io/totto2727-org/monorepo/sandbox-dev:latest
FROM node:24.19.0-bookworm-slim AS node-runtime
FROM ${SANDBOX_BASE}
ARG JCODE_VERSION=0.98.1

# Node's glibc ABI runs on Ubuntu 26.04. Keep its runtime dependency here,
# rather than adding gateway-specific packages to the generic sandbox base.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --chown=sandbox:sandbox dist/server.mjs /opt/flowdeck/server.mjs

USER sandbox
ENV HOME=/home/sandbox
ENV PATH=/home/sandbox/.local/bin:/home/sandbox/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /home/sandbox/workspace
RUN curl -fsSL https://jcode.sh/install -o /tmp/install-jcode.sh \
    && JCODE_VERSION="${JCODE_VERSION}" JCODE_SKIP_SERVER_RELOAD=1 JCODE_NO_TELEMETRY=1 bash /tmp/install-jcode.sh \
    && jcode --version \
    && rm -f /tmp/install-jcode.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/opt/flowdeck/server.mjs"]
CMD []
