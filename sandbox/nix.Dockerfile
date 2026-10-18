# syntax=docker/dockerfile:1

# Copied from totto2727-org/monorepo at 79e3489d466eb31d3ec96d1d4259de70431e940b (sandbox/nix.Dockerfile).
# Base
# https://github.com/NVIDIA/OpenShell-Community/blob/6daeacdf199afdd49753ddd149a9c259921ab1a8/sandboxes/base/Dockerfile

FROM ubuntu:26.04

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
