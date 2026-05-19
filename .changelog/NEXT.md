# Unreleased Changes

## Added

- **Delete affordance for character reference sheets.** New trash button on `CharacterReferenceSheetPanel` (inline `[Cancel] [Delete sheet]` confirm row) backed by `DELETE /api/universe-builder/:id/characters/:entryId/reference-sheet`. Server unlinks the PNG from `data/image-refs/` and eagerly purges every matching `referenceSheetImageRef` pointer across all universes via a new `purgeReferenceSheetFromAllUniverses(filename)` helper. Locked characters' sheets stay delete-protected (`UNIVERSE_CANON_LOCKED` 409, mirrors the renderer's lock guard).
- **Per-stage editorial locks on Pipeline issues.** Each `issue.stages.{id}` now carries a `locked` flag; locked stages refuse regeneration (text generate, image / video enqueue, refine, extract-scenes / extract-pages, audio extract / render, episode-video fresh start, cover-concepts commit). UI exposes a lock toggle on every Pipeline Issue tab and renders a per-stage Lock indicator on the TabPills strip, so users can freeze a finalized comic script while still iterating storyboards.
- **Per-field arc locks on series.** `series.locked.arcFields` is an opt-in sub-map (`{ logline, summary, themes, protagonistArc, shape }`); locked fields are preserved verbatim through `commitSeasonsWithRemap` so arc regenerate + auto-resolve only rewrite the unlocked fields. Inline lock icons on the Arc Canvas read view toggle each field.
- **Pagination on `GET /api/pipeline/series/:id/issues`.** Accepts optional `?offset=N&limit=N`; when present, returns `{ items, total, offset, limit }`. Without the params, the endpoint still returns the legacy raw array. Eliminates the silent 1000-issue cap for long-running series.
- **Zod validation across cos-task / loops / cos-job / cos-learning routes.** Replaces manual destructure-and-check with `safeParse` + `failValidation` for consistent 400 errors.

## Changed

- `/claim` slash command now hard-requires an isolated worktree with absolute paths, a single-Bash-invocation flow, and a `pwd` verification checkpoint — eliminates the failure mode where the claim branch was checked out in the main repo and blocked further parallel claims.
- `/claim` slash command accepts `--review-with=<copilot|codex|gemini|claude>` to pick the post-PR reviewer. Default `copilot` preserves the existing `/do:pr` Copilot loop; `codex`/`gemini`/`claude` skip the Copilot loop and drive an iterative CLI-based review against `gh pr diff` instead (CLIs invoked the same way the PortOS AI Toolkit drives them — `codex exec -`, `gemini -p`, `claude -p -`).
- Removed the CLAUDE.md "Worktrees" section that prohibited TUI worktrees; it conflicted with `/claim`'s explicit worktree requirement.
- **`atomicWrite` migration.** 10 services + 4 aiToolkit modules switched from inline `ensureDir + writeFile + JSON.stringify` to the `atomicWrite` helper (toolkit gets a self-contained copy at `server/lib/aiToolkit/internal/atomicWrite.js`). Prevents partial-write corruption on shared JSON state files.
- **AI Toolkit runner: PortOS-aware `deleteRun` override.** Now stops the live child process before deleting the run on disk (closes a zombie-process leak when an in-flight CLI run was deleted via the UI).

## Fixed

- **Shell-injection vector in `agentLifecycle.js:322`.** Replaced `execSync(\`git merge --ff-only origin/${defaultBranch}\`, ...)` with array-arg spawn-based git invocation (`shell: false`).
- **CVEs in server dependencies.** `basic-ftp` 5.3.0 → 6.0.1 (DoS via malicious FTP server, GHSA-rpmf-866q-6p89); `protobufjs` pinned to 7.5.9 (code injection / prototype pollution); plus transitive `ip-address`, `picomatch`, `postcss` patched via `overrides`.
- **`agentCliSpawning.js` stream handlers no longer crash the process.** stdout + stderr `async (data)` callbacks now wrap their bodies in try/catch (CLAUDE.md PTY/child-process rule). Stream-json output is batched via `appendAgentOutputLines` instead of per-line state writes.
- **`toolStateMachine.executions` Map capped at 1000** (previously orphaned on crash because eviction only ran via the success-path 60s timer).
- **Voice LM Studio fetch calls now use `AbortSignal.timeout(5000)`.** Prevents the voice pipeline from hanging when LM Studio accepts the TCP connection but stops responding mid-model-swap.
- **`exportByKind('series'|'universe', ids)` now parallelizes exports** via `Promise.all` (was serial `for…of`).
- **`agentTuiSpawning.js doneSentinelTimer`** no longer silently swallows `readFile` errors; setInterval body wrapped in try/catch.
- **`server/routes/agents.js`** validates `:pid` as a number before reaching `killProcess`/`getProcessInfo` (`Number.isNaN` guard → 400).
- **`client/src/components/Layout.jsx`** sidebar refetch failures now log instead of being silently swallowed.
- **Accessibility:** form labels in `VoiceTab`, `ProviderModelSelector`, `IconPicker`, `ImageGenTab`, `BackupTab`, `MortalLoomTab`, `BackupWidget` now have `htmlFor`/`id` pairing via `useId()`; icon-only buttons in `IconPicker` and `TaskAddForm` use `aria-label`.
- **`ImageGenTab` parallel-limit number input** no longer snaps to default on every keystroke; draft string state, clamp on blur.
- **NAV_COMMANDS manifest** registers `/city/settings` and `/ambient` so they are reachable from `⌘K` and voice.

## Removed

- **Series Bible "Visual style preset" + per-stage style override.** The curated catalog (`server/lib/visualStyles.js`: graphic-novel / cinematic / anime / etc.) and the `series.visualStyleDefault` + `issue.stages.*.visualStyleOverride` plumbing have been retired. Style now flows from a single source — the linked universe's `stylePrompt` plus the series-level `stylePromptOverride` with a new `stylePromptOverrideMode` toggle (`prepend` | `append` | `override`). The `VisualStylePicker` component, the three stage-component pickers, the `/api/pipeline/visual-styles` route, and `listPipelineVisualStyles` / `updateIssueStageVisualStyle` API helpers all gone. Migration `026-remove-visual-style-fields.js` strips the dead fields from `pipeline-series.json` + `pipeline-issues.json`.

## Changed (continued)

- **Series creation requires a universe in the UI.** The `New Series` form's universe picker is now required (submit disabled until one is picked); the bible's "Linked World" picker drops the `— None —` option. Server-side stays permissive so the importer / share-bucket sync can still land legacy orphan records — the UI is the gate, matching PortOS's single-user model.
