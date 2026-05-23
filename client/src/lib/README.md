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
| `sheetPointers.js` | Mirror of the character-sheet pointer helpers from `server/lib/storyBible.js`. `LEGACY_SHEET_VARIANT_ID` + `readSheetPointer` / `listSheetPointers` / `applySheetPointer` for traversing both the legacy `referenceSheetImageRef` field and the `referenceSheets` map. |
| `universeStylePreset.js` | Build the client-side style preset that `composeStyledPrompt` layers on top. |
| `bibleLimits.js` | Mirror of `server/lib/storyBible.js` `BIBLE_LIMITS`. |
| `imageCleaners.js` | Mirror of `resolveCleanersFromConfig` from `server/lib/imageClean.js`. Reads `{cleanC2PA, denoise}` off a per-mode settings record; `cleanC2PA` defaults on, `denoise` defaults off (legacy `autoClean: true` no longer silently enables denoise). |
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
| `videoTilingOptions.js` | `VIDEO_TILING_OPTIONS` (the `<select>` rows) + `VIDEO_TILING_ENUM_SET` (the value-only Set). Single source consumed by `VideoGen.jsx` and the Remix URL builder in `useMediaPreviewActions`. Mirrors the server's `z.enum` in `server/routes/videoGen.js`. |

## Graph & sim

| Module | Purpose |
|---|---|
| `graphSimulation.js` | 3D force simulation parameters for BrainGraph / CyberCity. |

## Generic UI / collection utilities

| Module | Purpose |
|---|---|
| `clientErrorReporter.js` | `reportClientError({ type, error?, message?, ... })` — POSTs window.onerror + unhandledrejection events to `/api/client-errors` with throttle + dedup. Wired from `main.jsx`; never call directly from React components. |
| `clipboard.js` | `copyToClipboard`, `writeClipboardSilently`, `readClipboard` — safe across insecure-origin contexts. Use these instead of `navigator.clipboard.writeText` inline. |
| `genUtils.js` | Shared bits between Image Gen and Video Gen pages. |
| `joinInfluenceList.js` | Mirror of `joinInfluenceList` in server universe builder. |
| `loopbackHost.js` | `isLoopbackHost(host)` / `isLoopbackOrigin()` / `describeMicAvailability()` — Secure Context / loopback-origin heuristics. Use these in any new mic, clipboard, or `getUserMedia`-gated surface; matches the full `127.0.0.0/8` range, IPv6 `::1`, and the browser-bracketed `[::1]` form. |
| `mediaNavigation.js` | `getAdjacentMedia(items, item)` — prev/next computation for lightboxes. |
| `sameJsonShape.js` | `sameJsonShape(prev, next)` — JSON.stringify-based equality for `useAutoRefetch`'s `compare` option on small, deterministically-shaped poll payloads. |
| `unsorted.js` | Synthetic "Unsorted" collection from media not filed in any real collection. |
| `upsertByIdPrepend.js` | Newest-first upsert into an id-keyed list. |
| `voiceLabel.js` | `formatVoiceLabel(v, engine?)` — display label for a TTS voice record. Engine-specific formatters plug into a lookup table; new engines extend that map. |

## Page-scoped pure helpers

| Module | Purpose |
|---|---|
| `universeBuilderExpand.js` | `mergeExpandIntoDraft(draft, result)` — pure merge of a Universe Builder draft with the LLM expand-API response (lock honoring, category/sheet merge with `kind` precedence, canon dedupe by name/slugline/alias). Also exports `mergeVariations`, `mergeCanonByName`, and `extractPreservedFromDraft` for callers that need the building blocks (per-category Generate, save-time refetch+merge). |
