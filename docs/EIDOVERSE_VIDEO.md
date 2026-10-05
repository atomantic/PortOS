# Eidoverse Video in Music Video Studio

Choose **Compose → Render style → Eidoverse Video** to render an authored
[Eidoverse Video](https://github.com/anima-research/eidoverse-video) scene over
an analyzed master song. This is a separate renderer from Code Animation,
HTML composition documents and video-generation models. No provider call runs
when selecting or saving it. Existing projects retain their chosen renderer.

## Optional runtime setup

Eidoverse remains a separate AGPL-3.0 checkout and container image. PortOS does
not vendor its engine or install it on startup. The Worlds feature toggle and
Worlds server are not required. Read upstream's license, asset licenses and
setup requirements before building. These commands are explicit operator setup,
not commands PortOS runs on a render request:

1. Obtain the upstream `auto` branch in an independent checkout, following its
   setup documentation. Build its render-only base image there:

   ```sh
   docker build -f docker/Dockerfile --build-arg AGENT=none -t eidoverse:render docker
   ```

2. Build the PortOS adapter image with that checkout as context. Replace the
   placeholders with the two checkout locations:

   ```sh
   docker build -f <portos-root>/docker/eidoverse-video/Dockerfile \
     -t portos-eidoverse-video:1 <eidoverse-video-root>
   ```

Docker must be running on the PortOS host. The adapter uses Mesa software
WebGPU and libx264 for a portable baseline; it does not request host GPU devices.
Software rendering can be slow. The image contains the engine, bundled assets
and cached dependencies; render jobs never download dependencies or pull images.
A missing image or unavailable Docker engine produces an actionable preflight
error before a job is marked rendering. Image discovery is not a render-readiness
or visual-quality verdict: validate a real draft on the target host.

## Authoring and review

Use the upstream scene API to author a JSON object with `inlineScript` and an
optional `assets` map. Paste it into **Scene JSON** and save it. Asset values
must name bundled `eidoverse/assets/` files, without parent traversal or URLs.
PortOS supplies width/height from the project's aspect ratio, 24 fps, the analyzed
song duration rounded to a frame, and the output location. Other JSON fields are
rejected rather than silently overriding the project.

Render a draft in **Review & Export**. Eidoverse simulations start at zero;
draft rendering runs the scene's full song timeline and then trims the requested
window, including the corresponding master-song offset. This preserves the same
simulation state in the proof and final film. The existing art/storyboard/proof
review requirements still apply to final rendering. Asset autopilot does not
queue scene media for this mode; author the scene in Compose.

Scene changes invalidate the existing proof through the normal composition
review basis. The scene source and bundled asset references can sync to another
user-controlled install; the optional runtime image is machine-local. Schema
version 20 prevents older peers from dropping the new render mode/source.

The container runs without network, capabilities, host credentials or PortOS
API access. Its root filesystem and input are read-only. Only the private job
output directory and bounded temporary space are writable. PortOS bounds time,
CPU, memory and process count, removes the container on cancel/failure, validates
its output, and muxes the master song outside the scene runtime. No uncontained
host execution fallback is provided. Typography and grading controls for HTML
compositions do not apply to this renderer; author those visuals in the scene.

## Opt-in real acceptance (#9798)

`scripts/eidoverse-acceptance.js` is a standalone synthetic acceptance harness.
It calls production `prepareEidoverseRender` and `encodeEidoverseComposition`;
Docker, ffmpeg, ffprobe and the renderer are never mocked. It requires a native
Linux x86_64 host, a local Unix-socket Docker daemon, **8 GiB MemAvailable** and
**60 GiB free on the Docker-root filesystem** before any build. An inaccessible
or inadequate prerequisite records `unavailable`, leaves runtime criteria
`not-run` and exits 2. Preflight success alone is not acceptance.

The manual-only `.github/workflows/eidoverse-acceptance.yml` is a candidate
free CI route using standard public-repository `ubuntu-24.04`. GitHub documents
only [14 GB storage for that runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
so it is **not yet a verified suitable execution host**. The workflow measures
actual Docker-root space and fails unavailable when short. It never lowers the
threshold, installs Docker, deletes runner software, changes OS/security settings,
uses paid runners, publishes images, or saves dependency/build caches.
It is not dispatched by pushes or pull requests. GitHub requires a manual
workflow to exist on the default branch before it can be dispatched; a draft PR
containing this new workflow alone cannot supply a real acceptance run.

Before opting in, review the independent upstream checkout at
`959a95c3d3963c334422d170317062e00936c573`, its
[AGPL license](https://github.com/anima-research/eidoverse-video/blob/959a95c3d3963c334422d170317062e00936c573/LICENSE),
[setup](https://github.com/anima-research/eidoverse-video/blob/959a95c3d3963c334422d170317062e00936c573/docs/SETUP.md)
and [Dockerfile](https://github.com/anima-research/eidoverse-video/blob/959a95c3d3963c334422d170317062e00936c573/docker/Dockerfile).
The base fetches GPL ffmpeg, OFL fonts, MIT SeedThree, Python/audio packages and
Chrome, even with `AGENT=none`; no agent credentials or external rendering service
are needed. The source commit is pinned, but `ubuntu:rolling` and several package
downloads remain mutable. A passing run records the exact resulting image IDs
and PortOS commit, not a claim of bit-for-bit reproducible image builds. The
workflow's `reviewed_source` input defaults to false and must be explicitly set
after source/license review before either image build is authorized.

On a separately verified host, use a clean independent checkout at that revision:

```sh
node scripts/eidoverse-acceptance.js --preflight --report /tmp/eido-acceptance.json
# Continue only when preflight exits 0 and source/terms review is complete.
upstream_sha=959a95c3d3963c334422d170317062e00936c573
portos_sha=$(git rev-parse HEAD)
docker build --label "org.portos.eidoverse.upstream=$upstream_sha" \
  -f <upstream-root>/docker/Dockerfile --build-arg AGENT=none \
  -t eidoverse:render <upstream-root>/docker
docker build --label "org.portos.eidoverse.upstream=$upstream_sha" \
  --label "org.portos.eidoverse.portos=$portos_sha" \
  -f docker/eidoverse-video/Dockerfile -t portos-eidoverse-video:1 <upstream-root>
NODE_ENV=test PORTOS_EIDOVERSE_SOURCE_REVIEWED=1 PORTOS_EIDOVERSE_LIVE=1 \
  node scripts/eidoverse-acceptance.js --live --upstream <upstream-root> \
  --report /tmp/eido-acceptance.json
```

The two-second films retain production 1280×720 and 1080×1920 geometry at
24 fps. Independent decoding checks 48 frames, duration, colored box/sphere
locations and bounds at first/middle/last frames. A stateful moving primitive
advances each simulation step; a one-second excerpt must match the corresponding
full-film frames, including state accumulated during pre-roll. A generated
330/880 Hz master song tests the full timeline and excerpt offset by decoding
AAC and measuring the expected tone. Cancellation happens only after observing
that invocation's actual running container. A deliberately failing scene must
reach its failure marker, reject, remove its container/private scratch and leave
no complete film. Real `docker inspect` must confirm production containment,
cached-only dependencies, 8 GiB memory limit and no GPU device mounts.

The JSON report gives each criterion `pass`, `fail`, `unavailable` or `not-run`.
Successful decoding saves six previews (maximum dimension 320 pixels) beside
the report in `<report-path>.frames/`; all media and report content are synthetic.
Reports expose no Docker root, private scratch path, environment or full inspect
dump. Harness validator tests use synthetic byte buffers to reject black frames,
banded output, restarted state, wrong tones and unavailable prerequisites; their
success is preparatory engineering, not real WebGPU evidence.
The workflow retains only that redacted JSON and the six tiny previews for one
day, with a 256 KiB total limit; it never uploads films, songs, build logs or
container dumps. Its job summary records every criterion even when the host is
unavailable or a build fails.

Each production render has a 12-minute harness watchdog; the workflow bounds
build time to 55 minutes and the entire job to 120 minutes. This validates Mesa
software WebGPU/libx264 only and makes no physical-GPU or speed claim. Keep
#9798 open and blocked until a suitable host passes **every** real criterion.
