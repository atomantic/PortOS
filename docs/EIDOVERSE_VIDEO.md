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
