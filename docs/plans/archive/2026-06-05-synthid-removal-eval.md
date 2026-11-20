# SynthID-removal: competitive evaluation + regen improvements

**Date:** 2026-06-05 · **Area:** `server/services/imageGen/regen.js`, `local.js`, `routes/imageGen.js`, `MediaLightbox.jsx` · **Issue lineage:** #912, #970

Design record for an evaluation of five public AI-watermark-removal repos against PortOS's
**mflux/FLUX img2img reprocessing** regen, and the improvements that evaluation produced.

## How PortOS regen works (baseline)

`server/services/imageGen/regen.js` round-trips a gallery image through a local FLUX model via
img2img at low denoise (0.25, **empty prompt**) so the VAE resample overwrites SynthID's per-pixel
signal with minimal visible change. Large sources are clamped to a ~2MP FLUX attention budget and
upscaled back. The plain `imageClean.js` (C2PA strip + median/sharpen) deliberately does **not**
touch SynthID — regen is the honest defeat path. It is hardware-gated on a local FLUX runner.

## The five repos evaluated

| Repo | Method | Takeaway vs PortOS |
|---|---|---|
| **mertizci/noai-watermark** | SD img2img + optional CtrlRegen (Canny/IP-Adapter), tiling | Same core (VAE roundtrip); adds ControlNet structure guidance + tiling. |
| **wiltodelta/remove-ai-watermarks** | Diffusion w/ vendor-adaptive strength (OpenAI 0.10 / Gemini 0.15) + reverse-alpha for *visible* marks + metadata strip | Vendor-adaptive strength; visible-watermark removal; most feature-complete. |
| **samukingx/SynthIDBye** | LSB destruction + noise (browser) | **Cautionary tale** — SynthID is not LSB; misadvertised/ineffective. Validates our VAE approach. |
| **00quebec/Synthid-Bypass** | ComfyUI: low-denoise (0.1) Qwen redraw + Canny ControlNet + per-face refine; resolution-aware adaptive denoise | Confirms low-denoise roundtrip works; adds adaptive denoise. |
| **aloshdenny/reverse-SynthID** | 7-stage spectral+spatial: VAE roundtrip → elastic deform → affine → **resize-squeeze** → color nudge → FFT phase subtraction → recompress; PSNR-gated | Most sophisticated. **SynthID carriers are resolution-dependent** — resize-squeeze is a deliberate, CPU-cheap defeat stage. |

**Key learnings:** (1) SynthID's invisible carriers move with resolution, so a downscale→upscale
resize-squeeze disrupts them for free; (2) layered cheap *spatial* stages (no GPU) meaningfully add
to a single VAE vector; (3) tune denoise by generator, not a flat value; (4) serious tools measure
fidelity (PSNR-gating) and verify against a detector; (5) LSB-only is a dead end.

## What shipped

1. **Universal resize-squeeze** (`clampRegenDimensions`, `REGEN_SQUEEZE_FACTOR`): the
   downscale→upscale that previously fired only for >2MP images now applies to *every* regen, so
   each pass gets a resolution-shift disruption vector layered on the VAE roundtrip.
2. **CPU-only light fallback** (`applyLightRegen` + `runLightRegen` route, `method: 'light'`): a
   sharp-only spatial stack (resize-squeeze + micro color/contrast nudge + median/sharpen) for
   installs with no FLUX runner — which previously had no SynthID defeat path at all. Honestly
   labeled as less reliable (`regenMethod: 'light-spatial'` sidecar stamp, UI copy says so).
3. **Output fidelity metric** (`computePixelDelta`): source-vs-delivered pixel delta % + PSNR
   stamped on every regen sidecar (`regenPixelDeltaPct`/`regenPsnr`); the lightbox lineage row
   surfaces the "% changed" figure (PSNR stays in the sidecar for diagnostics) — catches the mflux
   strength-0.0 footgun, silent txt2img fallbacks, over-mutation.
4. **Provider-adaptive strength default** (`resolveRegenStrengthDefault`): SynthID-bearing sources
   (codex/gpt-image, gemini/imagen/nano-banana) keep the conservative known-good 0.25; local FLUX
   sources (no Google watermark) default to a lighter 0.15. Explicit `strength` override unchanged.

## Considered, NOT pursued

- **ControlNet/Canny structure guidance** — lets others push higher denoise; we deliberately keep
  denoise *low* (simpler, reuses the GPU lane, no heavy deps). Right trade-off for minimal mutation.
- **Visible-watermark removal** (Gemini sparkle, Doubao/Jimeng text, Samsung) via reverse-alpha +
  NCC + inpainting — a real compatibility gap, but a substantial separate feature. → future `PLAN.md`.
- **Automated detector verification loop** — Google's SynthID Detector is limited-access, no broad
  public API; full automation isn't feasible today. The manual sweep-down workflow stands; the new
  fidelity metric gives an objective in-tool signal in its absence.
