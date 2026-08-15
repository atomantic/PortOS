# Swappable video text encoders

Video Gen lets a render choose which **prompt conditioner** (text encoder) reads
the prompt. The picker sits under the Model field and defaults to the conditioner
that ships with the model, so nothing changes unless you pick something else.

Two runtimes have a conditioner table: **MiniMax H3** (the substitutes below) and
**LTX-2.5**, whose mechanism ships but whose substitutes are still gated — see
[LTX-2.5](#ltx-25) at the end. Every other runtime has no picker at all.

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
and it is the only thing such a checkpoint gets wrong, since mlx-lm's
`gemma4.Model.sanitize()` already discards the `vision_tower.*` / `audio_tower.*`
/ `multi_modal_projector.*` towers at load. The `quantization` block is never
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

### Status: substitutes gated pending a coherence check

Two substitutes are declared in the registry (`ltx25-abliterated-4bit`,
`ltx25-heretic-8bit`) and both carry `verified: false`, which keeps them out of
the picker **and** out of the download lane — an unverified id is rejected by
route validation and its weights cannot be pulled. The LTX-2.5 picker therefore
hides itself today, exactly as it does for a runtime with no substitutes at all.

What is unsettled is empirical, not structural: Lightricks'
`gemma4-12b-with-proj-ltx-2.5` tower may be LTX-fine-tuned rather than stock
`google/gemma-4-12B-it`, in which case a stock-derived abliterated tower would
feed the pack's connector out-of-distribution features and render incoherently.
To settle it, flip an entry to `verified: true` locally, download it from Media
Models, then render the same prompt/seed/steps/resolution against the stock
conditioner and against the substitute — once on a benign prompt (does it stay
structurally coherent?) and once on a prompt the stock conditioner waters down
(does it read differently?). Ship the flag flip only for a substitute that passes
both, and record a failure in the module docblock rather than deleting the entry.

## Related

- `server/lib/videoTextEncoders.js` — the registry, and the one place a new entry goes
- `scripts/generate_minimax_h3.py` — the H3 shim builder and key remap
- `scripts/generate_ltx2.py` — the LTX-2.5 shim builder and resolution override
- `server/services/videoGen/local.js` — cache resolution and argv
- `client/src/components/videoGen/TextEncoderPicker.jsx` — the control
- `client/src/hooks/useModelDownloadStatus.js` — `startWhenIdle`, the select-starts-the-pull mechanism (generic: any gated-weight picker can adopt it)
