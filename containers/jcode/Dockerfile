ARG SANDBOX_BASE=ghcr.io/totto2727-org/monorepo/sandbox-dev:latest
FROM node:24.19.0-bookworm-slim AS node-runtime
FROM ${SANDBOX_BASE}

# Node's glibc ABI runs on Ubuntu 26.04. The sandbox base supplies gcc's
# libstdc++ and libgcc runtime libraries, so no Node OS image becomes our base.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --chown=sandbox:sandbox dist/server.mjs /opt/flowdeck/server.mjs

USER sandbox
ENV HOME=/sandbox
ENV PATH=/sandbox/.local/bin:/sandbox/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /sandbox/workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/opt/flowdeck/server.mjs"]
CMD []
