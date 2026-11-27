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
| Topaz | Optional paid cloud upscale of a music video's current final render | Topaz API key and explicit start after a quote. |

For LTX, use `ltx25` on Apple Silicon and `ltx25_cuda` on supported Windows/Linux NVIDIA hosts. The runtime, compatible hardware, cached base pack and cached adapter are independently checked. The CUDA base declares a 64 GB system-memory floor. Use the [runtime locks](../RUNTIME_LOCKS.md#ltx-25-cuda) and the runtime setup UI, then accept the gated adapter's Hugging Face license and configure a token before downloading it. Dispatch uses the runtime's pinned base and adapter, with no generic model override. The shared recipe pads to the model grid and restores the intended output geometry. Treat the result as synthesized detail.

Topaz can estimate a padded 1920×1080 output without uploading the source or reserving credits. Explicit submission uses the returned one-use quote and uploads a prepared, padded copy without cropping. The queued request retains its provider identity across restarts. If local cancellation or monitoring fails, check the remote job's recorded status before starting another. The result is separate from the project master and keeps the original audio. The upscale router lives in `server/routes/videoGenUpscale.js`. See [media operation controls](media-operation-control.md) for cancellation and [API Explorer](../API.md) for current operations.
