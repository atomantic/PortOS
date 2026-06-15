# Next Release

## Added

- **Video LoRAs now fuse on the bf16 LTX-2.3 Unified Beta (mlx_video runtime), not just dgrauet** — Previously a video LoRA like `ltx2.3-audio-reactive-lora` only worked on the dgrauet `ltx2` runtime; selecting the higher-quality **LTX-2.3 Unified Beta** (notapalindrome's `mlx_video` runtime) silently hid the LoRA picker. The stock `mlx_video.generate_av` CLI has no `--lora` flag, but the `mlx-video-with-audio` package ships an LTX-aware LoRA subsystem (`mlx_video.lora`) that's simply never called from the AV generator. A new wrapper (`scripts/generate_av_lora.py`) closes that gap without reimplementing the ~1000-line generation loop: it loads the user LoRAs, monkeypatches generate_av's two transformer-weight load seams to merge the LoRA deltas into the transformer (bf16, `quantization_bits=0`), then runs generate_av's own `main()` — so the SSE progress protocol is byte-for-byte identical to the non-LoRA path. The VideoGen picker now appears for non-quantized LTX-2.x `mlx_video` models too (gated by `isMlxVideoLtxLoraCapable`); if a LoRA's keys don't match the model the render fails loudly rather than silently producing a base video. Scoped to bf16 — the quantized Distilled Q4/Q8 variants stay on the dgrauet path for now and show an inline hint pointing at the supported models. (`scripts/generate_av_lora.py`, `server/lib/runners.js`, `server/services/videoGen/local.js`, `server/routes/videoGen.js`, `client/src/lib/runnerFamilies.js`, `client/src/pages/VideoGen.jsx`)

## Changed

## Fixed
