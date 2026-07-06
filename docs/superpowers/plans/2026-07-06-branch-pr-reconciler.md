# Branch & PR Reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily, opt-in CoS automation that reconciles this machine's unfinished git work — deterministically cleaning up merged/orphaned local branches + worktrees, and dispatching one coordinator CoS agent (which orchestrates one sub-agent per branch) to finish in-flight PRs — while never touching a federated peer's branches.

**Architecture:** Two tiers. Tier 1 is a pure classifier + deterministic cleanup in `branchReconcile.js` (no LLM). Tier 2 is a scheduler (`branchReconcileScheduler.js`, `eventScheduler` cron, `backupScheduler.js` pattern) that runs Tier 1 then, if in-flight branches remain, enqueues a single coordinator CoS task via `cosTaskStore.addTask`. Ownership is scoped by local-branch existence (`refs/heads/`), so peer branches (`origin/*` only) are structurally invisible.

**Tech Stack:** Node/Express, existing `server/services/git.js` + `github.js` (`execGh`) + `eventScheduler.js` + `cosTaskStore.js`, Zod validation, Vitest.

## Global Constraints

- No try/catch except at non-request boundaries (scheduler handlers, child-process callbacks) — those wrap + log emoji-prefixed `console.error`.
- Functional style, no classes. DRY/YAGNI.
- Single-line emoji logging with interpolated values.
- Ownership discriminator: **local branch must exist in `refs/heads/`**; never author-filter. Always exclude `main`, `master`, `release`, and the resolved default branch.
- Cleanup deletes a branch ONLY when `isBranchMergedInto(default)` is true AND its worktree is clean; use `git branch -d` (never `-D`).
- New settings key ships a default in `data.reference/settings.json`; Zod schema tolerant of absence; `enabled: false` by default (no cold-bootstrap LLM calls).
- New public modules re-exported from the same-dir `index.js` barrel + one README row.

---

### Task 1: Pure branch classifier

**Files:**
- Create: `server/services/branchReconcile.js`
- Test: `server/services/branchReconcile.test.js`

**Interfaces:**
- Produces:
  - `PROTECTED_BRANCHES: string[]`
  - `classifyBranch(input) => state` where `input = { branch, hasUpstream, isMerged, hasWorktree, worktreeDirty, openPr }` (`openPr` = `{ number, mergeable, isDraft }` | null) and `state ∈ 'MERGED' | 'CONFLICTED' | 'IN_REVIEW' | 'NEEDS_PR' | 'WIP'`.
  - `classifyBranches(inputs[]) => { branch, state, openPr }[]`

Classification order (first match wins):
1. `isMerged` → `MERGED`
2. `openPr && openPr.mergeable === 'CONFLICTING'` → `CONFLICTED`
3. `openPr` (any other mergeable value) → `IN_REVIEW`
4. `hasUpstream && !worktreeDirty` (pushed, not merged, no PR, clean) → `NEEDS_PR`
5. else (`!hasUpstream` or `worktreeDirty`) → `WIP`

- [ ] **Step 1: Write failing tests** covering each state + precedence (merged-with-open-PR still `MERGED`; dirty pushed branch → `WIP`; conflicting PR → `CONFLICTED`).
- [ ] **Step 2: Run** `cd server && npx vitest run services/branchReconcile.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `PROTECTED_BRANCHES`, `classifyBranch`, `classifyBranches` per the table.
- [ ] **Step 4: Run** tests → PASS.
- [ ] **Step 5: Commit** `feat: add branch reconcile classifier`.

### Task 2: Branch-state gathering + deterministic cleanup

**Files:**
- Modify: `server/services/branchReconcile.js`
- Test: `server/services/branchReconcile.test.js`

**Interfaces:**
- Consumes: `git.js` (`getDefaultBranch`, `isBranchMergedInto`, `deleteBranch`), `github.js` `execGh`, `worktreeManager.js` (`listWorktrees`, `forceRemoveWorktreeDir`).
- Produces:
  - `gatherBranchState(repoPath, { defaultBranch }) => inputs[]` — enumerates `refs/heads/` (via `git for-each-ref` porcelain through git.js helper or a local `runGit`), worktrees, merged status, open PRs (`execGh pr list --json number,headRefName,mergeable,isDraft`), and per-worktree dirtiness. Excludes protected branches.
  - `cleanupMerged(repoPath, merged[]) => { cleaned: string[], skipped: {branch,reason}[] }` — for each `MERGED` branch: re-verify `isBranchMergedInto`; if a worktree exists and is clean, `git worktree remove --force` + prune, then `deleteBranch(local:true)`; skip (with reason) if unmerged-on-recheck or dirty.
  - `reconcile(repoPath) => { cleaned, inFlight, wip, skipped }` — gather → classify → cleanupMerged(MERGED) → returns inFlight (`CONFLICTED|IN_REVIEW|NEEDS_PR` with their `openPr`/state) and wip lists.

- [ ] **Step 1: Write failing tests** for `cleanupMerged` safety gates with mocked git/worktree: (a) merged+clean → cleaned; (b) merged-but-recheck-unmerged → skipped `not-merged`; (c) merged+dirty-worktree → skipped `dirty`. And `reconcile` end-to-end with a mocked `gatherBranchState`.
- [ ] **Step 2: Run** vitest → FAIL.
- [ ] **Step 3: Implement** `gatherBranchState`, `cleanupMerged`, `reconcile`.
- [ ] **Step 4: Run** tests → PASS.
- [ ] **Step 5: Commit** `feat: add branch reconcile gather + deterministic cleanup`.

### Task 3: Settings schema + defaults

**Files:**
- Modify: `server/lib/validation.js` (add `branchReconcileConfigSchema`, wire into settings PUT slice)
- Modify: `data.reference/settings.json` (add default `branchReconcile` block)
- Test: `server/lib/validation.test.js` (or nearest settings-schema test)

**Interfaces:**
- Produces: `branchReconcileConfigSchema = z.object({ enabled: z.boolean(), cron: z.string(), actions: optionalBooleanMap(['cleanupMerged','openPr','resolveConflicts','autoMerge']) }).partial()`.

Default block:
```json
"branchReconcile": {
  "enabled": false,
  "cron": "0 3 * * *",
  "actions": { "cleanupMerged": true, "openPr": true, "resolveConflicts": true, "autoMerge": true }
}
```

- [ ] **Step 1: Write failing test** asserting the schema accepts the default block and rejects a non-boolean `enabled`.
- [ ] **Step 2: Run** vitest → FAIL.
- [ ] **Step 3: Implement** schema + `settings.json` slice validation (mirror `backupConfigSchema.partial()` in `routes/settings.js`) + seed default.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add branchReconcile settings schema + default`.

### Task 4: Coordinator prompt template + prompt builder

**Files:**
- Create: `data.reference/prompts/branch-reconcile-coordinator.md`
- Modify: `server/services/branchReconcileScheduler.js` (add `formatInFlightForPrompt`, `buildCoordinatorTask`)
- Test: `server/services/branchReconcileScheduler.test.js`

**Interfaces:**
- Produces:
  - `formatInFlightForPrompt(inFlight, { defaultBranch }) => string` — one block per branch: name, worktree path, state, PR number/url, desired end-state.
  - `buildCoordinatorTask(inFlight, { repoPath, defaultBranch, actions }) => taskObject` — reads the template, injects `{inFlightData}`, returns `{ id: 'sys-branch-reconcile-<base36>', description, priority:'LOW', priorityValue, metadata:{ taskApp:'_self', context, useWorktree:false } }` (multi-line body in `metadata.context`, first line in `description`, per the cosTaskStore round-trip rule).

Prompt template instructs: for each branch, per state — `NEEDS_PR`: verify complete/ready then `/do:pr`, else report incomplete; `CONFLICTED`: rebase onto `{defaultBranch}`, resolve, push; `IN_REVIEW`: run review loop; auto-merge only when `MERGEABLE` + CI green + **latest** Copilot review "0 comments" (pre-resolved threads don't count; ≥20k-line PRs exempt from Copilot gate). Respect each action toggle. Spawn one sub-agent per branch.

- [ ] **Step 1: Write failing tests** for `formatInFlightForPrompt` (renders each state) and `buildCoordinatorTask` (multi-line body lands in `metadata.context`, id prefix, `useWorktree:false`).
- [ ] **Step 2: Run** vitest → FAIL.
- [ ] **Step 3: Implement** template + both functions.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add branch reconcile coordinator prompt + task builder`.

### Task 5: Scheduler + run handler + dispatch

**Files:**
- Modify: `server/services/branchReconcileScheduler.js`
- Test: `server/services/branchReconcileScheduler.test.js`

**Interfaces:**
- Consumes: `eventScheduler` (`schedule`, `cancel`), `settings.js` `getSettings`, `branchReconcile.reconcile`, `cosTaskStore.addTask`, `cosState`/`cos.js` running check, `timezone`.
- Produces:
  - `runBranchReconcile() => summary` — re-reads settings; if `!enabled` return `{ skipped:'disabled' }`; resolve `repoPath` (PortOS root) + `defaultBranch`; call `reconcile()`; gate cleanup on `actions.cleanupMerged`; if `inFlight.length` and any agent-action enabled and CoS is running, `addTask(buildCoordinatorTask(...), 'internal', { raw:true })`; return `{ cleaned, inFlight, wip, skipped, dispatched }`. Logs single-line emoji summary. Wrapped in try/catch (non-request boundary).
  - `startBranchReconcileScheduler()` / `stopBranchReconcileScheduler()` — register/cancel cron id `branch-reconcile`, handler = `runBranchReconcile`.

- [ ] **Step 1: Write failing tests**: disabled → `{skipped:'disabled'}` and no reconcile call; enabled + inFlight + CoS running → `addTask` called once; `actions.cleanupMerged:false` → cleanup skipped. Mock `reconcile`, `getSettings`, `addTask`, CoS-running.
- [ ] **Step 2: Run** vitest → FAIL.
- [ ] **Step 3: Implement** the handler + start/stop.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add branch reconcile scheduler + dispatch`.

### Task 6: API route + boot registration + barrel/README

**Files:**
- Create: `server/routes/branchReconcile.js` (`POST /run`, `GET /status`)
- Modify: `server/index.js` (mount route + `startBranchReconcileScheduler().catch(...)`)
- Modify: route registry (wherever routes are mounted, e.g. `server/routes/index.js` or `server/index.js`)
- Modify: `server/services/README.md` (rows for the two new services) — no barrel for `services/` (it uses README only per convention); confirm.
- Test: `server/routes/branchReconcile.test.js`

**Interfaces:**
- `POST /api/branch-reconcile/run` → `runBranchReconcile()`; returns the summary JSON.
- `GET /api/branch-reconcile/status` → last-run summary (module-level `lastRun`).

- [ ] **Step 1: Write failing test** hitting `POST /run` (mock `runBranchReconcile`) asserting it returns the summary.
- [ ] **Step 2: Run** vitest → FAIL.
- [ ] **Step 3: Implement** route, mount it, add boot registration, add README rows.
- [ ] **Step 4: Run** full server suite `cd server && npm test` → PASS.
- [ ] **Step 5: Commit** `feat: add branch reconcile API + boot registration`.

### Task 7: Settings UI toggle + Run Now

**Files:**
- Modify: existing CoS scheduling settings component (locate via nav; add a "Branch & PR Reconciler" section)
- Create: `client/src/services/` wrapper method or reuse `api.js` for `POST /api/branch-reconcile/run`
- Test: client vitest for the new section (toggle renders, Run Now gated on saved-enabled)

**Interfaces:** toggle (`enabled`), cron input, four action checkboxes, "Run now" button gated on **saved** `enabled` (per "Run Now gates on saved state" rule) + disabled while dirty/saving. Shows last-run summary.

- [ ] **Step 1: Write failing client test** (Run Now disabled when form dirty).
- [ ] **Step 2: Run** `cd client && npx vitest run <file>` → FAIL.
- [ ] **Step 3: Implement** section + api wrapper.
- [ ] **Step 4: Run** client tests → PASS. Build check `cd client && npm run build`.
- [ ] **Step 5: Commit** `feat: add branch reconciler settings UI`.

---

## Self-Review

- **Spec coverage:** ownership (Task 1–2 local-branch enumeration), deterministic cleanup (Task 2), classifier states (Task 1), coordinator+sub-agents (Task 4–5), auto-merge gate (Task 4 prompt), settings/opt-in/default (Task 3), manual run (Task 6), daily cron (Task 3 default + Task 5), UI (Task 7), distribution seed (Task 3). ✓
- **Placeholders:** none — signatures + classification table + default JSON are concrete.
- **Type consistency:** `reconcile` returns `{ cleaned, inFlight, wip, skipped }` used identically by Task 5; `buildCoordinatorTask` consumes `inFlight` shape from Task 2; `classifyBranch` states reused verbatim in Task 4 prompt.
- **Deferred (append to PLAN.md if skipped):** per-branch in-flight re-entrancy marker across daily runs (rely on CoS `taskConflict` workspace collision initially); `GET /status` persistence across restart (module-level only).
