# Feasibility spike: Krea Realtime 14B as a local Apple Silicon video backend

**Status:** Closed — **no-go for now.** The first-party runtime cannot be installed,
let alone executed, on Apple Silicon; the only native-MLX path is a third party's
unpublished in-tree crate.
**Date:** 2026-08-09
**Host:** Apple M5 Max, 128 GB unified-memory tier, macOS 26.5 (host identity
deliberately omitted per `CLAUDE.md`)
**Closes:** #3673
**Related:** #3674 (shipped the per-model `disclosure` block this report's license
findings would have to populate)

## What this is and is not

Two unrelated Krea releases share a brand name and get conflated:

| | **Krea 2 RAW / Krea 2 Turbo** | **Krea Realtime 14B** |
| --- | --- | --- |
| Modality | **image** (text-to-image) | **video** (text-to-video, video-to-video) |
| Backbone | Krea's own image model | distilled from Wan 2.1 T2V 14B via Self-Forcing |
| Relevance here | none | the subject of this spike |

Only Krea Realtime 14B is evaluated below. Where a third-party runtime is cited, it
keeps the same separation — e.g. the SceneWorks `mlx-gen` tree carries an
`mlx-gen-krea` crate (Krea 2 Turbo, **image**) distinct from `mlx-gen-krea-realtime`
(**video**), and its own source comments call that out.

## Scope decision (why nothing was executed)

This spike stopped at the **source-and-license audit**, which is step 1 of the
issue's own investigation plan and an explicit prerequisite gate ("audit the exact
upstream model and runtime revisions **before** executing unfamiliar code"). Two
things were deliberately not done on the user's live machine:

1. **No checkpoint downloads.** The pinned artifacts total tens of GB (sized below).
2. **No execution of the upstream runtime.** It is unvetted third-party code with
   native CUDA extensions and a bundled Linux `.whl`, and — as the audit shows — it
   cannot install on this platform anyway, so executing it would have produced a
   dependency-resolution error, not a measurement.

Consequently **every benchmark, memory, throughput, output-validity, cancellation,
and cleanup figure in this report is recorded as "not run", with the reason.** No
timing or memory number below is a measurement of Krea Realtime on this host; the
few quantitative claims are attributed upstream statements, labelled as such.

## Pins

Everything inspected is pinned to an exact revision. All commands are read-only.

```bash
# First-party inference code (audited by shallow clone; never executed)
git clone --depth 1 https://github.com/krea-ai/realtime-video
# HEAD at audit time:
#   acf4b7b4e1a3049a0e04782e751d12203334038d  (2025-11-13, "change citation")

# First-party weights (metadata only — no blobs fetched)
curl -s 'https://huggingface.co/api/models/krea/krea-realtime-video?blobs=true'
#   revision 6b5d204f9d14c3c3a59608e49d1da7fad90daf8d  (lastModified 2025-11-14)

# Companion Wan 2.1 components referenced by the modular pipeline
#   Wan-AI/Wan2.1-T2V-14B-Diffusers @ 38ec498cb3208fb688890f8cc7e94ede2cbd7f68
#   Wan-AI/Wan2.1-T2V-1.3B          @ 37ec512624d61f7aa208f7ea8140a131f93afc9a

# Third-party native-MLX implementations surveyed
#   github.com/SceneWorks/inference @ ca41d7648fc68ac4bde81de22b51d17d3cd88bbf (2026-08-09)
#   github.com/SceneWorks/mlx-gen   @ 45428fa9727c569f3f3723c7343c96b0944f9007 (2026-07-14)
#   huggingface.co/SceneWorks/krea-realtime-14b-mlx @ e68e9a3d98187fdf6936838ffcf6df5aa48d6626
```

**Upstream is stale.** The first-party repo's last push was **2025-11-13** — roughly
nine months before this audit — and the weights repo's last modification was
2025-11-14. Neither has moved since release.

## Licensing (weights and runtime tracked separately)

| Artifact | Declared license | Primary source |
| --- | --- | --- |
| **Weights** — `krea/krea-realtime-video` | `apache-2.0` (HF card front-matter and API `cardData.license`) | <https://huggingface.co/krea/krea-realtime-video> |
| **Inference code** — `krea-ai/realtime-video` | **CC BY-NC-SA 4.0** — the repo's `LICENSE.md` is verbatim "Attribution-NonCommercial-ShareAlike 4.0 International"; GitHub's API classifies it `NOASSERTION` / "Other" | <https://github.com/krea-ai/realtime-video/blob/main/LICENSE.md> |
| Companion Wan 2.1 components (text encoder, VAE, tokenizer, scheduler) | `apache-2.0` | <https://huggingface.co/Wan-AI/Wan2.1-T2V-14B-Diffusers> |
| Vendored `wan/` source inside the Krea repo | headed "Copyright 2024-2025 The Alibaba Wan Team" and covered by the repo's CC BY-NC-SA `LICENSE.md` | repo tree |
| Third-party MLX crate `mlx-gen-krea-realtime` | `Apache-2.0` (crate manifest + repo license) | <https://github.com/SceneWorks/inference> |
| Third-party repackaged MLX weights | `apache-2.0`, self-described as a format/dtype repackaging of the upstream Apache-2.0 weights | <https://huggingface.co/SceneWorks/krea-realtime-14b-mlx> |

**These are findings, not legal advice, and nothing here is "unrestricted."**

Discussion for PortOS's distribution model: PortOS ships as source that many
independent people install and run themselves, including on machines they use for
paid work. The **weights** carry a permissive declared license and would raise no
new question relative to the Wan 2.2 entries already shipped. The **first-party
inference code** is the problem: a NonCommercial term restricts the downstream uses
PortOS installs make of it, and a ShareAlike term propagates conditions to
adaptations. That is a materially different posture from every runtime currently in
`data.reference/media-models.json`, whose `runtimeLicense` entries are MIT (the
`mlx_video` / `ltx2` / `wan22` runtimes) or an explicitly-named custom license
(HunyuanVideo). Any future Krea Realtime entry would need its `disclosure` block to
carry the two licenses **separately** — exactly the shape #3674 added — and would
need a runtime that is not the CC BY-NC-SA reference implementation.

Note the asymmetry is real and intentional upstream, not a packaging accident: the
model card and the code repo state different licenses, and the code repo's own
README badge reads `License-CC--BY--NC--SA--4.0`.

## Dependency and runtime audit (first-party runtime)

| Dimension | Finding |
| --- | --- |
| **Hard CUDA dependency** | **Yes, unconditional and at import time.** `release_server.py` executes `gpu = torch.cuda.current_device()`, `torch.cuda.Stream(device=gpu)` ×2 at **module scope** (lines 88–90). `sample.py` — the offline batch entry point — does `from release_server import ...`, so merely importing the sampler raises on any non-CUDA host before argument parsing. 95 hard CUDA references across 23 files (`.cuda()`, `device="cuda"`, `torch.cuda.*`). |
| **Custom attention kernels** | `flash_attn` / `flash_attn_interface` (FA2/FA3) and SageAttention 2.2.1. `wan/modules/attention.py:73` asserts `q.device.type == 'cuda'`. `transformer/attention.py` in the weights repo registers `torch.library.custom_op(..., device_types="cuda")`. There *is* a terminal `scaled_dot_product_attention` fallback in `attention()`, but it is unreachable in practice because import fails first. |
| **Native extensions / compilation** | `install_sage.sh` clones `thu-ml/SageAttention` and runs `python3 setup.py install` with `NVCC_APPEND_FLAGS` — an nvcc compile. The repo vendors `libs/sageattention-2.2.1-cp311-cp311-**linux_x86_64**.whl`. |
| **Platform-locked pins** | `pyproject.toml` pins `triton==3.4.0` as a **non-optional** project dependency. Triton 3.4.0 publishes only `manylinux_2_27_x86_64` / `manylinux_2_28_x86_64` wheels (6 artifacts, zero macOS). `uv sync` therefore fails to resolve on macOS arm64 **before any model code runs**. Also pinned: `torch==2.8.0`, `torchvision==0.23.0`, `torchao==0.12.0`, `diffusers==0.31.0`, `transformers==4.54.1`, Python `>=3.11,<3.12`. `flash-attn` on PyPI is classified `Operating System :: Unix`. |
| **Remote code** | The weights repo ships executable Python (`modular_blocks.py`, `denoise.py`, `encoders.py`, `decoders.py`, `transformer/model.py`, `transformer/attention.py`) loaded through diffusers' modular `auto_map` (`modular_config.json` → `modular_blocks.WanRTBlocks`). No `trust_remote_code` string appears in the GitHub repo, but the HF path is functionally remote-code execution. `modular_model_index.json` also declares `"_diffusers_version": "0.36.0.dev0"` — an **unreleased** diffusers, and one that disagrees with the repo's own `diffusers==0.31.0` pin. |
| **Network behavior at runtime** | `from_pretrained` / `AutoTokenizer.from_pretrained` calls pull from the Hub; `modular_model_index.json` names four components with `"revision": null` — i.e. **floating** refs to `Wan-AI/Wan2.1-T2V-14B-Diffusers` (scheduler, text encoder, tokenizer, VAE) plus the Krea transformer. `v2v.py:46` and `wan/utils/qwen_vl_utils.py:95` fetch arbitrary user-supplied URLs via `requests.get`. The optional prompt-extender path can call the DashScope API. |
| **Subprocesses** | `ffmpeg` invoked via `subprocess.Popen` / `subprocess.run` in `release_server.py`, `sample.py`, `v2v.py`. `demo_utils/vae_torch2trt.py` implies a TensorRT conversion path. |
| **Server surface** | The supported entry point is `uvicorn release_server:app --host 0.0.0.0` — a WebSocket streaming server bound to all interfaces by default. |
| **Documented requirements** | README: "NVIDIA GPU with 40GB+ VRAM recommended", "OS: Linux (Ubuntu recommended)", "Python 3.11+", "~30GB for model checkpoints". No mention of macOS, MPS, Metal, or Apple Silicon anywhere in the repo — the only `mps` hits are two Wan-inherited `# mps does not support float64` comments and one dead device-picker in `demo_utils/taehv.py`. |

### Checkpoint files and sizes (from the HF blob API, not downloaded)

`krea/krea-realtime-video` @ `6b5d204f` totals **57.2 GB**, because it ships the same
transformer twice in two equivalent layouts:

| File(s) | Size |
| --- | --- |
| `krea-realtime-video-14b.safetensors` (single-file layout) | 28.58 GB |
| `transformer/diffusion_pytorch_model-0000{1,2,3}-of-00003.safetensors` (sharded layout) | 9.97 + 9.89 + 8.72 = **28.58 GB** |
| remote-code `.py` + configs + demo `hf_assets/*.mp4` | ~0.06 GB |

Either layout is ~28.6 GB, which is what upstream's "~30GB" refers to — but that is
**transformer only**. The pipeline additionally needs Wan 2.1 components:

- README setup path: `Wan-AI/Wan2.1-T2V-1.3B` — **17.6 GB** (of which 11.36 GB is the
  UMT5-XXL text encoder and 0.51 GB the VAE).
- Modular/diffusers path: components from `Wan-AI/Wan2.1-T2V-14B-Diffusers` —
  22.72 GB `text_encoder` + 0.51 GB `vae` (its 57.15 GB `transformer` is not needed).

**Realistic first-run download: ~46–52 GB**, not 30 GB.

## Apple Silicon feasibility

### Native execution — **fails at dependency resolution; nothing to measure**

Not run. The blocking chain, in the order a user would hit it:

1. `uv sync` cannot resolve `triton==3.4.0` on macOS arm64 (no macOS wheels exist).
2. Even bypassing (1), `flash_attn` / SageAttention are CUDA-only; SageAttention's
   installer compiles with `nvcc`, and the vendored wheel is `linux_x86_64`.
3. Even bypassing (2), `import release_server` raises at
   `torch.cuda.current_device()` on line 88 — module scope, before any device
   argument is read. There is no device-selection flag to set.

Substituting `"cuda"` → `"mps"` across the tree is precisely the "generic device-string
substitution" the issue rules out, and it would still not satisfy the FA/Sage
`device_types="cuda"` custom ops or the CUDA stream plumbing
(`torch.cuda.Stream`/`torch.cuda.stream` used for the KV-cache upload/download
overlap, which has no MPS analogue).

### Is there a maintained MPS or MLX port?

Surveyed, and the answer is **not one PortOS can install today**.

- **PyTorch MPS port of Krea's pipeline:** none found. No fork, branch, or issue in
  the upstream repo offers one; the repo has had no commits since 2025-11-13.
- **`Blaizzy/mlx-video`** (MIT, last push 2026-05-13) supports **stock Wan 2.1
  1.3B/14B**. Stock Wan 2.1 is not Krea Realtime: Krea's contribution is the
  *inference regime* (few-step self-forcing schedule, block-causal attention,
  persistent KV cache with recompute), which stock Wan pipelines do not implement.
  No `krea` / `self-forcing` support was found there.
- **`SceneWorks/mlx-gen`** (Apache-2.0, Rust): its public snapshot at `45428fa9`
  (2026-07-14) has `mlx-gen-wan` but **no** Krea Realtime support.
- **`SceneWorks/inference`** @ `ca41d764` (2026-08-09) **does** contain a real native
  MLX implementation: `crates/media/mlx-gen/mlx-gen-krea-realtime` (~420 KB of Rust
  across `causal.rs`, `generate.rs`, `t2v.rs`, `scheduler.rs`, `load.rs`, plus 11
  integration-test files including a torch-golden comparison). Its own module docs
  describe it as "an architecture reimplementation in native MLX, not a copy of"
  the reference source, staged S1→S7 with i2v/v2v in S7.
- Matching repackaged weights exist at `SceneWorks/krea-realtime-14b-mlx`
  (Apache-2.0, published 2026-07-27): q4 tier 20.27 GB, q8 27.29 GB, bf16 40.46 GB,
  **88 GB** across all three tiers. **0 downloads, 0 likes** at audit time.

Why this still doesn't clear the bar for PortOS:

- The crate is `version = "0.0.0"` and is **not published** — `crates.io` returns 403
  (nonexistent) for `mlx-gen-krea-realtime`, `mlx-gen-wan`, and `mlx-gen`. Its
  manifest uses `path = ".."` dependencies into a ~540 MB product monorepo, and its
  `repository` field points at a *different* URL (`github.com/michaeltrefry/mlx-gen`)
  than the repo it currently lives in.
- Consuming it means checking out a large monorepo and building a Rust toolchain +
  MLX bindings from source. Every video runtime PortOS ships today (`mlx_video`,
  `ltx2`, `wan22`) installs as a pinned Python package into a venv with weights
  pulled by HF snapshot. There is no existing PortOS mechanism this fits.
- It is days old and self-describes as staged work in progress. The Apple Silicon
  claims in its docs are **its authors' claims, not measurements made here.**

### Memory and disk — not measured

Not run (see above). For completeness, the third-party MLX crate's own documentation
states — as an upstream claim, unverified here — that KV-cache cost is ~800 KiB per
DiT token in bf16, giving **3.57 GiB at the shipped 6-frame window and 14.3 / 32.1 GiB
at 15- and 30-frame windows**, on top of ~9 GiB of Q4 weights, with Q8 KV quantization
measuring 0.53× the bf16 cache. If those figures hold, the wider windows would put a
32 GB Mac out of reach and would consume a meaningful fraction of even a 128 GB tier
— but PortOS should treat them as unverified until it measures them itself.

Disk: a first install would need ~20 GB (q4 MLX tier) to ~52 GB (first-party layout
plus Wan components). The audit host had 267 GB free, so disk was not the binding
constraint; the software path was.

### Performance, output validity, cancellation, cleanup — not run

All four are **not run**, for the single reason stated in the scope decision: the
first-party pipeline cannot be installed on this platform, and the only native path
is an unpublished third-party crate that PortOS has no supported way to install. The
sole performance figure in circulation is upstream's own "11 fps text-to-video with 4
inference steps on a single NVIDIA B200" — a datacenter-GPU claim that carries no
implication for Apple Silicon and is reproduced here only for provenance.

### LTX 2.3 / Wan 2.2 comparison runs — not run, explained

The issue permits their absence to be explained rather than filled. They are absent
because a comparison requires **both** sides. With no executable Krea Realtime run on
this host, an LTX 2.3 or Wan 2.2 number would be a solo measurement presented next to
nothing, which is exactly the "unlike runs presented as a direct speed comparison"
the issue warns against. Spending 40 GB of downloads and hours of render time to
produce one half of a comparison whose other half is structurally unobtainable was
not justified. PortOS already ships both as macOS backends (`ltx23_distilled_q4` is
the current macOS default), so the baseline can be collected cheaply *if and when* a
Krea Realtime run becomes possible.

### Capability differentiation

On paper Krea Realtime offers something PortOS's current macOS video backends do not:
**streaming generation with ~1 s time-to-first-frame, mid-generation prompt changes,
and live video-to-video / webcam restyling.** That is a genuinely distinct interaction
model, not just a speed delta, and it is the one argument that could justify carrying
another local runtime. But the issue's gate makes that a tiebreaker for a *working*
pipeline, not a substitute for one — and PortOS's video UI is a job-and-artifact
model today, so consuming a streaming backend would itself be a substantial client
change beyond the runtime install.

## Go/no-go

| Criterion | Verdict |
| --- | --- |
| Pipeline completes deterministic T2V through native MPS or MLX, no CUDA dependency, no sustained CPU fallback | ❌ **Fail.** First-party runtime is hard-CUDA at import and un-installable on macOS (`triton` has no macOS wheel). The one native-MLX implementation is a third party's unpublished, in-progress crate — not a maintained, installable port. |
| Peak use ≤80% of unified memory on a declared tier, with release after completion/cancellation | ❌ **Not demonstrated.** Not measurable without an executable pipeline. Third-party KV-cache figures suggest wider windows would be tight even on large tiers. |
| ~5 s / 480p render within 2× the faster of LTX 2.3 and Wan 2.2 on the same host, **or** a demonstrated distinct capability | ❌ **Not demonstrated.** No render was performed; the streaming/v2v capability is documented upstream but not *demonstrated on Apple Silicon* here. |
| All source and model revisions pinnable and fetchable through the existing PortOS trust/download model | ❌ **Fail.** Weights pin cleanly; the runtime does not. `modular_model_index.json` uses `"revision": null` (floating) for four components, the runtime declares an unreleased `diffusers 0.36.0.dev0`, and the MLX alternative is an unpublished path-dependency crate requiring a Rust build — outside PortOS's pinned-Python-package + HF-snapshot install model. |
| Weights and runtime license findings do not block PortOS's distribution and use case | ⚠️ **Blocks the first-party runtime.** Weights are Apache-2.0. The first-party inference code is CC BY-NC-SA 4.0 — NonCommercial + ShareAlike, unlike every runtime PortOS ships. A permissively-licensed reimplementation would avoid this, which is one more reason the decision hinges on a runtime PortOS can actually install. |

### Decision: **no-go for now**

No registry entry, package, checkpoint, runtime, or setup/update change is added by
this spike — deliberately, per the issue's instruction not to preserve the idea with
a disabled entry. This document is the artifact.

### Reevaluation trigger

Reopen when **either** of the following is true:

1. **Upstream adds a real non-CUDA path** — `krea-ai/realtime-video` (currently
   frozen at `acf4b7b4`, 2025-11-13) gains a maintained MPS/Metal execution path
   that removes the module-level `torch.cuda.current_device()` and the mandatory
   `triton` / `flash-attn` / SageAttention pins, **and** the inference code is
   relicensed off CC BY-NC-SA to a license compatible with PortOS's distribution.
2. **A native Apple Silicon runtime becomes independently installable** — a
   Krea Realtime MLX implementation (e.g. `mlx-gen-krea-realtime`, or MLX/self-forcing
   support landing in `Blaizzy/mlx-video`) ships as a **published, versioned,
   pinnable artifact** — a crates.io/PyPI release or a signed standalone binary —
   installable without checking out and building a third party's product monorepo,
   with a documented Apple Silicon text-to-video run at a stated memory tier.

If (2) lands, the follow-up work is a full spike rerun, not a direct integration: the
memory, throughput, output-validity, cancellation, and cleanup rows above are all
still empty, and the LTX 2.3 / Wan 2.2 baselines still need collecting on the same
host before any registry entry is justified.
