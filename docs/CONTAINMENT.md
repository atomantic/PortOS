# Containment profiles

PortOS runs code nobody has reviewed: lifecycle scripts and test suites of
freshly bumped packages, verify commands over an agent-edited worktree,
generated SuperCollider and Code Animation source. Each of those runs under a
containment profile — never with the host user's full privileges — and every
profile **refuses** rather than falling back to the host when its mechanism is
unavailable.

| Profile | Mechanism | Platforms | Contract / runner | Used by |
|---------|-----------|-----------|-------------------|---------|
| Code Animation worker | Seatbelt (macOS), bubblewrap + seccomp (Linux); single process, no fork | macOS, Linux | `server/lib/codeAnimationContainment.js` / `server/services/codeAnimation/containedWorker.js` | Code Animation production renders ([CODE_ANIMATION_PACKAGES.md](./CODE_ANIMATION_PACKAGES.md)) |
| Autofix verify (bubblewrap) | bubblewrap namespaces + seccomp (no network, no AF_UNIX, PID namespace) | Linux | `server/lib/autofixVerifyContainment.js` / `autofixer/sandbox.js#runVerifyCommand` | Autofixer verify command — first choice on Linux |
| SuperCollider runtime | Docker, PortOS-built image, `--network none` | Any host with a local Linux Docker engine | `server/lib/superColliderRuntime.js` / `server/services/superColliderRuntime.js` | Music Designer SuperCollider renders ([SUPERCOLLIDER.md](./SUPERCOLLIDER.md)) |
| **Docker containment** | Docker, digest-pinned official Node image, two-phase network | macOS (Docker Desktop), Linux (Docker Engine) | `server/lib/dockerContainment.js` / `server/services/dockerContainment.js` | Autofixer verify when bubblewrap is unavailable (always on macOS; a repo with `package-lock.json` gets a contained `npm ci` first); `scripts/contained-run.js`; the `dependency-updates` scheduled task |

macOS has no bubblewrap and Seatbelt cannot keep a test runner's detached
descendants from outliving the run, so without Docker containment the autofixer
cannot verify — and therefore never promotes — a fix on a Mac.

## Docker containment

Off by default: **Settings › Features › Docker containment**. Turning it on
verifies the engine and creates one shared bridge network; turning it off
cancels live runs and removes every container, network and volume PortOS made.
A fresh install makes no Docker call until the feature is on, and PortOS never
installs, starts or reconfigures Docker. The design record is
[ADR: Docker containment](decisions/2026-10-21-docker-containment.md).

### Engine selection

`server/services/dockerEngine.js` (shared with SuperCollider):

- **CLI** — `PATH`, then `/usr/local/bin`, `/opt/homebrew/bin` and Docker
  Desktop's bundled `Docker.app/Contents/Resources/bin/docker`, so a missing
  `PATH` link after a fresh Docker Desktop install does not read as "no Docker".
- **Engine** — Docker Desktop's `desktop-linux` context when it answers, then
  the active context (Colima, OrbStack, …), then `default` (native `dockerd` at
  `/var/run/docker.sock`). An operator-set `DOCKER_HOST` is the only candidate.
  Every later command pins the chosen endpoint with `--context`/`--host`.
- **Local only** — `unix://` and `npipe://` endpoints. A `tcp://` or `ssh://`
  context is never asked: it would ship a worktree to another machine.
- **Linux containers** are required; Windows hosts are refused in v1.

Status states: `docker-missing`, `docker-stopped`, `docker-unsupported`,
`docker-remote-refused`, `ready`; a run additionally refuses with
`image-missing` (pull it from the feature card) or `unsupported-node`.

### The boundary

Every run container gets: `--rm --pull never --init`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, a read-only root, a non-root user (the host
uid:gid, or `1000:1000`), CPU/memory/PID limits with swap equal to memory, a
2 GiB file-size limit and no core dumps, a tmpfs `HOME` and `/tmp`, and an
environment built from nothing (`CI=1`, `HOME`, npm cache/log paths, and — in
install only — the proxy variables). No host variable, `PORTOS_API_TOKEN` or
provider key reaches it. The Docker socket is never mounted, and
`assertDockerMountSource` refuses any bind source that is an engine socket,
`/run`, the host home or an ancestor of it, a credential store
(`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.npmrc`, `~/.config/gh`,
`~/.portos`, `~/.claude`, `~/.codex`, …), or the PortOS data directory (only
its disposable worktree roots, `cos/worktrees/` and `autofixer/worktrees/`,
may be mounted).

The worktree is mounted **read-only** at `/src` and copied (without
`node_modules` and `.git`) into a per-worktree work volume at `/work`.
`node_modules`, build output and anything a lifecycle script plants live only
there. A trusted in-container driver then writes a unified diff of every
**tracked** file the step changed (a regenerated lockfile) to `/out`; the host
reads it bounded and only applies it when asked (`contained-run.js
--apply-patch`).

### Two phases

- **install** (`npm ci`, `pnpm install --frozen-lockfile`, lockfile
  regeneration): attached only to a per-run `--internal` Docker network whose
  sole other member is a PortOS egress proxy (`server/lib/dockerEgressProxy.js`,
  run from the same pinned image). The proxy allows HTTPS `CONNECT` to
  `registry.npmjs.org`, `registry.yarnpkg.com`, the registry hosts in the
  repository's `.npmrc` (host names only — auth lines are never read), and any
  hosts the operator added in settings (postinstall binary mirrors). It refuses
  IP literals, other ports, plain-HTTP proxying, and an allowlisted name that
  resolves to a loopback, private, link-local, CGNAT/tailnet or other
  non-public address. The proxy and network exist only for that run.
- **validate** (lint, typecheck, test, build): `--network none` — loopback
  only, no route — over the same work volume, so it reuses the install's
  `node_modules`. The npm cache volume is mounted read-only.

A run is serialized per worktree and bounded by a wall-time limit (20 minutes
for install, 30 for validate, configurable). On timeout or cancel the
container is force-removed and its work volume deleted. A boot, toggle-time and
per-run sweep removes stopped containers, networks and volumes a crash left
behind (a running container belongs to another process's run and is bounded by
its own wall limit); idle work volumes expire after 24 hours. Turning the
feature off removes everything, running or not.

### Images

`DOCKER_CONTAINMENT_NODE_IMAGES` pins `node:22`, `node:24` and
`node:26-bookworm-slim` by multi-arch index digest. The major comes from the
repository's `.nvmrc`, `.node-version` or `engines.node` (24 when none). A
major with no pin is refused rather than tested under another runtime; an
operator can add a digest-pinned override per major in settings. Runs use
`--pull never`; pulling is the explicit **Pull image** action on the feature
card. Refresh a pin with `docker buildx imagetools inspect node:<major>-bookworm-slim`.

### Settings

The machine-local `dockerContainment` slice (`PUT /api/settings`, host-control):

```json
{
  "limits": { "cpus": 2, "memoryMb": 4096, "pids": 1024, "wallTimeoutMinutes": 30 },
  "extraEgressHosts": ["github.com", "objects.githubusercontent.com"],
  "imageOverrides": { "20": "node:20-bookworm-slim@sha256:<64 hex>" }
}
```

### Running a step

```bash
node scripts/contained-run.js --phase install -- npm ci
node scripts/contained-run.js --phase validate -- "npm run lint && npm test"
node scripts/contained-run.js --phase install --apply-patch -- npm install --package-lock-only
```

The script resolves the worktree from the current directory and calls
`POST /api/docker-containment/run` with the same credentials as
`scripts/portos-api.js` (a `PORTOS_API_TOKEN` agent session qualifies; the
route is host-control). It exits with the command's status, `2` when refused
(nothing ran), `124` on timeout. The `dependency-updates` scheduled task uses
it when containment is ready and otherwise says in its summary that validation
ran uncontained.

### Limits of the profile

- The container shares the host kernel (Docker Desktop: the VM's kernel); a
  kernel escape is outside this boundary.
- The tracked-file patch is produced inside the container after untrusted code
  ran, so it is advisory input to `git apply`, never trusted output.
- Private registries that need the host user's `~/.npmrc` credentials do not
  work: no host credential is ever mounted.

### Verification

- Unit tests pin the run argv, mount refusals, environment and proxy policy
  (`server/lib/dockerContainment.test.js`, `server/lib/dockerEgressProxy.test.js`,
  `server/services/dockerEngine.test.js`), and the refusal paths of every
  consumer (`autofixer/sandbox.test.js`, `scripts/contained-run.test.js`,
  `server/routes/dockerContainment.test.js`).
- The live suite runs against a real engine:

  ```bash
  cd server && PORTOS_DOCKER_CONTAINMENT_LIVE=1 npx vitest run services/dockerContainment.live.test.js
  ```

  The `docker-containment-live` CI job runs it on an ubuntu runner (native
  Docker Engine) whenever the diff reaches its import closure. CI has no macOS
  Docker, so Docker Desktop on macOS is verified by running the same suite and
  an autofix verify on a Mac.
