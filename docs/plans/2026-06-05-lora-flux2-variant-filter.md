# Plan: Filter LoRA picker by FLUX.2 size variant (4B vs 9B)

## Context

When generating with a FLUX.2 model, selecting a LoRA had **no effect on the
output** even though the LoRA showed up in the logs. Root cause: the user
rendered with **Klein-4B** (transformer hidden dim **3072**) while the LoRA was
trained for **Klein-9B** (hidden dim **4096**). The shapes don't fit, so
diffusers' `pipe.load_lora_weights` throws a size-mismatch, and
`scripts/lora_utils.py:40-44` catches it and continues with a base render — a
silent fallback. Confirmed by the user's log:
`copying a param with shape [32,16384]` (=4096×4, 9B) vs
`current model is [32,12288]` (=3072×4, 4B).

The LoRA picker's compatibility filter (`LoraPicker.jsx:30`) only matches on
`runnerFamily`, which is `'flux2'` for **both** 4B and 9B — so it can't tell a
9B LoRA apart from a 4B one and happily offered an incompatible weight.

**Goal:** Give the picker a finer-grained "FLUX.2 variant" compatibility key so
9B LoRAs are hidden when a 4B model is selected (and vice versa), while leaving
all other runner families (mflux / z-image / ernie / hidream / qwen) behaving
exactly as today.

## Approach

Introduce a `loraCompatKey` that refines `runnerFamily` for FLUX.2 only:
`'flux2-4b'` / `'flux2-9b'` (and bare `'flux2'` when a variant can't be
determined). Non-flux2 families keep using their plain `runnerFamily` string,
so nothing else changes.

- **Model side** — derive the variant from the existing `model.id` / `model.repo`
  (e.g. `flux2-klein-4b`, `FLUX.2-klein-9B`). **No data migration needed** — the
  strings already encode it.
- **LoRA side** — determine the variant from (1) the safetensors **header tensor
  shapes** (ground truth; works for self-trained LoRAs with no Civitai metadata,
  which is exactly the user's case), falling back to (2) the Civitai
  `baseModel` string (`"Flux.2 Klein 4B"` / `"9B"`). Persist the result to the
  sidecar so the header is read at most once per LoRA.

### Files & changes

**1. `server/lib/safetensors.js` (NEW) + barrel + README + test**
- `readSafetensorsHeader(path)` — open file handle, read the 8-byte LE u64
  header length, read that many bytes, `JSON.parse`. Reads only the header
  (~KB), never the multi-hundred-MB tensor payload. Uses `fs/promises` `open` +
  partial `read`.
- `detectFlux2VariantFromHeader(header)` — scan only tensor keys matching
  `/transformer_blocks/` (skip text-encoder tensors so T5's own 4096 dim can't
  cause a false `9b`). If any of those shapes contains `4096` or `16384` →
  `'9b'`; else if `3072` or `12288` → `'4b'`; else `null`.
- Add to `server/lib/index.js` barrel + a row in `server/lib/README.md`
  (enforced by `server/lib/index.test.js`).
- New `server/lib/safetensors.test.js` with a synthesized header buffer.

**2. `server/lib/runners.js` + mirror `client/src/lib/runnerFamilies.js`**
- Add two pure, string-only helpers (safe to mirror client-side):
  - `flux2VariantFromModel(model)` → `'4b'` | `'9b'` | `null` from `id`/`repo`
    via `/(?:^|[-_])([49])b(?:[-_]|$)/i` (id) then `/klein-?([49])b/i` (repo).
  - `loraCompatKey(model)` → `isFlux2(model)` ? (`flux2-${variant}` or `'flux2'`)
    : `model.runner`.
- Extend `server/lib/runners.test.js` for both helpers across the four flux2
  ids + a non-flux2 model.

**3. `server/lib/civitai.js`**
- Add `flux2VariantFromBaseModel(baseModel)` → `'4b'`/`'9b'`/`null` via
  `/\b([49])b\b/i`. Cover in `civitai.test.js`.

**4. `server/services/loras.js` (`listLoras`, `installFromCivitai`)**
- In `listLoras` `mapEntry`, when `runnerFamily === 'flux2'`, resolve the
  variant in order: sidecar `fluxVariant` → `flux2VariantFromBaseModel(civitai
  .baseModel)` → `detectFlux2VariantFromHeader(readSafetensorsHeader(path))`.
  Best-effort persist the resolved variant back to the sidecar
  (`patchLoraSidecar`, `.catch` ignore) so the header is read once. Mirrors the
  existing "re-derive `runnerFamily` on read" pattern (`loras.js:106-109`).
- Compute and return `loraCompatKey` on each entry: `'flux2'` family →
  `variant ? 'flux2-'+variant : 'flux2'`; otherwise the plain `runnerFamily`.
  Keep returning `runnerFamily` too (used for display).
- In `installFromCivitai`, stamp `fluxVariant` into the sidecar from the
  Civitai baseModel (best-effort) so freshly-installed LoRAs are tagged without
  a header read.
- Extend `server/services/loras.test.js`.

**5. `client/src/components/imageGen/LoraPicker.jsx`**
- Accept a new `currentCompatKey` prop (alongside the existing
  `currentRunnerFamily`, kept for the "install one matching X" copy).
- Replace the filter with a variant-aware predicate:
  ```js
  const familyOf = (k) => (k?.startsWith('flux2') ? 'flux2' : k);
  const isCompatible = (loraKey) =>
    !loraKey ||                              // unknown LoRA → still shown (current behavior)
    loraKey === currentCompatKey ||          // exact variant match
    loraKey === familyOf(currentCompatKey) ||// LoRA variant unknown → coarse flux2 match
    currentCompatKey === familyOf(loraKey);  // model variant unknown (defensive)
  const compatible = availableLoras.filter((l) => isCompatible(l.loraCompatKey));
  ```
  This hides a `flux2-9b` LoRA from a `flux2-4b` model — the actual fix — while
  unknown/coarse LoRAs stay visible (preserving the "surface a clear error
  otherwise" philosophy in the file header).

**6. Call sites — compute & pass `currentCompatKey` from the selected model**
- `client/src/pages/ImageGen.jsx:506` — add
  `const currentCompatKey = loraCompatKey(currentModel)` and pass to the
  `<LoraPicker>` at ~1009 (and through `ImageGenSettingsForm` props at
  `ImageGenSettingsForm.jsx:27,97`).
- `client/src/pages/UniverseBuilder.jsx:3493-3545` — compute `currentCompatKey`
  the same way next to its `currentRunnerFamily` `useMemo` and pass it down.

### Out of scope (note in PLAN.md)
- The background search surfaced a **separate** bug: the external SD-API backend
  (`server/services/imageGen/external.js`) accepts `loraFilenames`/`loraScales`
  but never forwards them to `/sdapi/v1/txt2img`. Unrelated to this local-FLUX.2
  fix — capture as a follow-up.
- Optionally surfacing a UI toast when `apply_loras` drops an off-variant LoRA
  at render time (defense-in-depth for sidecar-replay/remix paths that bypass
  the picker). Capture as a follow-up.

## Verification

1. **Unit tests:** `cd server && npm test` — new `safetensors.test.js`, extended
   `runners.test.js`, `civitai.test.js`, `loras.test.js`; `cd client && npm test`.
2. **End-to-end (the user's repro):**
   - With the 9B-trained LoRA installed, select **flux2-klein-4b** in Image Gen →
     the LoRA should now be **absent** from the picker (count shows
     `N-1/N compatible`).
   - Switch the model to **flux2-klein-9b** → the same LoRA **appears** and is
     selectable.
   - Render on 9B with the LoRA enabled and confirm logs show
     `✅ active LoRA adapters: [('lora_0', <scale>)]` with **no** `size mismatch`
     / `⚠️ LoRA load failed` lines, and the output visibly differs from a
     base render.
3. **Regression:** confirm z-image / mflux LoRAs still list unchanged (their
   `loraCompatKey` equals `runnerFamily`).
