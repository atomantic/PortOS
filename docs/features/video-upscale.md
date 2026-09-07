# Video upscale

Every clip in the video gallery can be upscaled 2×, non-destructively — the
source file and its history row are never touched, and the result arrives as a
**new** file with its own gallery card. Two methods share one request contract:

| | `lanczos` | `ltx` |
| --- | --- | --- |
| What it does | 2× resize | 2× reference-conditioned render that **synthesizes** detail |
| Runs on | ffmpeg, any install | a GPU BYOV runtime (MLX or CUDA) |
| Cost | ~10-30s, inline | multi-minute, queued as a media job |
| Downloads | none | a gated 327 MB adapter + the backend's LTX-2.5 pack |
| Faithful to the source | pixel-faithful | **no** — detail is invented |
| Availability | always | capability-gated (see [Readiness](#readiness)) |

`lanczos` is the default and the historical behavior. A caller that sends no
method gets exactly the pass it got before the generative method existed, with
the same response shape — so nothing written against the older API had to
change.

## Using it

The gallery's **Upscale** button opens a drawer that discloses what each method
would do *before* anything is queued. The drawer's readiness check is read-only
by construction: it probes the source, reads the model cache and stats a venv
path. It queues no job and downloads no weight — the explicit Upscale press is
the only thing allowed to do either.

For the generative method the drawer names the model, the target size, the
padding the model grid needs, and a plain warning that the result will not match
the source pixel-for-pixel. Lanczos returns the finished row inline; the
generative pass returns a **queued job** to watch in the Render Queue and lands
in history when it completes.

### API

```
GET  /api/video-gen/upscale/:id/plan?method=lanczos|ltx   → { ok, plan }
POST /api/video-gen/upscale/:id     { method?: 'lanczos' | 'ltx' }
```

The two methods answer with different keys rather than one overloaded field,
because they finish at different times: Lanczos answers `{ video }` (the
finished history row), the generative method answers `{ job }` (the queued media
job). Omitting `method` is exactly `lanczos`.

Everything knowable before a GPU is committed is checked at submit, so a refusal
is an immediate 4xx/501 rather than a job that dies minutes later:

| Code | Status | Meaning |
| --- | --- | --- |
| `ALREADY_UPSCALED` | 400 | the source is itself an upscale output |
| `UNSUPPORTED_RUNTIME` | 501 | no generative backend on this host, or its venv is not installed |
| `IC_LORA_WEIGHT_UNRESOLVED` | 400 | the upscaler adapter is not downloaded |
| `UPSCALE_BASE_MODEL_UNRESOLVED` | 400 | the backend's LTX-2.5 pack is not downloaded |
| `UPSCALE_SOURCE_UNALIGNABLE` | 400 | the source cannot be measured, or aligning it would lose duration |

## The gated model

The generative method fuses **Lightricks' LTX-2.5 Pixel Spatial Upscaler
IC-LoRA**, which is a *gated* Hugging Face repo: an anonymous resolve returns
401. Two things must be in place before the adapter will download:

1. **Accept the license** on the [model
   card](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler)
   with your Hugging Face account.
2. **Store a Hugging Face token** in **Settings > Credentials**.

There is deliberately **no mirror**. The registry's other gated weight carries an
un-gated fallback repo; this one does not, because adopting a third-party
re-upload would route users around terms they are supposed to accept themselves.
Consenting to the license is a required step, not an obstacle to be engineered
away.

The weight is also marked `requiresPreDownload`, which suppresses the usual
"hand the repo id to the pipeline and let it resolve" fallback. Handing a gated
id to a pipeline's own resolver produces a 401 deep inside a render instead of
an actionable "download the weight first" message — and, for the base
checkpoint, an unannounced ~68 GB pull mid-render. Both are resolved
**cache-only**, up front.

## Per-backend requirements

The adapter needs a host that can run LTX-2.5. Which runtime carries it is
decided by platform, not by the user:

| Host | Runtime | Install | Base checkpoint |
| --- | --- | --- | --- |
| macOS (Apple Silicon) | `ltx25` | `INSTALL_LTX25=1 ./scripts/setup-image-video.sh` | `ltx25_mlx_q8` |
| Windows / Linux + NVIDIA | `ltx25_cuda` | `INSTALL_LTX25_CUDA=1 ./scripts/setup-image-video.sh` | `ltx25_cuda_distilled` |
| Anything else | — | — | no generative backend; the plan says so rather than failing at render time |

The base checkpoint is **not** part of the request. The adapter was trained
against one LTX-2.5 checkpoint, so letting a user pick another would condition
an upscale on weights it was never trained for. Each runtime names its own pin
and the dispatch resolves it from the local cache.

Both runners implement one shared argv/grid/adapter contract
(`scripts/_upscale_contract.py`), so a single `buildLtxUpscaleArgs()` emits the
same argument set whichever backend the plan resolved — only the interpreter and
the script path differ. What stays per-runner is what genuinely differs: the
runtime it imports, the host it gates on, the pack layout it validates, and the
rename maps its loader fuses through.

## The recipe

The generative method is Lightricks' standard IC-LoRA video-to-video pass, as
their IC-LoRA guide and ComfyUI reference workflow run the Pixel Spatial
Upscaler: the distilled model with the adapter fused at strength 1.0, a single
denoising stage **at the output resolution**, and the low-resolution clip as
the in-context reference at half of it (the adapter's
`reference_downscale_factor` is 2). No text steering is added — the source clip
is the whole conditioning signal — and the distilled 8-sigma schedule is used
as-is.

Both runtimes' `ICLoraPipeline` render their conditioned stage at half the size
they are handed, so the runners request **twice** the output and skip the
latent-upsample second stage (`PIPELINE_REQUEST_MULTIPLIER` in
`scripts/_upscale_contract.py` records why).

On macOS the MLX q8 pack may hold the distilled model either pre-fused
(`transformer-distilled.safetensors`) or as the dev transformer plus the
450-step distilled LoRA; the runner takes the pre-fused file when present and
otherwise fuses the distilled LoRA beside the adapter, which the pack documents
as the equivalent layout. A dev transformer without that LoRA is refused, since
the distilled schedule is only valid on the distilled model.

## The model grid, and why nothing is silently lost

LTX-2.5 renders on a fixed grid: output dimensions must divide by **64**, and
the frame count must satisfy `frames % 8 == 1` with a floor of **9**. Since the
scale is 2×, a *source* axis conforms exactly when it divides by 32 — which is
also what keeps the reference at the (padded) source's own size on the VAE's
32-pixel grid rather than resampling it before it conditions anything.

A source that does not conform is **padded, never trimmed** — extra pixels on
the right/bottom and extra frames on the tail, cropped back off the output
afterwards. Padding is recoverable; a crop or a trim destroys content the user
never agreed to lose. The plan states the padding up front ("848 → 864"), so
what the disclosure promised is what actually happens.

Two things are refused rather than guessed:

- **An unmeasurable axis.** A failed probe reports `null` (unknown), never a
  silent `0` — a caller must not read "no padding needed" out of a probe that
  failed.
- **Anything that would trim.** `trimFrames > 0` is a refusal with a stated
  reason, before the job is queued. A multi-minute GPU render that ends in a
  shorter clip than the user submitted is exactly what this prevents.

Audio rides through untouched: the render is video-only, and the **original**
clip's audio track is re-muxed onto the final deliverable. A source with no
audio track yields a video-only output rather than an error.

## Cancellation and failure

Cancellation, a probe failure, a render failure and a mux failure all end the
same way: **the source clip and its history row are byte-identical, and every
partial output is removed.** That mirrors the Lanczos path's
copy-then-transform shape — the deliverable is a new file plus a new history
row, or it does not exist at all.

The generative pass tracks its own in-flight children separately from the
render lane, so a plain `videoGen.cancel()` cannot kill an upscale (or the
reverse) for want of a job id to discriminate on.

## Provenance

Every upscaled row records what produced it, measured from the output file
rather than assumed from the request:

`upscaledFrom` · `upscaleMethod` · `width` / `height` · `fps` · `numFrames` ·
`duration` · `seed` · `upscaleRuntime` · `renderStartedAt` / `renderMs`

Read `upscaleMethod` — not the presence of `seed` — to tell the two methods
apart: an upscaled row also inherits the *source* render's fields, and Lanczos
is deterministic so it rolls no seed of its own. Lanczos records
`upscaleRuntime: 'ffmpeg'`, so the field is non-null on every upscaled row.

## Privacy: local only

The generative upscale is dispatched under its own media-job kind
(`video-upscale`) rather than as a `video` mode. That makes the local-only rule
**structural**: the federation layer's kind maps are closed lists that do not
contain it, so a source clip cannot be offered to a peer without someone
explicitly adding the kind to one of them. See the privacy rules in
`AGENTS.md`.

## Readiness

The generative method is offered only on a host that already has the runtime,
the adapter and the base pack; everywhere else the drawer shows it disabled
with the reason. That gate is per host and permanent — it is how a machine
without a GPU runtime learns it has no generative backend — and it is distinct
from whether a backend has been **verified**:

| Backend | Status |
| --- | --- |
| macOS MLX (`ltx25`) | **Verified** end to end on real renders (2026-09-07, [#6514](https://github.com/atomantic/PortOS/issues/6514)); supported. |
| Windows / Linux CUDA (`ltx25_cuda`) | Code complete with the same recipe and contract ([#6513](https://github.com/atomantic/PortOS/issues/6513)); **awaiting a render on an NVIDIA host**, tracked in [#6537](https://github.com/atomantic/PortOS/issues/6537). Treat it as unverified until that evidence is recorded. |

Lanczos is unaffected by any of this.

### What the verification matrix covers

The matrix drives the real route, queue, runner and gallery row (a spare-port
worktree server, short clips so each render is minutes) against the pinned MLX
q8 pack and the gated adapter. Recorded for macOS on an Apple Silicon host:

| Case | Source | Result |
| --- | --- | --- |
| conforming source, with audio | 576×1024, 25 f, 24 fps, 1.04 s | 1152×2048, 25 f, 1.04 s; source AAC track re-muxed intact; 258 s |
| needs frame padding, with audio | 576×1024, 23 f (padded to 25 for the render) | 1152×2048, **23 f** back, 0.96 s; audio intact; 345 s |
| needs spatial padding, no audio | 560×1000, 25 f (padded to 576×1024) | **1120×2000**, 25 f, silent — padding cropped back off; 342 s |
| cancellation mid-render | conforming source | job `canceled`; no history row, no partial file, no scratch left in the temp dir; source file and row byte-identical |

Legacy Lanczos calls (no method, and explicit `lanczos`), the error codes in
the API table, the provenance fields, and the pre-submit plan's padding
disclosure all behaved exactly as the sections above describe, before and after
the generative runs. A source that "needs a trim" is a refusal by construction
(the plan never trims), not a case to render.

## Where the code lives

| Concern | File |
| --- | --- |
| Method enum, grid math, provenance contract | `server/services/videoGen/upscalePlan.js` |
| Pre-submit plan + the inline Lanczos pass | `server/services/videoGen/upscaleVideo.js` |
| Generative job lifecycle (enqueue / run / cancel) | `server/services/videoGen/upscaleJob.js` |
| Pad and crop-back / audio re-mux | `server/services/videoGen/upscaleFfmpeg.js` |
| Routes | `server/routes/videoGen.js` |
| Adapter registry entry (`pixel-upscale`) | `server/lib/icLoraWeights.js` |
| Shared runner contract | `scripts/_upscale_contract.py` |
| Runners | `scripts/upscale_ltx25.py` (MLX) · `scripts/upscale_ltx25_cuda.py` (CUDA) |
| Method picker / disclosure drawer | `client/src/components/media/VideoUpscaleDrawer.jsx` |
