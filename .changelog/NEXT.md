# Unreleased

## Features

### Universe Builder

- **Other tab — manual trunk assignment.** Each bucket on the Other tab now has an **Assign to…** menu (Cast / Places / Objects) that retags `categories[bucket].kind` so the bucket moves out of Other into the matching trunk on next render. Variations stay in place; per-variation promote-to-canon remains a separate action.
- **Render tab — Other group + dedupe.** Removed the redundant "Prompt set" dropdown from the Batch render card — scope is now always chosen via the Render targets section below. Render targets gained an **Other** group with per-bucket sub-buttons and a `Bulk-render all (N)` button. Top-level action is now **Render everything (N)**.
- **Batch render — full Image Gen surface.** Batch Render now uses the shared `ImageGenSettingsForm`, so switching the backend chip (Local / External / Codex) reveals every per-mode option: model, resolution, steps, guidance/CFG, quantize, seed, **LoRAs**, **style preset**, negative prompt, and extra style. Server-side render schema accepts these as optional per-batch overrides and threads them through prompt composition + every enqueued job (`server/routes/universeBuilder.js` + `server/services/universeBuilder.js`).

### Media Gen

- **Removed duplicate Universe Builder tab.** The MediaGen tab strip no longer shows a Universe Builder entry — the Create sidebar already links straight to `/universe-builder`. Legacy `/media/universe-builder/*` URLs redirect to the top-level routes so bookmarks keep working.

## Changed

- **Universe Builder — starter idea is no longer capped at 4000 chars.** The starter idea is whatever the user wants to type, from a one-line pitch to a full treatment. The Zod-backed `STARTER_PROMPT_MAX` is raised to 200,000 chars (a sanity ceiling, not an artificial brevity constraint) and the textarea's `maxLength={4000}` attribute is removed.
- **Sidebar + ⌘K label shortened to "Universe".** The Create sidebar link and palette manifest entry for `/universe-builder` now read "Universe" instead of "Universe Builder"; voice/palette aliases still include `universe-builder` so old phrasings keep resolving.

## Refactors

- **CoS — explicit `init()` instead of module-level auto-init.** `server/services/cos.js` previously called `init()` at the bottom of the module, gated by `NODE_ENV !== 'test' && VITEST !== 'true'` so unit tests didn't spin up listeners/timers. The guard was a "test hack in the prod boot path" — `init` is now exported and called explicitly from `server/index.js` alongside `automationScheduler.init()` / `agentActionExecutor.init()` / etc. Test imports of `cos.js` no longer have side effects, and the prod boot path no longer branches on test-env vars.
- **`LoraPicker` extracted** (`client/src/components/imageGen/LoraPicker.jsx`). The LoRA multi-select previously inlined in `ImageGen.jsx` is now a shared component used by both the standalone Image Gen page and the Universe Builder batch-render form.
- **`ImageGenSettingsForm` extended** with `showLoras` + `showStylePreset` props (mounts `LoraPicker` / `StylePresetPicker`) and the previously-hidden CFG / quantize / model-defaults reset.
- **`getStylePresetById` helper** added to `server/lib/writersRoomStylePresets.js` — Map-backed O(1) lookup that replaces the hand-rolled `STYLE_PRESETS.find(...)` pattern.
- **`updateUniverse(id, patch, options)`** API client now passes options through to the underlying `request()` helper, enabling silent error mode.
- **`resolveProviderAndModel({providerId, model})`** added to `server/lib/promptRunner.js`. Collapses the 4 inlined `getProviderById/getActiveProvider/resolveEffectiveModel` chains in `universeBuilderExpand.js` (×2), `universeBuilderRefine.js`, and `universeBuilderPromote.js` onto one helper. The next caller is a one-import addition; the previous pattern was already drifting in error-handling specifics.
- **`findBibleEntryByName(list, name)`** added to `server/lib/storyBible.js` for the "match name OR aliases case-insensitively" predicate. Replaces the inlined `.find(...)` in `universeBuilderPromote.js`'s duplicate-collision check. (`foldRetiredCharactersBucket` keeps its O(1) `Set` index over normalized names+aliases — a per-iteration live-array lookup would be O(n*m) when folding a large retired bucket against a large canon.)
