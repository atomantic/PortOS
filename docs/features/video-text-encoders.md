# Swappable video text encoders

Video Gen lets a MiniMax H3 render choose which **prompt conditioner** (text
encoder) reads the prompt. The picker sits under the Model field and defaults to
the conditioner that ships with the model, so nothing changes unless you pick
something else.

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

Only the **bf16** file is usable here. The repo's INT8 ConvRot and NVFP4/AWQ
variants use ComfyUI's own quantization (learned row-wise rotation matrices,
group size 256) that the MLX loader cannot dequantize, and the `50_63`
generation tails belong to ComfyUI's H3 Prompt Enhancer node — a feature PortOS
does not implement. That's why the download is scoped to one file rather than a
repo snapshot: the full repo is ~130 GB for ~48 GB of usable weights.

## Using it

1. Pick **MiniMax H3** on `/media/video`. A **Text encoder** select appears under
   the model's download badge.
2. Choose a substitute. If it isn't downloaded, a Download button appears and
   **Generate stays disabled** until it's resident — the same gate the model
   weights and IC-LoRA weights use.
3. Render. The chosen conditioner is recorded in history, so **Remix** reproduces
   the render faithfully; a stock render records nothing and remixes as stock.

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
  file: 'weights.safetensors',   // one file; never a repo snapshot
  keyPrefixMap: { 'model.': 'model.language_model.', 'visual.': 'model.visual.' },
  finalNormKey: 'model.norm.weight',  // omit if the checkpoint ships its own norm
  sizeBytes: 12345,              // exact published size — the UI formats this
  disclosure: { modelCardUrl, weightsLicense, baseModel, estimatedDownloadGb, reviewedAt },
}
```

These live in code rather than `data/media-models.json` on purpose: a stale
registry file must never be able to name a checkpoint this build's runner has no
key map for.

To confirm a candidate is really a drop-in before downloading tens of GB, read
its safetensors header with an HTTP range request, apply the prefix map, and diff
the result against the parameter set the loader builds. That's how the shipped
entry was validated.

## Cost note

A substitute is an *additional* download — the stock conditioner's shards stay
resident so you can switch back instantly. Resident memory during a render is
unchanged (the same 50 layers + vision tower are loaded either way); only disk
grows.

## Related

- `server/lib/videoTextEncoders.js` — the registry, and the one place a new entry goes
- `scripts/generate_minimax_h3.py` — the shim builder and key remap
- `server/services/videoGen/local.js` — cache resolution and argv
- `client/src/components/videoGen/TextEncoderPicker.jsx` — the control
