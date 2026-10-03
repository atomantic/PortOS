# Build the upstream auto branch's render-only eidoverse:render image first.
# Context: the independent eidoverse-video checkout, never the PortOS data tree.
FROM eidoverse:render
USER root
COPY --chown=node:node eidoverse /workspace/eidoverse
COPY --chown=node:node deno.json deno.lock LICENSE /workspace/
USER node
ENV DENO_DIR=/home/node/.cache/deno
RUN deno cache --node-modules-dir=auto eidoverse/render_common.mjs eidoverse/render_scene.mjs npm:@dimforge/rapier3d-compat@0.14.0
# Software WebGPU is portable; upstream's NVENC default requires NVIDIA.
ENV GALLIUM_DRIVER=llvmpipe RENDER_CODEC=libx264 LD_LIBRARY_PATH=""
