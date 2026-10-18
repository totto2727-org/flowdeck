# Sandbox image maintenance

This guide serves Flowdeck contributors and maintainers who build or publish workspace images.

## Image ownership

Flowdeck owns these build definitions and image tags:

| Definition                        | Build context                                                    | Output or role                                       |
| --------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `sandbox/nix.Dockerfile`          | `sandbox/`                                                       | `ghcr.io/totto2727-org/flowdeck/nix:latest`          |
| `sandbox/sandbox-base.Dockerfile` | Repository root, filtered by its Dockerfile-specific ignore file | `ghcr.io/totto2727-org/flowdeck/sandbox-base:latest` |
| `nix/sandbox/`                    | Copied into the sandbox base                                     | Locked Home Manager provisioning                     |
| `containers/workspace/Dockerfile` | `containers/workspace/`                                          | Alchemy workspace image with official computerd      |

The workspace Dockerfile uses the Flowdeck sandbox base, not the original monorepo image tag.
It copies `/usr/local/bin/computerd` from the official `ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1` image.
The official image provides the standalone runtime binary, not a general shell environment.
Keep the separate workspace layer for FUSE prerequisites, the runtime entrypoint, and the writable workspace directory.
The generic Nix and sandbox base images do not embed computerd or the Pi agent loop.

## Local builds

Start Docker and install the locked Flowdeck dependencies as described in the [application README](../README.md).
From the repository root, run:

```bash
DOCKER_DEFAULT_PLATFORM=linux/amd64 vp run build:sandbox
vp run dev
```

Use the same Docker daemon for both commands.
The current official computerd source is x64, so this workspace example builds a compatible amd64 base.
The generic build tasks support either Linux architecture and do not hardcode a platform.
An arm64 computerd workspace is not established by these generic-image definitions.

`build:sandbox` depends on `build:nix` in `vite.config.ts`.
The first task creates the Flowdeck Nix image, and the second uses it to create the Flowdeck sandbox base.
Each task uses `cache: false` for Vite+ because its outputs live in the Docker daemon, not in repository files that Vite+ can restore.
Docker's layer cache remains enabled.
Do not add `--no-cache` or disable Docker caching.

Alchemy then builds `containers/workspace/Dockerfile` with `containers/workspace/` as its context.
The repository-root context belongs only to the standalone sandbox-base build.
Do not use it as the Alchemy workspace context, because repository output changes can trigger repeated development rebuilds.

## Remote builds and publication

Local image tags are not published registry images.
Before a remote or production workspace build, an authorized operator must publish the compatible Flowdeck sandbox base to `ghcr.io/totto2727-org/flowdeck/sandbox-base:latest`.
If the sandbox base itself is built in another Docker daemon, provide its Flowdeck Nix base there first, either by building it or by publishing and pulling the matching Nix image.
The configured Vite+ tasks build local images only and do not publish, deploy, or change Cloudflare resources.

`FLOWDECK_WORKSPACE_IMAGE` selects a prepared image that already includes the official computerd runtime and its prerequisites.
It is not the `WORKSPACE_IMAGE` Dockerfile base argument.
See the [sandbox setup guide](../docs/development-sandbox.md) for runtime configuration and acceptance limits.

## Source provenance and retained differences

The copied definitions come from [totto2727-org/monorepo at `79e3489d466eb31d3ec96d1d4259de70431e940b`](https://github.com/totto2727-org/monorepo/tree/79e3489d466eb31d3ec96d1d4259de70431e940b).
This is a partial provisioning copy, not a fork of the complete monorepo.
The original monorepo files and images remain unchanged.

| Area                                           | Flowdeck difference                                                                                | Purpose and operational impact                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `sandbox/nix.Dockerfile`                       | Retains the copied operating-system, user, home, and Nix installation definitions                  | Supplies the independent Flowdeck Nix base with `sandbox` and `/home/sandbox`       |
| `sandbox/sandbox-base.Dockerfile`              | Uses the Flowdeck Nix image and copies only `nix/sandbox/`                                         | Removes the local sibling `nix/share/` build-context dependency                     |
| `sandbox/sandbox-base.Dockerfile.dockerignore` | Includes only the required sandbox provisioning paths                                              | Limits the standalone repository-root build context                                 |
| `nix/sandbox/flake.nix`                        | Uses `github:totto2727-org/monorepo?dir=nix/share/packages` for `local-packages`                   | Retains the upstream packages without a local shared checkout                       |
| `nix/sandbox/flake.nix`                        | Inlines the existing sandbox packages, credential helper, and direnv setting                       | Removes local shared module imports without adding a new tool inventory             |
| `nix/sandbox/flake.lock`                       | Locks the GitHub package input at the source revision while retaining the other copied input locks | Preserves a reproducible source selection for provisioning                          |
| `vite.config.ts`                               | Adds ordered local image-build tasks with Vite+ task caching disabled                              | Recreates Docker daemon outputs while retaining Docker layer caching                |
| `containers/workspace/Dockerfile`              | Uses the independent Flowdeck sandbox base                                                         | Keeps the official computerd runtime source unchanged and the Alchemy context small |

Home Manager activation uses the official `switch -b before-home-manager` option to preserve the initial `.bashrc` and `.profile` files created by user provisioning and the Nix installer.
Without that option, the copied activation command refuses to replace those existing files.
This is a demonstrated activation compatibility fix, not a forced overwrite or a change to the managed package inventory.

The runtime binary remains official computerd 0.5.1.
These changes customize image ownership and dependency provisioning, not upstream computerd runtime source.
When updating the copied definitions, update this exact source revision and the retained-difference table in the same change.
Use the target repository's `nix develop` or a minimal temporary `nix shell` for Node.js and package managers instead of baking them into these images.
