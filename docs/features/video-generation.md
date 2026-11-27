# Video generation and post-processing

## Warm render batches

In Video Gen, **Advanced → Renders in batch** selects 1–20 independent clips with the same inputs. Leave Seed blank for independent random values or enter a starting seed for consecutive unsigned 32-bit values. The request is rejected if the sequence overflows. A batch occupies one local queue slot and retains completed clips on failure or cancellation. History records the actual seed, `batchId`, `batchIndex` and `batchSize`.

MiniMax H3 MLX reuses the loaded pipeline, adapters and in-memory prompt embeddings in one Python process. Batches are unavailable for other runtimes, cloud providers, federation, chained chunks and scene-delivery jobs. Batch timings are excluded from single-render ETA samples.

## Speed profiles

The Quality profile uses the ordinary sampler. A faster profile is offered only for validated model pins and modes. Sampler precedence is the model's locked schedule, an applicable speed profile, explicit steps and guidance, then model defaults. An unsupported, locked or mismatched request falls back to the model sampler with a reason. A chained clip applies the profile only if every chunk's mode supports it. The UI applies the same mode gate.

`server/lib/videoSpeedProfiles.js` owns the model pin, mode compatibility and schedule. `server/lib/videoGenValidation.js` owns the request field `speedProfileId`. The runner's `SPEEDPROFILE:` result reports actual steps, guidance, TeaCache and adapter use, including degraded levers. Use those recorded results to assess speed. ETA samples are scoped by model and profile, so an unmeasured profile may have no estimate. Validate any new profile at its shipped repo/revision and pipeline modes before advertising it.

## Video text encoders

Video conditioning depends on the pinned model's encoder architecture and weight layout. Keep default conditioning unless a registered compatible alternative fits the workload. H3 uses Qwen3-VL-32B-compatible substitutes and supports dual-encoder memory strategies through its MLX runner. PortOS assembles an encoder shim around the pinned assets, keeping tokenizer, processor and model configuration compatible. Its runners do not patch source checkouts on disk. Resolve the exact registry checkpoint, validate dimensions and quantization, and require strict weight loading before a render.

LTX-2.3 uses a separate Gemma model. LTX-2.5 uses the embedded Gemma 4 12B tower by default. The LTX-2.5 substitute loader can resolve a self-describing compatible tower while retaining the pack connector, but evaluated substitutes failed validation and the shipped registry stays stock-only. Do not infer cross-model compatibility from checkpoint branding or use partial weights to bypass a strict-load failure.

## Video upscale

Use **Upscale** on a gallery clip. The read-only plan probes the source, runtime and weights before submission. Every result becomes a separate item with measured output geometry, duration and method provenance. Failure and cancellation preserve the source and remove partial local output.

| Method | Output | Requirements |
| --- | --- | --- |
| Lanczos | Deterministic 2× scale, returned inline | ffmpeg. Default for callers that omit the method. |
| LTX | Detail-synthesizing 2× render, queued as `video-upscale` | LTX-2.5 runtime, validated base model and the gated Pixel Spatial Upscaler IC-LoRA already in cache. Local only. |
| Real-ESRGAN | Frame-by-frame 2× enhancement on the local GPU, queued as `video-upscale` | The opt-in Real-ESRGAN runtime, installed from the drawer. Local only. |
| fal SeedVR2 | Paid cloud diffusion upscale to a target resolution | fal API key. |
| Topaz | Optional paid cloud upscale of a music video's current final render | Topaz API key and explicit start after a quote. |

For LTX, use `ltx25` on Apple Silicon and `ltx25_cuda` on supported Windows/Linux NVIDIA hosts. The runtime, compatible hardware, cached base pack and cached adapter are independently checked. The CUDA base declares a 64 GB system-memory floor. Use the [runtime locks](../RUNTIME_LOCKS.md#ltx-25-cuda) and the runtime setup UI, then accept the gated adapter's Hugging Face license and configure a token before downloading it. Dispatch uses the runtime's pinned base and adapter, with no generic model override. The shared recipe pads to the model grid and restores the intended output geometry. Treat the result as synthesized detail.

Real-ESRGAN runs the official `realesrgan-ncnn-vulkan` v0.2.5.0 release (Vulkan, MoltenVK on macOS) on macOS, x86-64 Windows and x86-64 Linux. The plan reports the install target, readiness and output size without downloading or running anything. **Install Real-ESRGAN** in the drawer or the Music Video upgrade panel is the only download: it fetches the platform archive, checks its pinned SHA-256, unpacks the binary and weights to `~/.portos/realesrgan-ncnn-vulkan/`, and runs every selectable weight on a test frame. Readiness requires the resulting receipt, so a host without a usable Vulkan device fails at install rather than in a job. Pick **General footage** (`realesrgan-x4plus`, a fixed-4× network resampled to 2×) or **Animation** (`realesr-animevideov3` at its native 2×). The job decodes every frame, enhances them in batches, re-encodes at the source frame rate, and keeps the source frame count and audio track.

Music Video settings include a preferred shot workflow. Choose **Grok video** for cutaway drafts, then open **Upscale** on a shot's Clip tab after reviewing its motion. New projects default to fal.ai SeedVR2 at 1080p when a fal.ai key is configured, with Lanczos as the local default. SeedVR2 uses the selected target resolution, Lanczos, local LTX and Real-ESRGAN use 2× scaling, and Topaz Labs outputs 1080p through its credit quote flow. **Upgrade drafts to final** estimates SeedVR2 spend and checks local upscaler readiness for the approved clips before submission. Completed upscales add a final take and replace the source if it is still selected.

Topaz can estimate a padded 1920×1080 output without uploading the source or reserving credits. Explicit submission uses the returned one-use quote and uploads a prepared, padded copy without cropping. The queued request retains its provider identity across restarts. If local cancellation or monitoring fails, check the remote job's recorded status before starting another. The result is separate from the project master and keeps the original audio. The upscale router lives in `server/routes/videoGenUpscale.js`. See [media operation controls](media-operation-control.md) for cancellation and [API Explorer](../API.md) for current operations.

## MiniMax H3 speed profiles

**Quality** uses the stock sampler. To try an experimental profile, install
or repair the pinned runtime, cache the eligible base model and explicitly
download the profile adapter in Video Gen. PortOS verifies the adapter before
admission. A selection or render does not start a download. The runtime's
code dependencies are separate from weights.

LightX2V has separate CUDA and MLX INT8 contracts. The MLX profile supports
single text or first-image clips at 1344×768. Pika H3 Flex on the supported
MLX INT8 row also offers 640×384 and 1024×576. Ineligible models, canvases,
conditioning and continuation modes are refused. Compare actual paired
renders on the same hardware and settings before judging speed, fidelity
or soundtrack quality. See the [CUDA runtime setup](../RUNTIME_LOCKS.md#windows-and-linux-cuda).
