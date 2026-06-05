# Issue #842 — Writers Room ↔ Creative Director bridge (Phase 5, slice 3)

## Context

Writers Room Phase 5 ("realtime Creative Director feedback") shipped two of three slices: **live continuation** (PR #837 — inline beat/prose/dialogue options from cursor context) and **live render previews** (#841). This is the **third and final slice** (#842): from the cursor context, let the Creative Director propose *next beats, alternate scenes, and visual treatments* — and **bridge those into actual Creative Director state** (a CD project's `treatment.scenes` + project `styleSpec`), not just inline prose.

Unlike the shipped `writers-room-continue` stage (which returns inline prose), this produces a **CD treatment proposal** the writer reviews and sends into Creative Director. It reuses the established WR→downstream bridge model (`promoteToPipeline` + `linkToPipeline` + an "Open in pipeline" CTA) rather than inventing new linkage, and reuses the CD orchestration helpers/store rather than duplicating CD logic — exactly as the issue requests.

**Confirmed design decisions (asked + answered):**
- **Injection:** create a NEW CD project seeded with the proposal (non-destructive), recording a `cdProjectId` link on the WR manifest with an "Open in Creative Director" CTA. Mirrors `promoteToPipeline`. (Reusing/clobbering one linked project was rejected — it fights `setTreatment`'s whole-treatment-replace semantics.)
- **Budget:** the bridge's LLM proposal call draws on the **existing** `dailyCallBudget` / `usage` text-suggest counter (both are text calls) — no new budget field/migration.

## Approach

A two-step flow mirroring the continuation slice's shape: **(1) suggest** (LLM, budget-gated) returns a reviewable proposal; **(2) send** (no LLM) creates a CD project from the proposal and links it.

### Server

**1. Prompt stage** — `data.reference/prompts/stages/writers-room-cd-bridge.md` (new)
- Sibling of `writers-room-continue.md`. Same cursor-context variables (`work`, `before`, `after`, `selection`, `returnsJson`).
- Task: propose a Creative Director **treatment** from the cursor context — a logline, short synopsis, **2–6 scenes** (each: `intent` = the beat/alternate-scene direction, `prompt` = a visual/cinematic shot description, `durationSeconds` 1–10), plus a `styleSpec` (the overall **visual treatment**: palette, mood, cinematography). Output contract is strict JSON: `{ logline, synopsis, styleSpec, scenes: [{ intent, prompt, durationSeconds }] }`.

**2. stage-config** — add `writers-room-cd-bridge` entry to `data.reference/prompts/stage-config.json` (model `quick`, `returnsJson: true`, `variables: []`), matching the `writers-room-continue` entry.

**3. Migration** — `scripts/migrations/071-writers-room-cd-bridge-prompt.js` (+ `.test.js`)
- Seed-only copy + stage-config merge, **byte-for-byte mirror of `065-writers-room-continue-prompt.js`** (FIRST-SHIPMENT SEED ONLY, no MD5 hashing). `data/` is gitignored, so the new stage must ship via `data.reference/` AND be seeded into existing installs that `pull + pm2 restart` without re-running `setup-data.js`. (Note: `070-` is already used twice; this takes `071-`.)

**4. Service** — `server/services/writersRoom/liveDirector.js` (extend)
- `suggestCdBridge(workId, { before, after, selection })`: reuse `assertLiveBudget(live, { usage: live.usage, budget: live.dailyCallBudget, label: 'suggestion' })` (same gate as `suggestContinuation`), require some cursor prose, `runStagedLLM('writers-room-cd-bridge', …)`, shape the proposal (clamp scenes 2–6, coerce `durationSeconds` into 1–10, trim strings), charge budget via `recordLiveModeUsage`. Returns `{ proposal, usage, budget }`.
- `sendToCreativeDirector(workId, { proposal })`: no LLM/budget. `createProject(...)` (from `creativeDirector/local.js`) with `name = work.title`, `styleSpec = proposal.styleSpec`, and CD render defaults (aspectRatio/quality/modelId/targetDurationSeconds — reuse the CD New-Project defaults from `creativeDirectorPresets.js`); then `setTreatment(project.id, { logline, synopsis, scenes })` where the service assigns each scene a `sceneId` (`randomUUID`), `order` (index), and `useContinuationFromPrior: false` to satisfy `creativeDirectorSceneSchema`. Finally `linkToCreativeDirector(workId, { projectId: project.id })`. Returns `{ project }`. Wrap create→treatment→link in try/catch with `deleteProject` rollback on failure (mirrors `promoteToPipeline`'s orphan-cleanup rationale — multi-step write, re-throw after cleanup).

**5. Manifest link** — `server/services/writersRoom/local.js` (extend)
- `linkToCreativeDirector(id, { projectId = null })`: set `cdProjectId` on the manifest (mirror of `linkToPipeline`; not user-editable, so it lives outside `updateWork`). `updateWork`'s `allowed` list already excludes it, so a crafted PATCH can't set it.

**6. Validation** — `server/lib/validation.js` (extend)
- `writersRoomCdBridgeSuggestSchema`: identical to `writersRoomLiveSuggestSchema` (before/after/selection, same caps, `.strict()`).
- `writersRoomCdBridgeSendSchema`: the reviewed proposal — `{ logline (1–500), synopsis (1–5000), styleSpec (max 5000 default ''), scenes: array(2..?).of({ intent 1–1000, prompt 1–8000, durationSeconds 1–10 }).min(1).max(120) }`, `.strict()`. Caps align with `creativeDirectorTreatmentSchema` so `setTreatment` won't 400 after the gate passes.

**7. Routes** — `server/routes/writersRoom.js` (extend, in the Phase-5 live block)
- `POST /works/:id/cd-bridge/suggest` → `validateRequest(writersRoomCdBridgeSuggestSchema, …)` → `suggestCdBridge`. (409 live-off / 429 budget already mapped from the service's coded `ServerError`s.)
- `POST /works/:id/cd-bridge/send` → `validateRequest(writersRoomCdBridgeSendSchema, …)` → `sendToCreativeDirector`. No new route middleware; bubbles to centralized error handler (no try/catch in handlers).

### Client

**8. API** — `client/src/services/apiWritersRoom.js` (extend)
- `suggestWritersRoomCdBridge(workId, context, options)` and `sendWritersRoomCdBridge(workId, proposal, options)` — same shape as `suggestWritersRoomContinuation` (POST, `{ silent: true }` passthrough since the panel owns its error UI).

**9. Panel** — `client/src/components/writers-room/CdBridgePanel.jsx` (new)
- Modeled on `LiveContinuationPanel.jsx`: a presentation + fetch shell driven by a parent-supplied `getCursorContext`; **no timers** (manual "Propose treatment" button — this is a heavier, deliberate action, not a debounced-on-pause one). Same overlapping-call generation guard + `useMounted`, same inline 409/429 notices (not red toasts), same "N / budget left today" readout sourced from `liveMode.usage`/`dailyCallBudget` (shared text budget).
- Renders the proposal: logline, synopsis, visual-treatment (`styleSpec`) block, and the scene list (`intent` + `prompt` + duration). A **"Send to Creative Director"** button calls `sendWritersRoomCdBridge`; on success toasts, calls `onLinked?.(projectId)` (parent updates manifest with `cdProjectId`), and navigates to the CD project route.

**10. Editor wiring** — `client/src/components/writers-room/WorkEditor.jsx` (extend)
- Render `<CdBridgePanel>` in the live-mode sidebar block alongside `LiveRenderPanel`/`LiveContinuationPanel` (gated on `liveEnabled && viewMode === 'edit'`), passing `workId`, `liveMode`, `getCursorContext` (already defined), and an `onLinked` that optimistically sets `cdProjectId` via `onChange?.({ ...work, cdProjectId })`.
- Add an **"Open in Creative Director"** overflow-menu item (icon `ExternalLink`) shown when `work.cdProjectId` is set — mirrors the existing "Open in pipeline" item; navigates to the CD project route. (Verify the exact client route for a CD project detail page — `apiCreativeDirector` uses `/creative-director`; confirm the React route, expected `/creative-director/:id`, before wiring nav.)

### Docs + changelog
- `docs/features/writers-room.md`: flip the two "*(planned)*" CD-bridge lines + the "**Still planned**" paragraph to shipped, with a short description of the bridge (matches the live-continuation write-up's tone).
- `.changelog/NEXT.md`: user-facing entry, slug-bracketed: `**[issue-842] Send a draft into Creative Director from the editor** — …`.

## Files

- New: `data.reference/prompts/stages/writers-room-cd-bridge.md`, `scripts/migrations/071-writers-room-cd-bridge-prompt.js` (+ test), `client/src/components/writers-room/CdBridgePanel.jsx`
- Edit: `data.reference/prompts/stage-config.json`, `server/services/writersRoom/liveDirector.js`, `server/services/writersRoom/local.js`, `server/lib/validation.js`, `server/routes/writersRoom.js`, `client/src/services/apiWritersRoom.js`, `client/src/components/writers-room/WorkEditor.jsx`, `docs/features/writers-room.md`, `.changelog/NEXT.md`

## Reuse (do not re-implement)
- `assertLiveBudget`, `recordLiveModeUsage`, `resolveLiveMode`, `utcDayKey`, `ERR_LIVE_MODE_OFF`/`ERR_BUDGET_EXCEEDED` — `liveDirector.js` / `local.js`
- `createProject`, `setTreatment`, `deleteProject` — `creativeDirector/local.js`
- `creativeDirectorTreatmentSchema`, `creativeDirectorSceneSchema`, `writersRoomLiveSuggestSchema` — `validation.js`
- `linkToPipeline` / "Open in pipeline" / `promoteToPipeline` rollback pattern — bridge precedent
- `LiveContinuationPanel.jsx` generation-guard + inline-notice pattern; `useMounted`
- Migration `065-writers-room-continue-prompt.js` — exact seed-migration template

## Verification
- `cd server && npm test -- liveDirector` and `-- validation` / `-- writersRoom` (route + service); add cases: suggest charges budget + 409/429 gating reuses text counter; send creates project + sets treatment + links manifest + rolls back on `setTreatment` failure.
- `cd server && npm test -- migrations` (or run the 071 test) — seeds when missing, no-ops when present.
- Barrel/README invariants: no new `server/lib` or `client/src/lib` modules added, so `index.test.js` is unaffected; confirm.
- Manual: enable Live mode on a work, place cursor in prose, "Propose treatment" → review → "Send to Creative Director" → lands on a new CD project with the treatment scenes + styleSpec; the work menu now shows "Open in Creative Director". Confirm budget readout decrements and the shared text-suggest counter is the one charged.
