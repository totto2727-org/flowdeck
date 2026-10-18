# syntax=docker/dockerfile:1

# Copied from totto2727-org/monorepo at 79e3489d466eb31d3ec96d1d4259de70431e940b (sandbox/sandbox-base.Dockerfile).
ARG NIX_IMAGE=ghcr.io/totto2727-org/flowdeck/nix:latest
FROM ${NIX_IMAGE}

COPY --chown=sandbox:sandbox nix/sandbox /home/sandbox/nix/sandbox

ARG TARGETARCH
RUN <<EOF
case "$TARGETARCH" in
  amd64) NIX_SYSTEM=x86_64-linux ;;
  arm64) NIX_SYSTEM=aarch64-linux ;;
  *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;;
esac

git -C /home/sandbox/nix init
git -C /home/sandbox/nix add .
nix run --inputs-from ~/nix/sandbox home-manager -- switch --flake ~/nix/sandbox#sandbox-${NIX_SYSTEM}
home-manager --version

nix-collect-garbage -d
rm -rf /home/sandbox/.cache
EOF

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

ENTRYPOINT ["/bin/bash"]
