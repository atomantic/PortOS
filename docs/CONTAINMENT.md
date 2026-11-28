# Containment profiles

PortOS contains generated code, dependency lifecycle scripts and Autofixer
verification. Profiles refuse when the required boundary is unavailable.

| Work | Boundary |
| --- | --- |
| Code Animation | Single-process Seatbelt on macOS or bubblewrap and seccomp on Linux |
| Autofixer verification on Linux | Bubblewrap, PID namespace and seccomp with network and Unix-domain sockets denied |
| [SuperCollider](SUPERCOLLIDER.md) | PortOS-built Docker image with no network |
| Dependency validation, `contained-run` and Autofixer Docker verification | Local Linux Docker engine with a pinned Node image and phased network policy |

Autofixer uses Docker when bubblewrap is unavailable. macOS requires Docker
for Autofixer verification and promotion. See the
[Docker containment decision](decisions/2026-10-21-docker-containment.md).

## Enable and diagnose Docker containment

Turn on **Settings → Features → Docker containment**. Enabling verifies
the engine. Disabling cancels runs and removes PortOS-owned containers,
networks and volumes. PortOS leaves Docker installation and startup to the
operator.

The shared engine resolver finds Docker in PATH and standard Desktop
locations. It tries Desktop's `desktop-linux` context, the active context,
then default. An explicit `DOCKER_HOST` becomes the only candidate. Only
local Unix sockets and named pipes qualify. A remote endpoint could send a
worktree to another machine and is refused. Use a local engine in Linux
container mode on macOS or Linux.

The feature card reports missing, stopped, unsupported or remote engines.
Use **Pull image** for `image-missing`. The app selects a digest-pinned
Node 22, 24 or 26 image from repository declarations (24 by default).
An unsupported major needs a digest-pinned `imageOverrides` entry under
the machine-local `dockerContainment` settings. The same settings hold
`limits` and `extraEgressHosts`.

## Run a step

```bash
node scripts/contained-run.js --phase install -- npm ci
node scripts/contained-run.js --phase validate -- "npm run lint && npm test"
node scripts/contained-run.js --phase install --apply-patch -- npm install --package-lock-only
```

Run from the intended worktree. The command uses PortOS host-control
credentials and exits with the step status, 2 for refusal or 124 on timeout.
The dependency-update task reports any validation it performs outside this
profile.

The container copies a read-only source mount into a private work volume.
Install can reach public registry HTTPS hosts through a per-run proxy.
Hostnames allowed by project npm configuration and operator settings can
extend that list, while private addresses and host credentials stay out.
Validate runs with no network and a read-only npm cache. A non-root user,
read-only root, limits and private HOME and temp directories bound both
phases. Host credentials, the Docker socket and sensitive host mounts
are excluded. The profile shares the engine's kernel.

Steps are serialized per worktree. Default limits are 20 minutes for
install and 30 for validate. Timeout and cancellation remove the container
and work volume. A maintenance sweep removes abandoned resources. Treat
the exported patch as untrusted. Applying requires `--apply-patch` and
only lockfile hunks qualify.

## Verification

The live suite exercises a local Docker engine and is required on relevant
Linux CI changes. Use it on macOS with Docker Desktop for platform evidence.

```bash
cd server && PORTOS_DOCKER_CONTAINMENT_LIVE=1 npx vitest run --configLoader native services/dockerContainment.live.test.js
```
