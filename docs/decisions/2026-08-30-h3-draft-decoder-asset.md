# ADR: The H3 Draft-Decode Gates Ship Without an Asset, and Stay That Way Until a Full-VAE-Shaped Candidate Exists

- **Date:** 2026-08-30
- **Status:** Accepted — `VIDEO_DRAFT_DECODERS` stays empty; the mechanism stays shipped
- **Related:** issue #5423,
  [`server/lib/videoDraftDecoders.js`](../../server/lib/videoDraftDecoders.js),
  `build_draft_decoder_shim` in
  [`scripts/generate_minimax_h3.py`](../../scripts/generate_minimax_h3.py),
  [`server/services/videoGen/generateVideo.js`](../../server/services/videoGen/generateVideo.js)

## Decision

PortOS keeps the draft-decode mechanism it already ships — declaration, runtime-revision
check, asset-readiness check, delivery-intent override, the `DRAFTDECODE:` outcome line,
and the Video Gen control — and **declares no draft-decoder asset for MiniMax H3.**

The blocking constraint is **PortOS's own substitution shape, not the availability of
cheap decoders.** `build_draft_decoder_shim` composes a checkpoint root whose
`video_vae/source/model.safetensors` is the substitute and whose configs stay upstream's,
and the pinned MLX port's `load_video_vae` (`PipeNetwork/minimax-h3-mlx`
@ `fcd9e9b79a1d6018d91ac477c0968de1fa067e49`) then does a **strict** key match against the
whole `VideoVAE` parameter tree. A qualifying asset must therefore be a **complete,
unquantized, full-`VideoVAE`-shaped checkpoint carrying upstream's exact key set.**

Every published way of making a video decode cheap fails that shape by construction:
a tiny autoencoder is a different module tree, a quantized repack carries
`.scales`/`.biases` the strict check rejects as unexpected, and a decoder-only head is
missing every encoder key. What survives the shape check — a full-size re-trained VAE —
saves no resources, which is the entire point of the feature.

**Adding an asset is therefore not a table row.** It requires runner-side support for an
alternate decoder module, i.e. a fork of the pinned runner. PortOS deliberately pins
upstream rather than forking it, so that is a separate decision, not a follow-up task.

## Why this came up

Issue #5423 came out of a `reference-watch` review of Phosphene (commit `d4c6ac55`,
v3.7.0), which added "TAE fast decode on every Draft tier" and reported a 640×384 5 s
draft in about a minute.

## What Phosphene is actually using

Confirmed still true at Phosphene HEAD (`f97ea3c`, v4.8.0, 2026-08-29):

- The asset is **`madebyollin/taeh3` → `taeh3.safetensors`**, about 23 MB, downloaded
  through `huggingface_hub` at install time and copied beside the other H3 models as
  `models/tae/taeh3.safetensors`.
- It is a **Tiny AutoEncoder** — a separate, much smaller module tree, not a re-trained
  H3 `VideoVAE`. That is exactly what makes it 23 MB instead of gigabytes.
- It is offered only when **both** halves are present: a runner checkout that accepts
  `--draft-decode`, and the weight on disk. The render then gets
  `--draft-decode tae --tae-checkpoint <path>`.
- Those flags exist because Phosphene pins its **own runner fork** (`codex/h3-engine-v2`)
  which implements the TAE decoder. They are not upstream flags.

So Phosphene's gating discipline matches PortOS's (probe the installed runner, never
assume; withhold the control rather than dying on an argparse error mid-render), and the
approach is sound — but it rests on a forked runner that PortOS does not have.

## Candidates surveyed (2026-08-30)

| Candidate | Size | Verdict |
|---|---|---|
| `madebyollin/taeh3` | ~23 MB | **Not publicly resolvable.** The HF API returns 401 for it, and the author's public model list (`taesd`, `taesdxl`, `taesd3`, `taef1`, `taef2`, …) contains no `taeh3`. Fails "publicly verifiable". Even if it resolved, a TAE cannot load through the pinned `load_video_vae`. |
| `Vayden/MiniMax-H3-Video-VAE-MLX-Q8` | 2.94 GB | **Gated** — reads return "Access to model … is restricted", so the pin cannot be reviewed rather than trusted. Its MLX affine-q8 keys would also fail the strict load. |
| `Mamad8/MiniMax-H3-Image-VAE` | 5.21 GB | Loads (it is a merged full-VAE checkpoint), but its own README says in bold not to use it as the video VAE, and an image-specialized decoder "materially regresses multi-frame video reconstruction". At full-VAE size it saves nothing either. Fails preview-honesty and the point of the feature. |
| `iamkaikai/MiniMax-H3-Single-Frame-VAE-500K` | 9.69 GB | Decoder-only (585 tensors, `decoder.*` + `post_quant_conv.*`), so the strict load is missing every encoder key. Its README says not to treat it as a replacement decoder for H3 video, naming grid artifacts, flicker and texture drift in a full-sequence decode. Larger than the decoder it would replace. |

## Consequences

- The Video Gen draft control stays hidden for H3: `publicVideoDraftDecodeOptions` is
  empty for a model with no declared decoder, so users see no knob rather than a knob
  that declines.
- Every gate stays covered by tests, so the day a qualifying asset appears the work is a
  table row plus a migration — as originally designed.
- **Re-entry condition.** Reconsider only on a complete, unquantized, full-`VideoVAE`
  checkpoint with upstream's key set, published ungated, whose own documentation endorses
  video decode — or on a decision to stop pinning the upstream runner. A new
  `reference-watch` proposal that simply re-points at a TAE does not clear either bar.

## Alternatives rejected

- **Loosen the strict load** (`load_video_vae(..., strict=False)`) so a partial checkpoint
  loads. That is the "plausible-looking pixels that are wrong in a way no test can catch"
  failure the checklist exists to prevent; a half-loaded decoder produces output nobody
  can distinguish from a legitimately rough draft.
- **Ship the gated Q8 repack behind an HF token.** Draft decode is a convenience; making
  it depend on a credential the user must obtain inverts its cost/benefit, and an
  unreviewable pin is exactly what the checklist forbids.
- **Fork the pinned runner to add a TAE module.** The right shape, and what Phosphene
  did — but it converts a pinned upstream dependency into a maintained fork of a
  multi-hour render path. That is its own decision with its own risk, not a step inside
  this issue.
