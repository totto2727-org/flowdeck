ARG SANDBOX_BASE=ghcr.io/totto2727-org/monorepo/sandbox-dev:latest
FROM node:24.19.0-bookworm-slim AS node-runtime

FROM node-runtime AS dependencies
WORKDIR /opt/flowdeck
COPY dist/package.json dist/pnpm-lock.yaml dist/pnpm-workspace.yaml ./
RUN corepack pnpm install --prod --frozen-lockfile

FROM ${SANDBOX_BASE}

USER root
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies --chown=sandbox:sandbox /opt/flowdeck/node_modules /opt/flowdeck/node_modules
COPY --chown=sandbox:sandbox dist/server.mjs /opt/flowdeck/server.mjs
USER sandbox
ENV HOME=/home/sandbox
ENV PATH=/home/sandbox/.local/bin:/home/sandbox/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /home/sandbox/workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/opt/flowdeck/server.mjs"]
CMD []
