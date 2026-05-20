# client/src/lib/ — shared client helpers

Pure / side-effect-free helpers used by pages, components, and hooks.
**Before adding a new helper here, grep this catalog first** — if a similar module exists,
extend it. When you add a new module, add it to `index.js` AND add a row here.

Hooks (state + lifecycle) live in `client/src/hooks/`. HTTP/socket clients live in
`client/src/services/`. Pure formatting helpers live in `client/src/utils/`.

Several modules here are **server mirrors** — they must be kept byte-for-byte in sync with
their server counterpart. The server copy is authoritative; the matching server test file
is the contract.

## Discovery rule

```
grep -i "what you want to do" client/src/lib/README.md
```

---

## Prompt & rendering (server mirrors)

| Module | Purpose |
|---|---|
| `canonPrompt.js` | Mirror of `server/lib/canonPrompt.js`. SHORT/RICH/PREVIEW spec + `flattenCanonDescriptorFragments` / `mapCanonDescriptorFragments` / `descriptorForCanonEntry`. |
| `scenePrompt.js` | Mirror of `server/lib/scenePrompt.js`. Scene-prompt composer + bible matchers. |
| `composeStyledPrompt.js` | Compose user prompt + negative with an optional style preset. |
| `cleanPlatePrompt.js` | Clean-plate prompt builder for setting canon entries (Cluster A — A4). |
| `seasonStructure.js` | Mirror of `server/lib/seasonStructure.js`. |
| `universeStylePreset.js` | Build the client-side style preset that `composeStyledPrompt` layers on top. |
| `bibleLimits.js` | Mirror of `server/lib/storyBible.js` `BIBLE_LIMITS`. |
| `runnerFamilies.js` | Mirror of `server/lib/runners.js`. |
| `issueLength.js` | Mirror of `server/lib/issueLength.js`. |

## Pipeline / image-gen defaults

| Module | Purpose |
|---|---|
| `pipelineImageDefaults.js` | Pipeline comic-page image-gen defaults + settings reader. |
| `wrImageDefaults.js` | Writers Room per-scene image-gen defaults + style discriminators. |
| `imageGenBackends.js` | `IMAGE_GEN_MODE` enum (local / codex / external) + metadata. |
| `imageGenResolutions.js` | Shared resolution presets for image generation. |
| `videoGenResolutions.js` | Shared resolution presets for video generation (companion to image side; LTX-2 latent-friendly sizes). |

## Graph & sim

| Module | Purpose |
|---|---|
| `graphSimulation.js` | 3D force simulation parameters for BrainGraph / CyberCity. |

## Generic UI / collection utilities

| Module | Purpose |
|---|---|
| `clipboard.js` | `copyToClipboard`, `writeClipboardSilently`, `readClipboard` — safe across insecure-origin contexts. Use these instead of `navigator.clipboard.writeText` inline. |
| `genUtils.js` | Shared bits between Image Gen and Video Gen pages. |
| `joinInfluenceList.js` | Mirror of `joinInfluenceList` in server universe builder. |
| `mediaNavigation.js` | `getAdjacentMedia(items, item)` — prev/next computation for lightboxes. |
| `unsorted.js` | Synthetic "Unsorted" collection from media not filed in any real collection. |
| `upsertByIdPrepend.js` | Newest-first upsert into an id-keyed list. |
| `voiceLabel.js` | `formatVoiceLabel(v, engine?)` — display label for a TTS voice record. Engine-specific formatters plug into a lookup table; new engines extend that map. |
