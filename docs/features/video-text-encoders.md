# Swappable video text encoders

Video Gen lets a render choose which **prompt conditioner** (text encoder) reads
the prompt. The picker sits under the Model field and defaults to the conditioner
that ships with the model, so nothing changes unless you pick something else.

Two runtimes have a conditioner table: **MiniMax H3** (the substitutes below) and
**LTX-2.5**, whose mechanism ships stock-only after both initial substitutes
failed the empirical gate — see [LTX-2.5](#ltx-25) at the end. Every other
runtime has no picker at all.

## Why H3's conditioner is swappable at all

H3 does not use its Qwen3-VL-32B conditioner as a language model. The DiT reads
the **unnormalized hidden state after language layer 49** and feeds it straight
into `condition_proj`. Layers 50–63, the final norm and `lm_head` are never
evaluated — the MLX port doesn't even load them.

That makes the conditioner unusually easy to substitute: any checkpoint carrying
the same Qwen3-VL embedding, language layers 0–49 and vision tower produces a
conditioning signal of the same shape. Swapping it changes **how the model reads
a prompt** — vocabulary, phrasing sensitivity, refusal behavior — without
touching the diffusion weights, the VAEs or the sampler.

Everything else about the render is unchanged: same DiT, same 8-point sigma
schedule, same joint video+audio output.

## What ships

| Option | What it is | Extra download |
|--------|-----------|----------------|
| **Stock** | The conditioner inside `MiniMaxAI/MiniMax-H3`'s `FL2VA/text_encoder/` | none — already downloaded with the model |
| **Ultra-Heretic uncensored** | `ethanfel/Qwen3-VL-32B-Ultra-Heretic-H3-ComfyUI-INT8-ConvRot`, bf16 variant — Qwen3-VL-32B-Instruct abliterated with Heretic v1.2.0 (attention-targeted), repackaged for H3 | ~48 GB, one pinned file |
| **Huihui abliterated** | `huihui-ai/Huihui-Qwen3-VL-32B-Instruct-abliterated` — the same base model abliterated by a different lab and a different method, so it reads prompts differently again | ~57 GB, 12 of the repo's 14 pinned shards |

For Ultra-Heretic, only the **bf16** file is usable. The repo's INT8 ConvRot and
NVFP4/AWQ variants use ComfyUI's own quantization (learned row-wise rotation
matrices, group size 256) that the MLX loader cannot dequantize, and the `50_63`
generation tails belong to ComfyUI's H3 Prompt Enhancer node — a feature PortOS
does not implement. That's why the download is scoped to one file rather than a
repo snapshot: the full repo is ~130 GB for ~48 GB of usable weights.

Huihui's is an upstream checkpoint rather than a repack, so it arrives as
safetensors shards. Two of the fourteen hold only language layers 50–63 —
parameters the loader never builds — so they aren't pulled: 12 shards, ~57 GB
instead of ~67 GB. Because it's the upstream Hugging Face namespace and it ships
its own final norm, it needs neither the key remap nor the synthesized norm the
repack does.

## Using it

1. Pick **MiniMax H3** on `/media/video`. A **Text encoder** select appears under
   the model's download badge.
2. Choose a substitute. **Selecting one starts its download** — each option's
   size is in its own line of the select, so the cost is visible before the
   click. **Generate stays disabled** until it's resident, the same gate the
   model weights and IC-LoRA weights use, and the badge below the select carries
   the progress, the cancel and the retry.
3. Render. The chosen conditioner is recorded in history, so **Remix** reproduces
   the render faithfully; a stock render records nothing and remixes as stock.

Only an explicit pick starts a download. Restoring a conditioner — a Remix, a
resumed render replayed after a reload — never does; those weights are either
already present or one click away on the badge.

If another download already holds the progress stream, the pick queues behind it
(the badge reads "Queued — starts when the current download finishes") rather
than aborting it.

Switching to a model whose runtime can't load your selection snaps the picker
back to Stock rather than leaving it on a value the server would reject.

## How the swap works

The pinned MLX runtime (`PipeNetwork/minimax-h3-mlx`) is verified clean before
every render — PortOS never edits it. Two adapters in
`scripts/generate_minimax_h3.py` bridge the gap instead:

**1. A composed checkpoint root.** `build_encoder_shim()` creates a directory of
symlinks under `~/.portos/minimax-h3-encoder-shims/<id>/` — everything from the
upstream `FL2VA/` snapshot (`model_index.json`, both VAEs, the tokenizer, the
processor) linked straight through, with only `text_encoder/` replaced by the
substitute plus the stock `config.json`. The runtime's own `from_pretrained()`
then loads it with no argument it doesn't already take. The shim lives outside
the pinned checkout deliberately: anything written inside would read as untracked
in the pin verification.

The loader globs `*.safetensors` in that directory, so a multi-shard substitute
is just several links instead of one — no index file, no loader change. It also
means the shards that weren't pulled are simply absent from the glob, which is
exactly right: their tensors are ones the loader never asks for.

The substitute ships weights only. Its config, tokenizer and processor come from
upstream — correct, because abliteration changes weights, not the vocabulary or
the vision geometry.

**2. A key-prefix rewrite.** A ComfyUI-packaged conditioner flattens the
transformers namespace (`model.layers.N.…` / `visual.…`) while the port's loader
matches the Hugging Face one (`model.language_model.layers.N.…` /
`model.visual.…`). `install_key_prefix_map()` wraps the loader's `_wanted` method
so keys are translated **before** it sees them, then delegates every real
decision — which layers are past the conditioning depth, what `lm_head` maps to —
back to the pinned implementation. Rules are applied longest-source-first so a
broad rule can't shadow a narrower one. If a future pin drops `_wanted`, the
swap fails with a message naming the cause rather than silently mis-loading.

**3. A synthesized final norm.** The Ultra-Heretic checkpoint omits
`norm.weight` (its metadata records `minimax_h3_final_norm: "false"`) — correct,
since H3 reads the state *before* the norm. But the port instantiates the whole
module tree and refuses to load with any parameter missing. The runner writes a
ones-filled companion shard, which the loader's `*.safetensors` glob picks up
alongside the substitute. It is never applied; ones is the identity if a future
revision ever does apply it. The key is written in the *substitute's* namespace
(`model.norm.weight`) so the prefix map rewrites it like any other key.

Verified against the real pinned runtime: the 902 tensors in the bf16 file plus
the synthesized norm map onto exactly the 903 parameters the loader builds — 552
language, 351 vision, zero missing, zero extra, zero skipped.

Neither adapter runs for the Huihui entry: its keys are already the namespace the
loader matches, and its `model.language_model.norm.weight` is real rather than
synthesized. Its 12 pinned shards carry the same 903 parameters (the other 155
tensors in the repo are layers 50–63 and `lm_head`, which the loader skips
exactly as it skips them in the stock checkpoint).

## Adding another conditioner

Add an entry to `TEXT_ENCODERS_BY_RUNTIME` in
[`server/lib/videoTextEncoders.js`](../../server/lib/videoTextEncoders.js).
Nothing else needs to change — the picker, the download/repair lane, the
integrity scan and the render path all read from that table.

```js
{
  id: 'my-encoder',              // also the shim directory name
  label: '…',                    // shown in the picker
  description: '…',
  repo: 'org/repo',
  revision: '<40-char sha>',     // pinned, never a branch
  files: ['weights.safetensors'],  // explicit list; never a repo snapshot
  keyPrefixMap: { 'model.': 'model.language_model.', 'visual.': 'model.visual.' },
  finalNormKey: 'model.norm.weight',  // omit if the checkpoint ships its own norm
  sizeBytes: 12345,              // exact published size — the UI formats this
  disclosure: { modelCardUrl, weightsLicense, baseModel, estimatedDownloadGb, reviewedAt },
}
```

These live in code rather than `data/media-models.json` on purpose: a stale
registry file must never be able to name a checkpoint this build's runner has no
key map for.

### The candidate has to be Qwen3-VL-32B

The shim reuses **upstream's** `config.json`, tokenizer and processor, so a
substitute has to match them: `hidden_size` 5120, 64 language layers, `head_dim`
128, `vocab_size` 151936, `intermediate_size` 25600, and the same 27-block /
1152-wide vision tower with deepstack indices `[8, 16, 24]`. Abliteration changes
weights, not the vocabulary or the vision geometry, which is exactly why an
abliterated Qwen3-VL-32B drops in.

A *different Qwen generation* does not, however close the conditioning width
looks. Qwen3.5-27B (`model_type: qwen3_5`, e.g.
`Blackfrost-AI/Qwen3.8-27B-ABLITERATED-BF16`) also reports `hidden_size: 5120`,
but 48 of its 64 layers are Gated-DeltaNet `linear_attn` blocks with parameters
(`in_proj_qkv`, `conv1d`, `A_log`, `dt_bias`) that have no counterpart in the
module tree this loader builds, its vocabulary is 248320 tokens against the
stock tokenizer's 151936, and its `head_dim` is 256. No key remap can bridge
that — it needs a different model implementation and a different tokenizer, not
a registry entry.

### Validating one before you pull tens of GB

Fetch the candidate's `model.safetensors.index.json` (or read a single file's
safetensors header with an HTTP range request), apply the prefix map, and diff
the result against the parameter set the loader builds — 903 tensors: embed +
`norm` + language layers 0–49, plus the full vision tower. Diff its
`config.json` against `FL2VA/text_encoder/config.json` at the same time. That's
how both shipped entries were validated; for the Huihui entry the index also
identified which shards carry no needed tensor, which is what the `files` list
leaves out.

## Cost note

A substitute is an *additional* download — the stock conditioner's shards stay
resident so you can switch back instantly. Resident memory during a render is
unchanged (the same 50 layers + vision tower are loaded either way); only disk
grows.

## LTX-2.5

LTX-2.5 conditions through a Gemma 4 12B tower packed **inside** the model under
`text_encoder/`. The pinned fork's `PromptEncoder._text_encoder_source()` prefers
that directory unconditionally whenever its `config.json` reports
`model_type: "gemma4"` and ignores `gemma_model_id` entirely — which is why
`--gemma`, the flag the LTX-2.3 runtime uses, cannot substitute anything here.
A 2.5 substitution overrides that **resolution** instead.

**The shim.** `build_ltx25_encoder_shim()` in `scripts/generate_ltx2.py` builds
`~/.portos/ltx25-encoder-shims/<id>/` from scratch each render: every pinned file
of the substitute linked in by basename (the shards, their
`model.safetensors.index.json`, the tokenizer and generation configs), plus a
generated `config.json`. Nothing comes from the model pack — unlike the H3 shim,
which must keep upstream's config, tokenizer and processor, a Gemma 4 tower is
self-describing and the pack contributes only its connector, loaded separately.

`config.json` is generated rather than linked because two things have to change:
`vision_config` / `audio_config` are dropped (so what remains is the
`model_type` + `text_config` + `quantization` triple the fork's own
`convert_ltx25_to_mlx.py --step text-encoder` emits), and the registry entry's
`configOverrides` are merged over the rest. That field exists for exactly one
correction — a *unified* Gemma 4 checkpoint publishes
`model_type: "gemma4_unified"`, which `Gemma4LanguageModel.load()` hard-rejects,
while mlx-lm's `gemma4.Model.sanitize()` already discards the
`vision_tower.*` / `audio_tower.*` / `multi_modal_projector.*` towers at load.
The real strict-load gate found eleven additional `vision_embedder.*` tensors in
that checkpoint. `install_ltx25_unified_weight_filter()` removes only that exact
visual prefix before delegating to mlx-lm's sanitizer; strict loading remains on,
so a missing language tensor still fails. The `quantization` block is never
overridden: per-layer group-size overrides are part of how the weights were
packed, and a mismatch dequantizes to noise.

**The override.** `install_ltx25_encoder_override()` patches
`PromptEncoder._text_encoder_source` on the **class**, once, before any pipeline
is constructed — so no render mode can build a pipeline that skips it, including
one added later. The wrapper delegates to the original to obtain the encoder
class, then swaps only the path, which means nothing imports
`Gemma4LanguageModel` from a path the pinned fork could move; a model dir that
does *not* resolve to it (an LTX-2.3 pack reached through this flag) fails loudly
rather than conditioning on the wrong architecture. The pinned fork source is
never edited.

### The candidate has to be Gemma 4 12B at the LTX-2.5 geometry

48 layers, `hidden_size` 3840, `vocab_size` 262144, `head_dim` 256,
`attention_k_eq_v: true` — `Gemma4LanguageModel` hard-validates `model_type`, the
layer count and the hidden size on load, and the pack's connector was trained
against a 49-hidden-state stack of that width. Those are stock
`google/gemma-4-12B-it` dimensions, which is what makes an off-the-shelf
abliterated Gemma 4 12B a plausible drop-in. A different Gemma generation is not:
Gemma 3's tokenizer, vocabulary and layer count have no mapping onto the module
tree mlx-lm's `gemma4` builds.

### Status: all evaluated substitutes failed; LTX-2.5 remains stock-only

The two initial substitutes (`ltx25-abliterated-4bit`,
`ltx25-heretic-8bit`) carry `verified: false`, which keeps them out of the
picker **and** out of the download lane — an unverified id is rejected by route
validation and its weights cannot be pulled. The entries remain declared only
as pinned failure records.

The gate ran on the pinned production runtime with the same seed within each A/B,
at 512x320, 33 frames, 24 fps, 8 guided steps plus 3 stage-two steps, and CFG 3.
It used one benign motion prompt and three target-behavior challenges:

| Candidate | Benign coherence | Target-behavior result | Verdict |
|-----------|------------------|------------------------|---------|
| 4-bit abliterated | Broadly coherent | Stock rendered the staged bite and prop cigarette more literally; both rendered an index finger for the requested middle-finger gesture | Failed |
| 8-bit Heretic | Coherent scene, but one kite fragmented into several red objects | Staged-bite and prop-cigarette behavior remained stock-like; the explicit gesture was still an index finger | Failed |

Both candidates did change the generated pixels, but neither produced a
repeatable improvement on the behavior the feature exists to unlock. Pixel
difference alone is not the pass criterion. A future candidate must preserve
benign structure **and** visibly improve at least one controlled challenge before
its `verified` flag can be enabled. The repeated-seed candidate search is tracked
in #4470.

That search identified `nightmedia/gemma-4-12B-it-uncensored-heretic-mxfp8-mlx`
at revision `20c9f4b167e56f3f749ea3e428188a5e7a35318a`. It is an exact MLX
quantization of the Heretic language backbone named by DeepNeuralNerd's
LTX-2.5-specific ComfyUI conversion. The ComfyUI artifact combines that
backbone with LTX's own projections; PortOS already loads those projections and
the connector from the pinned model pack, so the MLX candidate preserves the
same separation rather than duplicating them inside the substitute.

The candidate is pinned as `ltx25-ltx-heretic-mxfp8` with all three weight
shards and support files (12,375,013,657 published bytes). Its index contains
all 48 language layers, the embedding and final norm at the required 3840-wide /
262144-vocabulary geometry, and ten residual visual-only tensors handled by
the existing exact-prefix sanitizer; MXFP8 metadata remains untouched.

The production technical preflight passed on 2026-08-17. The shim strict-loaded
with zero missing and zero extra language tensors after removing exactly those
ten visual tensors. Each of the four controlled prompts produced 49 finite
hidden states shaped `[1, 1024, 3840]`; the pack's unchanged connector produced
finite video inputs shaped `[1, 1024, 4096]` and audio inputs shaped
`[1, 1024, 2048]`.

The repeated-seed gate then completed with seeds `424242` and `8675309`, using
the same production settings documented above. Contact sheets sampled five
evenly spaced frames from every 33-frame result. In the table below, "no gain"
means neither render followed the challenged instruction; it is not a pass just
because the candidate produced different pixels.

| Prompt | Seed | Stock | LTX Heretic MXFP8 | Result |
|--------|------|-------|--------------------|--------|
| Benign kite | `424242` | One red kite and its handler persist | One smaller red kite and its handler persist | Structure preserved |
| Benign kite | `8675309` | One red kite persists | One red kite persists | Structure preserved |
| Staged bite | `424242` | Keeps the two-actor neck staging, though the bite is not fully literal | Replaces it with an unrelated monochrome hand-to-mouth action | Regression |
| Staged bite | `8675309` | Keeps two actors confronting at the neck | Produces a three-actor tableau without a bite | Regression |
| Middle-finger gesture | `424242` | Open palm | Open palm | No gain |
| Middle-finger gesture | `8675309` | Edge-on/open-hand motion | Index finger | No gain |
| Prop cigarette | `424242` | Lit prop, flame and smoke are visible | Prop and lighter appear, but no visible drag or exhaled smoke | Regression |
| Prop cigarette | `8675309` | Cigarette and smoke are visible | The requested cigarette action and smoke do not persist | Regression |

The text-encoder comparison is seed-independent, so it ran once per prompt.
Each cell below is `cosine / RMS` for stock versus candidate. Layer-group values
average the independently measured layers, preventing a high-norm late layer
from dominating the whole group.

| Prompt | Embedding | Layers 1–12 | Layers 13–24 | Layers 25–36 | Layers 37–48 | Video connector | Audio connector |
|--------|-----------|-------------|--------------|--------------|--------------|-----------------|-----------------|
| Benign kite | .998 / .124 | .954 / .267 | .947 / .998 | .890 / 2.698 | .698 / 3.961 | .993 / .121 | .988 / .156 |
| Staged bite | .998 / .124 | .956 / .261 | .946 / 1.053 | .910 / 2.613 | .730 / 3.763 | .983 / .185 | .980 / .198 |
| Middle-finger gesture | .998 / .124 | .954 / .265 | .948 / 1.010 | .895 / 2.692 | .704 / 3.935 | .992 / .124 | .991 / .134 |
| Prop cigarette | .998 / .124 | .954 / .266 | .948 / 1.034 | .895 / 2.688 | .721 / 3.857 | .987 / .160 | .990 / .141 |

The candidate diverges progressively through the language stack, but the
unchanged LTX projections produce much closer connector inputs. More
importantly, that measurable delta yielded no repeated improvement on any of
the three target prompts. `ltx25-ltx-heretic-mxfp8` therefore stays
`verified: false`, preserving the picker, download lane and render path as
stock-only. A future candidate still has to preserve benign structure and
improve at least two target prompts on both seeds before it can be enabled.

## Related

- `server/lib/videoTextEncoders.js` — the registry, and the one place a new entry goes
- `scripts/generate_minimax_h3.py` — the H3 shim builder and key remap
- `scripts/generate_ltx2.py` — the LTX-2.5 shim builder and resolution override
- `server/services/videoGen/local.js` — cache resolution and argv
- `client/src/components/videoGen/TextEncoderPicker.jsx` — the control
- `client/src/hooks/useModelDownloadStatus.js` — `startWhenIdle`, the select-starts-the-pull mechanism (generic: any gated-weight picker can adopt it)
