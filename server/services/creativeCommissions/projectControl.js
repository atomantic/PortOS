/**
 * Creative Commission → Creative Director project control.
 *
 * A commission fire mints a CD project and the advance loop drives it from there. Two
 * things the commission must still do to that work:
 *
 *   - **Stop it.** Pausing or deleting a commission cancels the cron, but projects already
 *     spawned keep re-dispatching and the orphan sweeps (boot + the 15-minute health check
 *     in cos.js) keep respawning their agent tasks. `stopCommissionProjects` runs the CD
 *     hard stop over everything the commission spawned.
 *
 *   - **Re-provider it.** The LLM pin is resolved at DISPATCH time (agentBridge →
 *     `commissionStagePin`), so an edit reaches every not-yet-dispatched stage. A task
 *     ALREADY handed to the runner has its provider frozen in its metadata and is respawned
 *     verbatim by the orphan sweep; `restartCommissionStages` retires exactly those.
 *
 * The link is `project.commissionId`, stamped at fire time. The run ledger is NOT the
 * link: it is capped at MAX_PERSISTED_RUNS, so a long-wedged project has fallen out of it,
 * and a project spawned indirectly (bridgeFromIssue) never enters it. It is still unioned
 * in for projects minted before the back-pointer existed.
 *
 * Runs OUTSIDE the Express request lifecycle (the store's `commission:changed` bus), so
 * no path throws out.
 */

import { commissionStore, sanitizeCommission, commissionEvents } from './store.js';
import { PROJECT_TERMINAL_STATUSES } from '../../lib/creativeDirectorPresets.js';

// The CD cognitive stages a commission's single pin drives. `evaluation` is absent: it is a
// vision API call, not a CoS agent, and a CLI/TUI pin would trip agentBridge's harness-boundary guard.
export const COMMISSION_PINNED_STAGES = ['treatment', 'plan'];

// Statuses in which the advance loop still drives a project, so a stage restart hands it
// straight back. A `paused` project keeps the fresh provider but is NOT auto-resumed.
const ADVANCING_PROJECT_STATUSES = new Set(['planning', 'rendering', 'stitching']);

/**
 * Read a commission by id INCLUDING a tombstoned one (the delete path runs after the
 * tombstone lands). Reads raw, not `getCommission`, so the federated feedback hydration
 * stays off event-bus handlers and agent dispatch.
 */
async function readCommission(id) {
  if (!id) return null;
  const raw = await commissionStore().readRaw(id, { includeDeleted: true }).catch(() => null);
  return raw ? sanitizeCommission(raw) : null;
}

/**
 * The commission's live `{ providerId, model }` pin for its CD cognitive stages, or
 * `null` to inherit the install's AI Assignment. Resolved at DISPATCH, so an edit reaches
 * work already in flight without rewriting any project record.
 *
 * A pin is unusable when its provider is api-type (trips agentBridge's harness-boundary
 * guard), removed, or DISABLED (the runner honors an explicit task pin without re-checking
 * `enabled`, which would defeat the disable control). The UI offers only enabled
 * agent-harness providers, but a REST write or later change can slip a bad pin past it. An
 * unusable pin is DROPPED so the stage falls back to the install default; an unresolvable
 * provider (toolkit hiccup) also falls back (fail open).
 */
export async function commissionStagePin(commissionId) {
  const commission = await readCommission(commissionId);
  const providerId = commission?.assignment?.providerId;
  if (!providerId) return null;
  const [{ getProviderById }, { PROVIDER_TYPES }] = await Promise.all([
    import('../providers.js'),
    import('../../lib/aiToolkit/constants.js'),
  ]);
  const provider = await getProviderById(providerId).catch(() => null);
  const isAgentHarness = provider?.type === PROVIDER_TYPES.CLI || provider?.type === PROVIDER_TYPES.TUI;
  if (!isAgentHarness || provider?.enabled === false) {
    const reason = !provider ? 'missing' : (!isAgentHarness ? `non-agent:${provider.type}` : 'disabled');
    console.warn(`⚠️ Creative commission ${commissionId} pins unusable provider '${providerId}' (${reason}) — falling back to the default CD assignment`);
    return null;
  }
  return { providerId, ...(commission.assignment.model ? { model: commission.assignment.model } : {}), ...(commission.assignment.effort ? { effort: commission.assignment.effort } : {}) };
}

/**
 * Distinct CD project ids named by a commission's run ledger, newest first. Pure. The
 * compatibility half of `commissionProjects`.
 */
export function ledgerProjectIds(commission) {
  const seen = new Set();
  const runs = Array.isArray(commission?.runs) ? commission.runs : [];
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const id = runs[i]?.projectId;
    if (typeof id === 'string' && id && !seen.has(id)) seen.add(id);
  }
  return [...seen];
}

/**
 * Every live, non-terminal project a commission owns: the authoritative `commissionId`
 * query unioned with the run ledger (pre-back-pointer projects).
 */
async function commissionProjects(commissionId, preread) {
  const { listProjectsByCommissionId, getProjectsByIds } = await import('../creativeDirector/local.js');
  const owned = await listProjectsByCommissionId(commissionId).catch(() => []);
    // The ledger fallback needs the record. Read it here rather than requiring every caller
    // to pass it, so pre-back-pointer projects are reachable on delete as well as pause.
  const commission = preread || await readCommission(commissionId);
  const known = new Set(owned.map((p) => p.id));
  const legacyIds = ledgerProjectIds(commission).filter((id) => !known.has(id));
  const legacy = legacyIds.length ? await getProjectsByIds(legacyIds).catch(() => []) : [];
  return [...owned, ...legacy].filter((p) => p && !PROJECT_TERMINAL_STATUSES.has(p.status));
}

/**
 * Retire the stages a commission's projects have ALREADY dispatched, so the next dispatch
 * uses the commission's current provider instead of the one frozen in the live task's
 * metadata, then hand each project back to the advance loop.
 *
 * Only LLM stages are torn down; a `plan-step` run is a tool dispatch (often a render
 * already burning GPU) unrelated to the LLM pin.
 *
 * @returns {Promise<{restarted: string[], checked: number}>}
 */
export async function restartCommissionStages(commissionId, commission) {
  const projects = await commissionProjects(commissionId, commission);
  if (!projects.length) return { restarted: [], checked: 0 };

  const [{ inflightRuns, retireRuns }, { advanceAfterPlanStepSettled }, { advanceAfterSceneSettled }] = await Promise.all([
    import('../creativeDirector/stopProject.js'),
    import('../creativeDirector/planAdvance.js'),
    import('../creativeDirector/completionHook.js'),
  ]);
    // Which advance loop owns a project depends on its shape, and BOTH shapes can carry a
    // commissionId: a fire mints a directive project, but a plan step's
    // `cd_produceVideoFromIssue` mints a legacy scene-loop teaser with the same back-pointer.
    // advanceAfterPlanStepSettled on a directive-less project silently no-ops (`!project.directive`),
    // leaving the retired stage wedged until a manual Resume. Same branch as recovery.js and
    // agentManagement.js#settleOrphanedCreativeDirectorRun.
  const advance = (project) => (project.directive
    ? advanceAfterPlanStepSettled(project.id)
    : advanceAfterSceneSettled(project.id));
  const reason = 'Creative commission provider changed';
  const restarted = [];
  for (const project of projects) {
    const stale = inflightRuns(project, COMMISSION_PINNED_STAGES);
    if (!stale.length) continue;
    await retireRuns(project.id, { runs: stale, reason })
      .catch((e) => console.error(`❌ Commission ${commissionId}: retire runs on ${project.id} failed: ${e.message}`));
    restarted.push(project.id);
    if (!ADVANCING_PROJECT_STATUSES.has(project.status)) continue;
    await advance(project)
      .catch((e) => console.error(`❌ Commission ${commissionId}: advance ${project.id} failed: ${e.message}`));
  }
  if (restarted.length) {
    console.log(`🎯 Commission ${commissionId} restarted ${restarted.length} in-flight stage(s) under its current provider`);
  }
  return { restarted, checked: projects.length };
}

/**
 * Hard-stop every project this commission spawned. Cancelling the cron stops FUTURE fires;
 * this stops running work (agent processes, CoS tasks, run rows, media jobs).
 *
 * Stopped projects are parked as `paused` with the reason, NOT deleted: outputs stay
 * browsable and the user can Resume an individual project.
 *
 * @returns {Promise<{stopped: string[], checked: number}>}
 */
export async function stopCommissionProjects(commissionId, { reason = 'Commission stopped', commission } = {}) {
  const projects = await commissionProjects(commissionId, commission);
  if (!projects.length) return { stopped: [], checked: 0 };

  const { stopProject } = await import('../creativeDirector/stopProject.js');
  const stopped = [];
  for (const project of projects) {
    const result = await stopProject(project.id, { reason, project })
      .catch((e) => { console.error(`❌ Commission ${commissionId}: stop ${project.id} failed: ${e.message}`); return null; });
    if (result?.stopped) stopped.push(project.id);
  }
  if (stopped.length) {
    console.log(`🛑 Commission ${commissionId} stopped ${stopped.length} in-flight project(s): ${reason}`);
  }
  return { stopped, checked: projects.length };
}

// A commission mutation that cannot change what in-flight work should be doing. `fields` is
// the patched key set, absent on emitters that don't report one, and absent must mean
// "reconcile" (irrelevance is unproven), never "skip".
const RECONCILABLE_FIELDS = ['enabled', 'assignment'];

/**
 * The `commission:changed` reconciler — the decision table for what a mutation does to
 * the work already spawned:
 *
 *   delete            → stop everything.
 *   update + disabled → stop everything (Pause means STOP).
 *   update + enabled  → restart already-dispatched stages so they pick up the
 *   restore             commission's current provider on re-dispatch.
 *   create            → nothing; nothing has spawned yet.
 *   merge (no id)     → nothing; a peer merge carries only the federated brief, never
 *                       the machine-local schedule/assignment/runs.
 *
 * Never throws — it runs on an EventEmitter callback, outside any request.
 */
export async function reconcileCommissionProjects({ id, action, fields } = {}) {
  if (!id || action === 'create') return { action: 'noop' };
  if (action === 'delete') {
    await stopCommissionProjects(id, { reason: 'Creative commission deleted' });
    return { action: 'stopped' };
  }
  if (Array.isArray(fields) && !fields.some((f) => RECONCILABLE_FIELDS.includes(f))) {
    return { action: 'noop' };
  }
  const commission = await readCommission(id);
  if (!commission) return { action: 'noop' };
    // Tombstoned but reached on some action other than 'delete' (a restore that lost the LWW,
    // a hand-fired event). Deleted outranks everything: don't re-dispatch work the user removed.
  if (commission.deleted) {
    await stopCommissionProjects(id, { reason: 'Creative commission deleted', commission });
    return { action: 'stopped' };
  }
  if (commission.enabled === false) {
    await stopCommissionProjects(id, { reason: 'Creative commission paused', commission });
    return { action: 'stopped' };
  }
  await restartCommissionStages(id, commission);
  return { action: 'restarted' };
}

/**
 * Subscribe the reconciler to every commission write. Lives here so the cron scheduler
 * stays about arming crons; called once at import by whoever pulls this into the boot graph.
 */
export function registerCommissionProjectReconciler() {
  commissionEvents.on('commission:changed', (change) => {
    reconcileCommissionProjects(change).catch((err) =>
      console.error(`❌ Creative commission project reconcile failed: ${err.message}`));
  });
}

/**
 * One-shot boot backfill for projects minted BEFORE the back-pointer existed. Reads the
 * commission's run ledger and, for each project it still names:
 *
 *   1. stamps `commissionId`, and
 *   2. CLEARS the `modelOverrides.{treatment,plan}` snapshot the old fire path wrote.
 *
 * Both are needed. Dispatch consults a commission only when the project names one (1), but
 * a per-project pin now outranks the commission's (it means "chosen in the models drawer")
 * and every pre-change project carries one purely because the fire wrote it, so without (2)
 * the stale snapshot would still win. We cannot distinguish a machine-written snapshot from
 * a drawer edit on a pre-change project; clearing honors the commission going forward and
 * the user can re-set an override that will now stick.
 *
 * The ledger is capped, so only what it still remembers is recovered; a fresh fire mints a
 * correctly-stamped project.
 *
 * A commission PAUSED or DELETED before the upgrade gets its newly-linked projects stopped
 * here: its event fired on a build with no reconciler, so nothing ever stopped that work.
 *
 * Pure data movement, no LLM (a stop kills processes and cancels renders), so compliant
 * with the no-cold-bootstrap-LLM rule. Idempotent: a project already carrying the
 * back-pointer is skipped. Best-effort: a failure leaves the install as it was.
 *
 * @returns {Promise<{stamped: number, stopped: number}>}
 */
export async function backfillProjectCommissionIds() {
  const ids = await commissionStore().listIds({ includeDeleted: true }).catch(() => []);
  if (!ids.length) return { stamped: 0, stopped: 0 };

  const { getProjectsByIds, updateProject } = await import('../creativeDirector/local.js');
  let stamped = 0;
  let stopped = 0;
  for (const commissionId of ids) {
    const commission = await readCommission(commissionId);
    const legacyIds = ledgerProjectIds(commission);
    if (!legacyIds.length) continue;
    const projects = await getProjectsByIds(legacyIds).catch(() => []);
    const linked = [];
    for (const project of projects) {
      if (!project || project.commissionId) continue;
      // Drop only the stages the old fire path owned; a hand-set `evaluation` pin
      // was never written by it, so it survives.
      const overrides = { ...(project.modelOverrides || {}) };
      for (const stage of COMMISSION_PINNED_STAGES) delete overrides[stage];
      const ok = await updateProject(project.id, { commissionId, modelOverrides: overrides })
        .then(() => true)
        .catch((e) => { console.error(`❌ Commission back-pointer backfill: ${project.id} failed: ${e.message}`); return false; });
      if (ok) { stamped += 1; linked.push(project); }
    }
        // A commission stopped BEFORE this build never had its work stopped (no reconciler when
        // its event fired). Catch up now or the projects we just linked keep retrying.
    if (!linked.length || (!commission.deleted && commission.enabled !== false)) continue;
    const { stopProject } = await import('../creativeDirector/stopProject.js');
    const reason = commission.deleted
      ? 'Creative commission deleted' : 'Creative commission paused';
    for (const project of linked) {
      if (PROJECT_TERMINAL_STATUSES.has(project.status)) continue;
      const result = await stopProject(project.id, { reason })
        .catch((e) => { console.error(`❌ Commission back-pointer backfill: stop ${project.id} failed: ${e.message}`); return null; });
      if (result?.stopped) stopped += 1;
    }
  }
  if (stamped) console.log(`🎯 Commission back-pointer backfill: stamped ${stamped} pre-existing project(s), stopped ${stopped} orphaned by an earlier pause/delete`);
  return { stamped, stopped };
}
