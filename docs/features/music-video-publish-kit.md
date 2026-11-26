# Music Video Publish kit

In **Music Video → Publish → Release assets**, choose the copy loudness and build the kit. **As mixed** is the default. **Web** targets −14 LUFS integrated with a −1.5 dBTP ceiling for each generated MP4 copy, including teasers and vertical cuts. The approved final render and project mix are kept as the source.

The Web preset measures each copy after its window and fades. It uses constant gain to preserve the mix dynamics, so a track with high peaks can finish below the loudness target. Each download shows the measured loudness and true peak of the delivered AAC. If a copy has no measurable audio or the build is cancelled, the previous kit stays available.

`POST /api/music-video/:id/publish-kit/build` accepts an optional `loudnessPreset` of `as-mixed` or `web` and returns `{ jobId }`. Omit the body to use As mixed. Web measurements are saved with each copy in `publishKit.exports[].loudness`.
