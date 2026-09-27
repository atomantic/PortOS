# H3 vision precision on Metal

Investigation for #8948, 2026-09-27. **No production precision or adapter change
is justified by these measurements.** The first bfloat16 discrepancy is
positional interpolation, followed by independently measurable normalization,
attention and MLP arithmetic differences. Changing individual operations does
not reliably reduce the final feature difference across inputs. This is not a
passing numerical-equivalence claim and is not evidence of scene discontinuity.

## Method and evidence

All runs used the cached actual vision weights from
MiniMaxAI/MiniMax-H3 revision 6818f6c32d12b210915e44ad56a4228c2608f160, its FL2VA
configuration and PIL processor, and PortOS's production weight sanitizer.
The H3 runtime pin remains fcd9e9b79a1d6018d91ac477c0968de1fa067e49.
The 50-layer conditioning language model and video denoiser were not loaded.

Hardware: Apple M5 Max, 128 GiB. Packages: MLX/mlx-metal 0.32.0, mlx-vlm 0.6.10,
transformers 5.14.1, torch 2.12.0, torchvision 0.27.0. Each configuration ran
in a separate process, sequentially with the managed inference server stopped
and no running media jobs; the server was restored afterward. Downloads and
MPS CPU fallback were disabled.

Two 768×1344 synthetic inputs were stretched with LANCZOS to 576×1024:
the [continuity harness's colored scene](minimax-h3-continuity.md) and an
integer-generated RGB gradient with deterministic 5-bit spatial noise. The
latter has no random-library seed dependency. Both yield grid [1,64,36],
2,304 patch rows, and 576 merged rows. No private image was used.

[results.json](assets/minimax-h3-vision-precision/results.json) stores input
hashes, configuration hash, package versions, final/deepstack metrics, selected
intermediates, and all 27 block-output relative differences for native runs.
Numbers in JSON are ratios; tables below are percentages. The metric is
norm(actual-reference)/norm(reference), accumulated in NumPy float64, with
the named reference in the denominator. Maximum absolute differences and
absolute/reference RMS accompany the selected stages. There is no invented
pass/fail tolerance.

The diagnostic observes real module calls and streams float32 copies of their
outputs to .npy files. It also evaluates the first block's normalization,
attention and MLP on the reference trace's exact stored inputs (replay stages).
Those replay results do not replace values in the forward pass. Attention
replay includes each backend's rotary implementation for the same grid.
Trace and output paths must be new; an incomplete trace has no manifest.

For the flat fixture, all four native outputs in the instrumented run were
bit-identical to the earlier uninstrumented #8867 artifacts for MLX Metal
float32, MLX Metal bfloat16, and PyTorch MPS bfloat16. Thus the hooks did not
alter those observed results. This is a checked property of these runs, not
a general guarantee about lazy execution on future package versions.

## Earliest divergence and propagation

MLX Metal bfloat16 versus PyTorch MPS bfloat16:

| Stage | Colored scene | Gradient/noise |
| --- | ---: | ---: |
| Patch embedding | 0% | 0% |
| Positional embedding | 0.325369% | 0.325369% |
| First block input | 0.209569% | 0.211757% |
| First block output | 0.548687% | 0.580539% |
| Final merged features | 13.479806% | 6.981045% |

The patch projections are **bit-identical**, so the first discrepancy is before
the first transformer block, at positional interpolation. The interpolation
inputs depend on the grid, so its discrepancy is identical for both fixtures.
The native MLX implementation casts interpolation coefficients to the embedding
dtype and adds four weighted vectors in sequence. Transformers 5.14.1 computes
the weighted reduction in float32, then casts before adding to patch features.
These represent different rounding schedules for the same bilinear operation;
the trace does not reveal a wrong patch layout, token order or missing weight.

A diagnostic-only float32 interpolation control reduces the positional
difference to 0.014267% and the flat fixture's first-block input difference
to 0.008133%. The remaining position difference includes cross-framework
coordinate/reduction rounding near bfloat16 boundaries. Despite the local
improvement, final flat-scene features get further from the MPS reference.

There are additional differences even with identical first-block inputs:
the flat fixture's MLX bfloat16 normalization, attention and MLP differ from
MPS by 0.290988%, 0.123833% and 0.412685%, respectively. They cannot all be
attributed to accumulated error from interpolation. In particular, the
[pinned MLX Metal LayerNorm kernel](https://github.com/ml-explore/mlx/blob/v0.32.0/mlx/backend/metal/kernels/layer_norm.metal)
casts the normalized value to the storage dtype before its affine transform.
Running that normalization and affine arithmetic in float32 and casting only
its output reduces identical-input norm1 disagreement to 0.000465% for the
flat fixture. This isolates an arithmetic boundary, not a PortOS weight-loader
or embedding-merge defect.

## Controlled operation changes

Merged-feature relative difference versus each fixture's native PyTorch MPS
bfloat16 output. Only the named operations change; all model weights, input
pixels and the returned storage dtype stay bfloat16.

| MLX diagnostic configuration | Colored scene | Gradient/noise |
| --- | ---: | ---: |
| Native | 13.479806% | 6.981045% |
| Float32 interpolation | 14.221877% | 6.974663% |
| Eager attention | 13.766134% | 7.270643% |
| Float32 interpolation + eager attention | 13.628306% | 7.769029% |
| Float32 normalization/affine | 14.616678% | 6.474232% |
| Float32 interpolation + normalization/affine | 12.712028% | 6.746739% |

The eager control uses an explicit score matmul, scaling, float32 softmax,
cast to query dtype, and value matmul. It follows the reference's operation
ordering while retaining MLX kernels; it is not a replacement PyTorch backend.
Its lack of consistent improvement rules out blaming fused attention alone.
The normalization control covers every vision LayerNorm, including mergers.

The much smaller float32 discrepancy has a separate, measurable explanation.
MLX documents that float32 matmul-family operations can use reduced internal
precision on supported hardware; [the documented control is
MLX_ENABLE_TF32=0](https://ml-explore.github.io/mlx/build/html/usage/precision.html).
Measured with the installed 0.32.0 build:

| Float32 configuration versus PyTorch CPU float32 | Colored scene | Gradient/noise |
| --- | ---: | ---: |
| MLX CPU | 0.002024% | 0.001177% |
| MLX Metal, default internal precision | 0.690987% | 0.500257% |
| MLX Metal, TF32 disabled | 0.005025% | 0.001997% |
| PyTorch MPS | 0.004818% | 0.002118% |

Disabling that optimization largely removes the Metal float32 gap without
changing model operations. It does not establish bfloat16 equivalence.
Neither switching attention alone nor one higher-precision local operation
explains or repairs the accumulated bfloat16 difference.

## Decision and continuity boundary

Keep production behavior unchanged. The observations separate reference
operation rounding (interpolation), framework kernel arithmetic
(normalization and matmul), and input-dependent propagation through the tower.
They do not demonstrate a PortOS adapter defect or a consistently beneficial
precision correction. Adopting one of the controls solely because one fixture
gets closer would trade one unvalidated behavior for another.

This investigation completes the layer-level characterization requested in
#8948; it does not certify every image, precision, backend or future version.
No new render is claimed: no production correction was selected. The earlier
fixed-seed [motion and contradictory-prompt experiment](minimax-h3-continuity.md)
remains the continuity evidence, and its tested motion-only clips retained
their source scene. Numerical feature differences and visible continuity are
separate outcomes. A future proposed production correction still needs a
conditioning-boundary regression and real before/after renders; these
diagnostic controls alone do not satisfy that requirement.

## Offline reproduction

Use an interpreter with the exact packages above and an already cached FL2VA
directory. Run only with an idle GPU and inference servers stopped. Do not run
the GPU cases concurrently. Each trace occupies roughly 0.4 GiB; keep arrays
outside the repository and commit only synthetic aggregate metrics.

~~~sh
python scripts/diagnose_minimax_h3.py --output-dir /tmp/h3-flat
PYTHON=<diagnostic-python>
CHECKPOINT=<cached-FL2VA>

"$PYTHON" scripts/diagnose_minimax_h3_vision.py torch \
  --dtype bfloat16 --device gpu --checkpoint-dir "$CHECKPOINT" \
  --source /tmp/h3-flat/source.ppm --output /tmp/h3-torch-bf16.npz \
  --trace-dir /tmp/h3-torch-bf16
"$PYTHON" scripts/diagnose_minimax_h3_vision.py mlx \
  --dtype bfloat16 --device gpu --checkpoint-dir "$CHECKPOINT" \
  --source /tmp/h3-flat/source.ppm --output /tmp/h3-mlx-bf16.npz \
  --trace-dir /tmp/h3-mlx-bf16 --replay-dir /tmp/h3-torch-bf16
"$PYTHON" scripts/compare_minimax_h3_vision.py \
  /tmp/h3-mlx-bf16 /tmp/h3-torch-bf16 --output /tmp/h3-comparison.json
~~~

Repeat with --fixture gradient-noise in place of --source, using new paths.
The replay trace must have the same processed pixels and dtype. For the
bfloat16 operation matrix, add --position float32, --attention eager,
--normalization float32, or the combinations in the table, only on MLX.
These flags exist solely in this diagnostic and never affect production.

For float32, first capture torch --dtype float32 --device cpu; compare
torch/float32/gpu, mlx/float32/cpu and mlx/float32/gpu to that trace.
Repeat the last command with MLX_ENABLE_TF32=0 in its process environment.
The trace manifest records the override. The four .npz output keys remain
0 (merged) and 1–3 (deepstack); no tracing is enabled without --trace-dir.
