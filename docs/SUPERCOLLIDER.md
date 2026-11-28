# SuperCollider runtime

Music Designer renders SuperCollider code offline inside a disposable Docker
container. Start a local Linux-container engine on amd64 or arm64
(Docker Desktop or Docker Engine). PortOS leaves Docker setup to the operator.
The first build is from source and can take 10–30 minutes. The image and
compiler-layer cache require extra disk space.

## Set up or repair

Choose **Set up SuperCollider** in Music Designer, or use the CLI:

```sh
npm run setup:supercollider -- --status --json
npm run setup:supercollider -- --yes
npm run setup:supercollider -- --yes --rebuild
```

Status alone reads cached evidence. Setup builds a missing or stale image
and probes it with a synthetic stock-UGen render. Repeating setup with the
same image and policy reuses a current passing probe. Setup never runs at
boot. Omit `--yes` to require interactive approval before a build. A failure
prints the bounded build-log tail. Use `--verbose` to capture full progress.

| Readiness | Action |
| --- | --- |
| `docker-missing`, `docker-stopped`, `docker-unsupported` | Install or start a supported engine, then check again |
| `image-missing`, `image-stale`, `unverified` | Run setup |
| `smoke-failed` | Check `smoke.error` and try a rebuild |
| `ready` | The local image and policy match a passing decoded WAV probe |

CLI codes are 0 for success or a status read, 1 for unexpected errors,
2 for an unavailable engine, 3 for declined build, 4 for build failure
and 5 for a failed probe. Evidence is machine-local at
`data/supercollider/runtime-evidence.json`. Setup recreates it after
deletion. If fetching Debian packages fails transiently, retry setup
after confirming the failing registry. Docker retains completed layers.
A source checksum mismatch stops the build.

## Render and save

1. Pick **SuperCollider** in the Music Designer Code engine and enter
   or generate the source. Its last expression must be a pattern such
   as `Pbind` or `Ppar`.
2. Select 4–120 whole seconds and choose **Render preview**. Track
   progress or cancel from the media queue. The wrapper seeds the
   interpreter, scores at 120 BPM and renders 48 kHz stereo.
3. Choose **Save as take** while source and preview still match.
   Previews expire after 24 hours. A render alone leaves the track
   unchanged. Saving keeps the exact source, hash, seed, runtime,
   policy and render settings as provenance. Compare deterministic
   renders only on the same tested runtime and platform.

For API clients, the [HTTP inventory](API.md) describes
`/api/music/supercollider` status, setup, render, SSE, cancel and audio routes.
The take endpoint, `POST /api/tracks/:id/supercollider/take`, accepts the
preview job ID. Audio and provenance come from the server's verified preview.
Render errors use `SUPERCOLLIDER_*` codes. Check the compiler line and
character for syntax errors, the last returned value for pattern errors,
and the output duration, levels and format for invalid output.

## Boundary and image maintenance

Probe and production renders use the same policy in
`server/lib/superColliderRuntime.js`. Each container runs non-root with
no network, credentials or Docker socket. The root and input mount
are read-only. Output is private to the job, bounded and checked for
regular files and valid decoded audio. Cancellation and timeout force
container removal. An unavailable engine or image refuses the render.

The [recipe and notices](../docker/supercollider/) pin the upstream source,
Debian image and signed snapshot indices. For a base update verify the image
digest and snapshot timestamps, check Debian advisories, verify each
`InRelease` with a trusted Debian archive keyring and refresh
`debian-inrelease.sha256`, tests and notice together. Bump
`SUPERCOLLIDER_RUNTIME_VERSION` when changing a pin. The image-security
workflow produces the SBOM and vulnerability scan. See [GitHub Actions](GITHUB_ACTIONS.md#runtime-image-security-runtime-image-securityyml).

Run the opt-in live boundary suite after setup. CI runs it on native
amd64 and arm64 Linux engines. Verify Docker Desktop on the intended host.

```sh
cd server && PORTOS_SUPERCOLLIDER_LIVE=1 npx vitest run --configLoader native services/superColliderRender.live.test.js
```
