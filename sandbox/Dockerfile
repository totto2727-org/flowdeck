# syntax=docker/dockerfile:1

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1 AS computerd

# Provisioning originally adapted from totto2727-org/monorepo at
# 79e3489d466eb31d3ec96d1d4259de70431e940b. All build inputs are owned here.
FROM ubuntu:26.04 AS nix

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN <<EOF
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gcc make \
  dnsutils iproute2 iptables iputils-ping net-tools netcat-openbsd \
  openssh-sftp-server procps traceroute \
  xz-utils git
rm -rf /var/lib/apt/lists/*

groupadd -r supervisor
useradd -r -g supervisor -s /usr/sbin/nologin supervisor
groupadd -r sandbox
useradd -r -m -g sandbox -d /home/sandbox -s /bin/bash sandbox

mkdir -p /etc/nix /nix
printf 'experimental-features = nix-command flakes\n' > /etc/nix/nix.conf
chown sandbox:sandbox /nix
EOF

USER sandbox
WORKDIR /home/sandbox
ENV HOME=/home/sandbox USER=sandbox
ENV PATH="/home/sandbox/.local/bin:/home/sandbox/.nix-profile/bin:$PATH"

RUN <<EOF
curl -fsSL https://nixos.org/nix/install -o /tmp/install-nix.sh
sh /tmp/install-nix.sh --no-daemon --yes --no-channel-add
nix --version
rm -f /tmp/install-nix.sh
rm -rf /home/sandbox/.cache
EOF

ENTRYPOINT ["/bin/bash"]

FROM nix AS sandbox

COPY --chown=sandbox:sandbox nix /home/sandbox/nix/sandbox

ARG TARGETARCH
RUN <<EOF
case "$TARGETARCH" in
  amd64) NIX_SYSTEM=x86_64-linux ;;
  arm64) NIX_SYSTEM=aarch64-linux ;;
  *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;;
esac

git -C /home/sandbox/nix init
git -C /home/sandbox/nix add .
nix run --inputs-from ~/nix/sandbox home-manager -- switch -b before-home-manager --flake ~/nix/sandbox#sandbox-${NIX_SYSTEM}
home-manager --version

nix-collect-garbage -d
rm -rf /home/sandbox/.cache
EOF

FROM sandbox AS workspace

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o sandbox -g sandbox /workspace

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

USER sandbox
ENV VP_HOME=/home/sandbox/.vite-plus
ENV PATH="/home/sandbox/.vite-plus/bin:$PATH"
RUN curl -fsSL https://vite.plus -o /tmp/install-vp.sh \
 && VP_NODE_MANAGER=yes bash /tmp/install-vp.sh \
 && rm -f /tmp/install-vp.sh \
 && vp --version

ENV PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=auto
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
CMD []
