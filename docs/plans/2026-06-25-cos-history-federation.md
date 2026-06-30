# Federate CoS completed-agent history across peers (issue #1650, partial ship)

## Context

Issue **#1650** is the last code child of epic **#1561** (full-sync federated node pairs). Today **none of `data/cos/` is in any sync category** — CoS agent history is fully machine-local. #1563 already shipped the safety prerequisites (instance provenance on every agent via `instanceId`, plus a task claim/lease protocol). #1650's remaining acceptance criterion is to **replicate completed-agent history archives so the CoS history UI mirrors on both machines**, gated behind full-sync peer mode (#1562) so a non-full-sync peer is unaffected.

Completed agents archive to `data/cos/agents/<YYYY-MM-DD>/<agentId>/` (`metadata.json`, `output.txt`, `prompt.txt`) with a type-level `data/cos/agents/index.json` (`server/services/cosAgents.js`). This is a **directory tree of immutable, append-only files** (an archive never changes after completion; agentIds are globally unique) — so it belongs on the **asset-federation pull path**, not the `dataSync.js` snapshot path, and needs **no merge** (byte replication + union).

**Scope decision (confirmed with user):** ship **history federation only** this PR. The issue's second deliverable — task-list + claim-metadata federation — needs a claim-aware per-task LWW merge of live-mutated markdown (a naive byte copy would clobber claims and re-introduce the double-spawn hazard) and is split to a **follow-up issue**. This PR therefore **Refs #1650 (not Closes)**; #1650 stays open for the task-merge piece; epic #1561 advances but is not closed.

## Reference implementation — mirror, don't invent

The **Writers Room draft-body federation** (`peerSync.js:2531-2598`) is the precise structural template: nested paths (not flat basenames), a dedicated manifest, a dedicated pull worker (`pullMissingWorkBodies` / `pullOneWorkBody`), sha256 integrity verification before write, and `peerDraftBodyManifestEntrySchema` (`peerSyncValidation.js:214`). The **media-library sweep** (`syncMediaLibraryFromPeer`, `peerSync.js:2868`) is the template for the receiver-side sweep loop: full-sync gate, re-entrancy guard, schema-ahead gentle-skip, diff → pull → re-diff, and **hash-withhold on partial** (`peerSync.js:2940-2948`). Reuse `fetchCappedAssetBuffer` (`peerSync.js:2488`), `inflightKey`/`inflightPulls`, `peerBaseUrl`, `peerFetch`, `atomicWrite`, `ensureDir`, `createHash`.

## Implementation

### 1. Sender — manifest builder (`server/services/sharing/peerSync.js`)
Add a CoS-history block mirroring the media-library block (after ~`peerSync.js:2828`):
- `buildCosHistoryManifest()` → `{ schemaVersion: PORTOS_SCHEMA_VERSIONS.cosHistory, manifestHash, entries }`. Walk `data/cos/agents/<date>/<agentId>/`, hashing each of `metadata.json` / `output.txt` / `prompt.txt` that exist. Entry shape: `{ date, agentId, file, sha256 }`. Skip the flat (running-agent) dirs and `index.json`; only date-bucketed completed archives. Sort entries deterministically (date, agentId, file) and `manifestHash = sha256` over `date:agentId:file:sha256` lines (mirrors `peerSync.js:2824`). Cap at a constant (e.g. `COS_HISTORY_MANIFEST_CAP = 100_000`) with a log on truncation (no silent caps).
- Segment patterns: `DATE_RE = /^\d{4}-\d{2}-\d{2}$/`, an agentId pattern, and a `file ∈ {metadata.json, output.txt, prompt.txt}` allowlist — used by both the builder and the byte route.

### 2. Sender — routes (`server/routes/peerSync.js`)
- `GET /api/peer-sync/cos-history-manifest` → `buildCosHistoryManifest()` (mirror `/library-manifest`, `peerSync.js:159`).
- `GET /api/peer-sync/cos-agent-archive?date=&agentId=&file=` → validate all three segments against the allowlists, resolve under `PATHS.cos/agents`, and `res.sendFile(absPath)` (sets content-length, which `fetchCappedAssetBuffer` requires). **Dedicated validated route, not a broadened static mount** — avoids exposing the whole `data/cos` tree (state.json, worktrees) and gives explicit path-segment validation (the "parse-not-existsSync" guard). 404 on missing/invalid.

### 3. Receiver — sweep + pull (`server/services/sharing/peerSync.js`)
- `syncCosHistoryFromPeer(peer)` — clone of `syncMediaLibraryFromPeer` (`peerSync.js:2868`): `peer.fullSync !== true` → skip; per-peer re-entrancy guard (`cosHistorySweepInFlight`); fetch manifest, Zod-validate, schema-ahead gentle-skip; unchanged-manifestHash short-circuit with `FORCE_REVALIDATE_EVERY`; `diffCosHistoryManifestAgainstLocal` → `pullMissingCosArchives` → re-diff; **withhold `lastCosHistoryManifestHash` on partial pull**.
- `diffCosHistoryManifestAgainstLocal(entries)` — re-validate every segment, resolve local path under `PATHS.cos/agents`, return entries whose local file is absent or hash-mismatched.
- `pullMissingCosArchives` / `pullOneCosArchiveFile` — clone of `pullMissingWorkBodies`/`pullOneWorkBody` (`peerSync.js:2538`): fetch via `fetchCappedAssetBuffer` (cap `COS_ARCHIVE_PULL_MAX_BYTES = 64 * 1024 * 1024`; log+skip oversized transcripts), verify bytes hash to advertised `sha256`, `ensureDir` + `atomicWrite` to `<date>/<agentId>/<file>`, emit `peerSyncEvents 'asset-arrived'`.
- After pulled files land, **merge the receiver's `index.json`** so the history UI lists them: add an exported `addAgentArchivesToIndex(pairs)` to `cosAgents.js` that updates the lazy `agentIndex` map (`cosAgents.js:22`) + persists via `saveAgentIndex` — call it through a dynamic import (mirror `reconcileMediaLibraryIndex`, `peerSync.js:2846`) to keep cosAgents out of peerSync's static graph. Union/merge, never overwrite.
- `syncCosHistoryWithAllPeers()` — clone of `syncMediaLibraryWithAllPeers` (`peerSync.js:2961`), filtering `fullSync && enabled` peers.

### 4. Periodic driver (`server/services/sharing/index.js`)
Call `syncCosHistoryWithAllPeers()` inside the existing 60s media-library `tick` (`sharing/index.js:42`) — one extra best-effort call, same try/catch boundary (PTY/timer boundary rule).

### 5. Schema version + coverage guards (`server/lib/schemaVersions.js`)
- Add `cosHistory: 1` to `PORTOS_SCHEMA_VERSIONS` (with the same explanatory comment style as `mediaLibrary`, `schemaVersions.js:334`).
- Add `'cosHistory'` to `NON_RECORD_SCHEMA_CATEGORIES` (`schemaVersions.js:400`) — it's a receiver-pull manifest, not a record push.
- **Per memory `project_new_schema_version_coverage_guards`: a new key trips 3 iteration guards.** Before pushing, grep + run all three: peerSync `NON_RECORD` coverage test, dataSync `OUT_OF_BAND` test, and the `schemaVersions` test. Add `cosHistory` to whichever allowlists those guards enumerate.

### 6. Validation schema (`server/lib/peerSyncValidation.js`)
- `peerCosHistoryManifestEntrySchema` (strict: `date` regex, `agentId` pattern, `file` enum, `sha256` hex64) and `peerCosHistoryManifestSchema = z.object({ schemaVersion, manifestHash, entries: z.array(...).max(100_000) }).strict()` — mirror `peerLibraryManifestSchema` (`peerSyncValidation.js:264`) and `peerDraftBodyManifestEntrySchema` (`:214`). Adding exports to an existing barreled file needs no README/barrel change.

## What stays machine-local (do NOT federate)
Live PTY buffers, in-flight `spawningTasks` Set, `pausedAgents` (`agentState.js`), worktree working dirs (`data/cos/worktrees/`), and `state.json` running-agent slots (`cosState.js`). Only the **date-bucketed completed archives** federate.

## Tests
- New `server/services/sharing/cosHistorySync.test.js` (or extend `peerSync.test.js`): `buildCosHistoryManifest` shape + deterministic hash; `syncCosHistoryFromPeer` skips a non-full-sync peer; schema-ahead gentle-skip; hash-withhold on partial pull; `diffCosHistoryManifestAgainstLocal` rejects path-traversal segments; index merge is a union.
- `server/routes/peerSync.test.js`: the two new routes (manifest shape; archive byte route validates segments + 404s on traversal/missing).
- Run the schemaVersions coverage trio (step 5).
- `cd server && npm test` for the affected suites.

## Verification (end-to-end)
- `cd server && npm test -- peerSync cosHistory schemaVersions peerSyncValidation` — all green.
- Manual two-instance check (described in #1650 acceptance): on peer A (full-sync ↔ B) let a CoS agent complete; within ~60s the archive + index entry appear on B and the agent shows in B's CoS history UI; confirm a **non**-full-sync peer pulls nothing.

## Disposition (Phase 5–7)
- Changelog: `.changelog/NEXT.md` under a **`## Federation`** heading — user-facing line, lead with `[issue-1650]`.
- PR body: **`Refs #1650`** (partial), and **file a follow-up issue** (label `plan`, `Part of #1561`) for task-list + claim-metadata federation, referenced as plain `#<n>`.
- Ship via `/do:pr --no-merge --review-with=claude,codex,ollama`; gate the merge on a `clean` aggregate status; `--merge` (rebase) per saved default.
- Leave #1650 **open**; after merge, re-evaluate epic #1561 (still `epic-open` — 1563 open, 1650 open).
