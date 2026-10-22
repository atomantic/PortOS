# ADR: Docker containment for untrusted install and test runs

**Date:** 2026-10-21
**Status:** Accepted

## Question

Dependency installs, test suites over freshly bumped packages, and autofix
verify commands execute code nobody has reviewed. On Linux the autofixer's
verify runs under bubblewrap; on macOS nothing can contain a forking test
runner, so autofix verification is refused and no fix is promoted there, and
the `dependency-updates` task runs installs with the host user's privileges
everywhere. How should PortOS contain those runs on macOS and Linux alike?

## Decision

Add an opt-in **Docker containment** profile (#12844) that runs each step in a
throwaway Linux container from a digest-pinned official Node image, inheriting
the Docker rules of the [SuperCollider ADR](2026-10-01-supercollider-code-audio.md):
PortOS never installs or reconfigures Docker, untrusted code gets no native
fallback, no capabilities, no Docker socket, a read-only root, CPU/memory/PID/
wall budgets, an explicit environment, and kill-and-remove on timeout or
cancel. The full contract is [CONTAINMENT.md](../CONTAINMENT.md).

1. **Endpoint policy.** Only local engines (`unix://`, `npipe://`). Docker
   Desktop is preferred when it answers, then the active context, then native
   Docker Engine; the run is pinned to the chosen endpoint. A `tcp://` or
   `ssh://` endpoint is refused (`docker-remote-refused`) and never asked —
   it would copy a worktree to another machine.
2. **Two-phase network model.** `validate` has `--network none`. `install` is
   attached only to a per-run `--internal` network shared with a per-run
   egress proxy that allows HTTPS `CONNECT` to an allowlist of registry host
   names and refuses any name resolving to a non-public address. The proxy is
   per run, not a shared daemon, so a repository's `.npmrc` registries widen
   only its own run and nothing listens between runs.
3. **Source handling.** The worktree is read-only; work happens in a Docker
   volume; results return as a bounded tracked-file patch that the trusted
   host side applies only on request.
4. **No fallback.** When the engine, image or feature is not ready, every
   consumer refuses with the resolver's reason (`CONTAINMENT_UNAVAILABLE`).
   The autofixer keeps blocking promotion; `contained-run.js` exits 2; the
   `dependency-updates` prompt says the run was uncontained when it proceeds
   on the host (adoption is opt-in, not enforced).
5. **Off by default, reconciled at toggle time.** The feature has no detector;
   a fresh install makes no Docker call until it is enabled. Turning it on or
   off reconciles the shared network and sweeps orphans without a restart.
   Images are pulled only by an explicit operator action.

## Alternatives considered

- **Seatbelt for the macOS verify.** Rejected: it cannot stop a verifier's
  detached descendants from outliving completion or timeout (the reason the
  macOS probe refuses today).
- **A long-lived shared egress proxy created at toggle time.** Rejected in
  favor of a per-run proxy: a shared one needs a mutable, cross-run allowlist
  (per-repo `.npmrc` hosts) and keeps a listener up between runs.
- **`--network bridge` with host firewall rules.** Rejected: PortOS would have
  to reconfigure the host or Docker, and Docker Desktop's VM networking differs
  from native Docker Engine.
- **Running the whole CoS agent CLI in a container.** Out of scope: this
  decision contains the code agents execute, not the agents.

## Consequences

- macOS autofix verification and promotion work when Docker Desktop is running
  and the feature is on; Linux keeps bubblewrap as its first choice.
- Private registries needing the host user's credentials are not reachable
  from an install container.
- A kernel escape is outside the boundary (shared host or VM kernel).
- The `docker-containment-live` CI job proves the boundary on native Docker
  Engine; Docker Desktop on macOS is verified manually.
