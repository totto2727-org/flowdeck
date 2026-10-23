# Sandbox image maintenance

This guide serves Flowdeck contributors and maintainers who build workspace images.

## Image stages

Flowdeck owns one image definition, `sandbox/Dockerfile`, and its standalone Nix configuration under `sandbox/nix/`.
All builds use `sandbox/` as the build context.

| Stage       | Base                                                    | Role                                                           | Local image tag                                      |
| ----------- | ------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `computerd` | `ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1` | Source of the official binary                                  | None                                                 |
| `nix`       | `ubuntu:26.04`                                          | Operating system, sandbox user, and Nix installation           | `ghcr.io/totto2727-org/flowdeck/nix:latest`          |
| `sandbox`   | `nix`                                                   | Home Manager and repository tools from `sandbox/nix/`          | `ghcr.io/totto2727-org/flowdeck/sandbox-base:latest` |
| `workspace` | `sandbox`                                               | FUSE prerequisites, writable workspace, and official computerd | Built by Alchemy                                     |

The final workspace uses Ubuntu 26.04 through its provisioning stages.
It copies only `/usr/local/bin/computerd` from the official image, not an operating-system filesystem into the official scratch image.
Ubuntu supplies the shell and libraries, and the provisioning stages supply the user database, Nix store, and Home Manager profile.
The final stage runs official computerd as `sandbox`, with `HOME=/home/sandbox`, the inherited profile `PATH`, and port 8080.
Keep the official runtime entrypoint and the writable `/workspace` directory.
The image does not contain a Pi agent loop or inference credentials.
The generic `nix` and `sandbox` targets do not contain computerd.

## Local builds

Start Docker and install the locked Flowdeck dependencies as described in the [application README](../README.md).
Start local Pi development from the repository root:

```bash
DOCKER_DEFAULT_PLATFORM=linux/amd64 vp run dev
```

Alchemy builds the final `workspace` stage, including its Nix and Home Manager stages.
No separate Flowdeck base image build or publication is required.
The current official computerd binary is x64, so the final workspace requires Linux amd64.

To build intermediate images without starting Alchemy, use these optional tasks:

```bash
vp run build:nix
vp run build:sandbox
```

`build:nix` uses `--target nix`, and `build:sandbox` uses `--target sandbox` in the same Dockerfile.
The sandbox target includes the Nix stage and does not pull the locally tagged Flowdeck Nix image.
These tasks are architecture-neutral; set `DOCKER_DEFAULT_PLATFORM=linux/amd64` for amd64 intermediate images on an ARM64 host.
Both targets support Linux amd64 and arm64, but an arm64 intermediate image does not establish an arm64 computerd workspace.
Each task uses `cache: false` for Vite+ because its outputs live in the Docker daemon, not in cache-restorable repository files.
Docker's layer cache remains enabled.
Do not add `--no-cache` or disable Docker caching.

All image stages and sandbox Nix configuration live under `sandbox/`.
Do not use the repository root as Alchemy's context, because repository output changes can trigger repeated development rebuilds.

## Remote builds and prepared images

A remote builder can build the complete workspace from `sandbox/Dockerfile` and the `sandbox/` context.
It does not need published Flowdeck Nix or sandbox base images.
It still needs access to the declared upstream images and Nix dependencies.
The configured Vite+ tasks build local images only and do not publish, deploy, or change Cloudflare resources.

`FLOWDECK_WORKSPACE_IMAGE` selects a prepared image that already includes the official computerd runtime, shell, and FUSE prerequisites.
There is no `WORKSPACE_IMAGE` Dockerfile base argument.
Publishing a prepared image or deploying it requires operator authorization.
See the [sandbox setup guide](../docs/development-sandbox.md) for runtime configuration and acceptance limits.

## Source provenance and retained differences

The provisioning was adapted from [totto2727-org/monorepo at `79e3489d466eb31d3ec96d1d4259de70431e940b`](https://github.com/totto2727-org/monorepo/tree/79e3489d466eb31d3ec96d1d4259de70431e940b).
This is a partial provisioning copy, not a fork of the complete monorepo.
The original monorepo files and images remain unchanged.

| Area                              | Flowdeck difference                                                                         | Purpose and operational impact                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `sandbox/Dockerfile`              | Combines Ubuntu/Nix, Home Manager, and workspace stages in one definition                   | Removes dependencies on separately built Flowdeck base images               |
| `sandbox/Dockerfile.dockerignore` | Limits the context to required build inputs                                                 | Keeps application output out of image rebuild inputs                        |
| `sandbox/nix/flake.nix`           | Declares nixpkgs, Home Manager, and bun2nix inputs directly, with local package definitions | Removes monorepo flake inputs and sibling imports                           |
| `sandbox/nix/packages/`           | Owns Monid and oo derivations and frozen Bun dependency definitions                         | Preserves the existing tool inventory without a monorepo overlay            |
| `sandbox/nix/flake.nix`           | Contains the sandbox packages, credential helper, and direnv setting                        | Removes shared module imports without adding a new tool inventory           |
| `sandbox/nix/flake.lock`          | Locks direct inputs without a monorepo node                                                 | Keeps independent provisioning with pinned third-party revisions            |
| `vite.config.ts`                  | Builds the `nix` and `sandbox` targets with Vite+ task caching disabled                     | Recreates Docker daemon outputs while retaining Docker layer caching        |
| `sandbox/Dockerfile`              | Copies official computerd 0.5.1 into the Ubuntu workspace                                   | Supplies the official runtime with an OS shell, Nix, and FUSE prerequisites |

Home Manager activation uses `switch -b before-home-manager` to preserve the initial `.bashrc` and `.profile` files.
Without that option, activation refuses to replace those existing files.
The runtime binary remains official computerd 0.5.1; upstream runtime source is unchanged.
These changes customize image construction and dependency provisioning.
When updating the copied provisioning, update the exact source revision and retained-difference table in the same change.
Use the target repository's `nix develop` or a minimal temporary `nix shell` for Node.js and package managers instead of baking them into these images.

## Validation limits

The standalone Linux arm64 sandbox build and Home Manager smoke check passed with the independent Nix configuration.
This result validates provisioning on that architecture, not the final x64 workspace.
The local amd64 build failed while extracting the Nix installer archive with `ENOSYS` under emulation.
The final amd64 workspace build and its official Workspace exec/FUSE behavior therefore remain unverified.
Do not transfer the arm64 provisioning result, earlier image checks, or application CI results into a claim of final workspace acceptance.
