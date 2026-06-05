# Custom Scheduled App Tasks

## Context

The user wants to create **custom scheduled tasks per managed app**: provide a free-form
prompt + a schedule (interval or cron), scoped to one app, running through the CoS
(Chief of Staff) agent system — just like the built-in per-app scheduled tasks, but
user-authored rather than chosen from the fixed catalog.

PortOS already has two relevant systems:

1. **Built-in task types** (`DEFAULT_TASK_INTERVALS` in `server/services/taskSchedule.js`) —
   a fixed catalog (security, code-quality, plan-task, …) with per-app enable/interval
   overrides surfaced in `/apps/{appId}/automation`. These cannot host arbitrary user prompts.
2. **Autonomous jobs** (`server/services/autonomousJobs/`, `cosJobScheduler.js`, the CoS
   "System Tasks" / Jobs tab) — already does exactly **"custom prompt + schedule → spawn a
   CoS agent"**, with full interval+cron scheduling, autonomy levels, gates, and the
   spawning-guard machinery. **It is just not app-scoped** — a job has no `appId`, so its
   agent runs in the PortOS root instead of a target app's repo.

**Approach (verified):** Add an optional `appId` (and optional git-workflow `taskMetadata`)
to autonomous jobs. When `appId` is set, the generated CoS task carries `metadata.app = appId`,
which the *existing* spawn path (`prepareAgentWorkspace` → `getAppWorkspace`) already resolves
to `app.repoPath`. This reuses the entire built-in workspace/JIRA/worktree pipeline — no new
scheduler, no new store, no migration. Surface it as a **"Custom Tasks" section in the per-app
Automation tab**, with optional worktree/PR/simplify toggles so a custom task can do isolated
work and open a PR in the target app.

This is backward/forward compatible per the CLAUDE.md distribution model: `appId` absent =
global job = today's behavior. No on-disk migration required.

## Verified payoff chain (no change needed here)

- `server/services/agentWorkspacePrep.js:50` — `prepareAgentWorkspace` sets
  `workspacePath = getAppWorkspace(task.metadata.app)` when present, else ROOT_DIR.
- `server/services/agentPromptBuilder.js:~955` — `getAppWorkspace(appName)` resolves by id
  **or** name from `data/apps.json`, returns `app.repoPath || ROOT_DIR`.
- `getAppDataForTask(task)` (~977) reads `task.metadata.app` for JIRA context.
- `server/services/cosTaskStore.js` `addTask` maps `taskData.app → metadata.app`, and also
  `useWorktree/openPR/simplify/reviewLoop` flags (lines ~159–179). So both the scheduled and
  manual-trigger paths can carry app + git-workflow options.
- `agentWorkspacePrep.js:60-61` — `useWorktree`/`openPR` on `task.metadata` drive worktree
  isolation + PR. Setting these in the generated task is sufficient.

## Server changes

### 1. Job model + CRUD — `server/services/autonomousJobs/crud.js`
- `createJob` job object: add `appId: jobData.appId || null` and
  `taskMetadata: jobData.taskMetadata || null`.
- `updateJob` `updatableFields` allow-list: add `'appId'` and `'taskMetadata'`.

### 2. Task generation — `server/services/autonomousJobs/skillTemplates.js` (`generateTaskFromJob`, ~line 144)
Thread app + git options into the task metadata so the spawn path picks them up:
```js
metadata: {
  autonomousJob: true,
  jobId: job.id, jobName: job.name, jobCategory: job.category,
  autonomyLevel: job.autonomyLevel,
  ...(job.appId ? { app: job.appId } : {}),
  ...(job.taskMetadata?.useWorktree != null ? { useWorktree: job.taskMetadata.useWorktree } : {}),
  ...(job.taskMetadata?.openPR != null ? { openPR: job.taskMetadata.openPR } : {}),
  ...(job.taskMetadata?.simplify != null ? { simplify: job.taskMetadata.simplify } : {}),
}
```

### 3. Validation — `server/lib/validation.js` (`createCosJobSchema`, line 713)
Add (tolerating UI `''` sentinels, mirroring the existing `triggerAction` preprocess):
```js
appId: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
taskMetadata: z.object({
  useWorktree: z.boolean().optional(),
  openPR: z.boolean().optional(),
  simplify: z.boolean().optional(),
}).optional(),
```
`updateCosJobSchema` inherits both via `.partial()`.

### 4. Routes — `server/routes/cosJobRoutes.js`
- **POST `/jobs`** (~line 75) and **PUT `/jobs/:id`** (~line 112): add `appId` and
  `taskMetadata` to the destructured fields and pass them into `createJob`/`updateJob`.
- **CRITICAL GOTCHA — manual trigger** (`POST /jobs/:id/trigger`, ~line 177): it currently
  calls `cos.addTask({ description, priority, context, approvalRequired }, 'internal')` and
  **drops `task.metadata`**, so a manually-triggered app-scoped job would run in ROOT_DIR.
  Forward the app + git options:
  ```js
  const taskResult = await cos.addTask({
    description: task.description,
    priority: task.priority,
    context: `Manually triggered autonomous job: ${job.name}`,
    approvalRequired: false,
    app: task.metadata?.app,
    useWorktree: task.metadata?.useWorktree,
    openPR: task.metadata?.openPR,
    simplify: task.metadata?.simplify,
  }, 'internal');
  ```
  (The scheduled path is unaffected — it emits the full task object via `task:ready`.)

### 5. No migration / no JOB_ADDITIVE_FIELDS change
The `defaults.js` restart-merge only touches jobs whose IDs match shipped `DEFAULT_JOBS`; a
user job's `appId`/`taskMetadata` persists on its own through `saveJobs`. Absent `appId` =
global = current behavior, so no `scripts/migrations/` entry is needed.

## Client changes

### Primary — per-app "Custom Tasks" section in `client/src/components/apps/tabs/AutomationTab.jsx`
Route already exists: `/apps/{appId}/automation`. Add a section below the existing
"Task Type Overrides":
- Fetch `api.getCosJobs()` and filter to `jobs.filter(j => j.appId === appId)`.
- Render each as a compact card (name, schedule summary via `describeCron`/interval label,
  enabled toggle, Run-now, edit, delete) — reuse the patterns already in
  `client/src/components/cos/tabs/JobsTab.jsx` (`JobCard`, `ScheduleFields`, `normalizeJobPayload`,
  `formatNextDue`). Consider extracting the shared form bits into
  `client/src/components/cos/JobForm.jsx` to avoid duplication, or import the existing helpers.
- Create/edit form fields: name, description, prompt template, schedule (interval/cron via
  existing `ScheduleFields` + `cronHelpers`), priority, autonomy level, and the new
  worktree/PR/simplify toggles (reuse `AGENT_OPTIONS` / `agentOptionButtonClass` from
  `client/src/components/cos/constants.js` for visual consistency with built-in overrides).
- On save: force `type: 'agent'` and `appId` to this app; send `taskMetadata` for the toggles.
  `apiAgents.js` `createCosJob`/`updateCosJob` already accept arbitrary payloads — no signature
  change required, but confirm they forward the body verbatim.

### Secondary — app badge/picker in the global `JobsTab.jsx`
- Add an optional **app picker** to the global create/edit forms (populate via
  `apiApps.getApps()` from `client/src/services/apiApps.js`); blank = global job.
- Show an **app badge** on each `JobCard` when `job.appId` is set (resolve id → name).
- This keeps every custom task centrally visible/manageable in CoS → System Tasks, while the
  per-app tab is the discovery surface.

### API client — `client/src/services/apiAgents.js`
No new endpoints. Verify `createCosJob`/`updateCosJob` pass the full payload (including `appId`,
`taskMetadata`) through `request()`; add fields to any payload-whitelisting if present.

## Prompt / app context note
A raw `promptTemplate` is not run through `{appName}`/`{repoPath}` templating, but correctness
holds: the agent's cwd **is** `app.repoPath` (so the CLI provider loads that repo's CLAUDE.md),
and `buildTaskBlock` already adds a `**Target App**` line from `metadata.app`. Optional polish:
resolve the app id to its display name in that line.

## Gotchas / guardrails (already correct)
- `state.config.autonomousJobsEnabled` and the per-domain CoS autonomy gate
  (`cosJobScheduler.js:170,185`) already apply to all scheduled jobs, including app-scoped — desired.
- Duplicate-spawn guards (`spawningJobIds`) and capacity checks already cover these jobs.
- `metadata.app` duplicate-detection in `addTask` is scoped per app, so two apps' custom tasks
  with similar prompts won't collide.

## Tests
- **`server/services/autonomousJobs.test.js`**: `appId` + `taskMetadata` persisted on create;
  settable/clearable via update; `generateTaskFromJob` sets `metadata.app` (and worktree/PR flags)
  when `appId`/`taskMetadata` present, omits them otherwise. Extend the existing describe block.
  Follow the project rule: record-creating tests must `mockNoPeers()` + `mockNoPeerSync()` if they
  touch app create paths — but these tests operate on the jobs store, not universes/series, so
  verify whether peer mocking is needed (likely not; jobs store has no peer fan-out).
- **`server/routes/cosJobRoutes.test.js`**: POST/PUT accept `appId` + `taskMetadata`; `'' → undefined`;
  manual **trigger** forwards `app`/`useWorktree`/`openPR` into the `addTask` call (assert via mock).
- **Client**: a `JobsTab`/`AutomationTab` Vitest covering the app filter + create payload shape
  (`type:'agent'`, `appId` set) if a matching test harness exists.

## Catalog / barrel / README
No new public module in `server/lib/`, `client/src/lib/`, `client/src/hooks/`,
`client/src/utils/`, or a new `apiX.js` — so no barrel/README maintenance is triggered. If a
shared `JobForm.jsx` component is extracted under `client/src/components/cos/`, that's a
component (not a catalogued lib), so no index/README update is required.

## Verification (end-to-end)
1. `cd server && npm test` — new job appId/taskMetadata + route tests pass; existing job tests green.
2. `cd client && npm test` — any new component test passes; build the client.
3. Manual: `npm run dev`, open `/apps/{appId}/automation`, create a custom task (e.g. prompt
   "Update the README badges", cron `0 9 * * 1`, worktree+PR on), enable it, click **Run now**.
   Confirm in CoS → Agents that the spawned agent's workspace is the app's `repoPath` (check the
   agent record's `workspacePath`/`sourceWorkspace`) and — with PR on — that an isolated worktree
   was created. Verify a scheduled fire also targets the app repo (temporarily set a near-future
   cron) and that toggling the global `autonomousJobsEnabled` off withholds it.
4. Confirm the task also appears (with an app badge) in the global CoS System Tasks tab.
