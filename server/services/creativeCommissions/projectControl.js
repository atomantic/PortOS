/**
 * Creative Commission → Creative Director project control.
 *
 * A commission fire mints a CD project and the advance loop drives it from
 * there. Two things the commission must still be able to do to that work, and
 * the seam both run on:
 *
 *   - **Stop it.** Pausing or deleting a commission used to cancel only the CRON.
 *     The projects already spawned kept re-dispatching their cognitive stages,
 *     and the orphan sweeps (boot + the 15-minute health check in cos.js) kept
 *     respawning the agent tasks behind them — so a commission with a bad brief
 *     could not actually be stopped. `stopCommissionProjects` runs the CD hard
 *     stop over everything the commission spawned.
 *
 *   - **Re-provider it.** The commission's LLM pin is resolved at DISPATCH time
 *     (agentBridge → `commissionStagePin` below), so an edit reaches every
 *     not-yet-dispatched stage with no write and no sweep. The one thing a live
 *     read cannot fix is a task ALREADY handed to the runner: its provider is
 *     frozen in the task's own metadata, and the orphan sweep respawns it
 *     verbatim. `restartCommissionStages` retires exactly those.
 *
 * The link is `project.commissionId`, stamped at fire time. The commission's run
 * ledger is NOT the link: it is capped at MAX_PERSISTED_RUNS, so a project still
 * wedged after that many fires — the precise case this module exists for — has
 * already fallen out of it, and a project a plan step spawns indirectly
 * (bridgeFromIssue) never enters it at all. The ledger is still unioned in as a
 * compatibility path for projects minted before the back-pointer existed.
 *
 * Everything here runs OUTSIDE the Express request lifecycle (the store's
 * `commission:changed` bus) — no path throws out.
 */

import { commissionStore, sanitizeCommission, commissionEvents } from './store.js';
import { PROJECT_TERMINAL_STATUSES } from '../../lib/creativeDirectorPresets.js';

// The CD cognitive stages a commission's single pin drives. `evaluation` is
// deliberately absent — it is a vision API call, not a CoS agent, and pinning it
// to a CLI/TUI provider would trip agentBridge's harness-boundary guard.
export const COMMISSION_PINNED_STAGES = ['treatment', 'plan'];

// Statuses in which a project is still being driven by the advance loop, so a
// stage restart should hand it straight back. A `paused` project keeps the fresh
// provider but is NOT auto-resumed — the user parked it, and Resume is theirs.
const ADVANCING_PROJECT_STATUSES = new Set(['planning', 'rendering', 'stitching']);

/**
 * Read a commission by id INCLUDING a tombstoned one — the delete path runs
 * AFTER the tombstone lands and still needs the record. Reads raw (not
 * `getCommission`) deliberately: these paths only need the machine-local
 * assignment, and must not drag the federated feedback hydration onto an
 * event-bus handler or onto every agent dispatch.
 */
async function readCommission(id) {
  if (!id) return null;
  const raw = await commissionStore().readRaw(id, { includeDeleted: true }).catch(() => null);
  return raw ? sanitizeCommission(raw) : null;
}

/**
 * The commission's live `{ providerId, model }` pin for its CD cognitive stages,
 * or `null` to inherit the install's AI Assignment. Resolved at DISPATCH, so an
 * edit to the commission reaches work already in flight without rewriting a
 * single project record.
 *
 * A pin becomes unusable three ways — an api-type provider (trips agentBridge's
 * harness-boundary guard), a removed provider, or a provider the user later
 * DISABLED (the agent runner honors an explicit task pin without re-checking
 * `enabled`, so a disabled provider would keep launching commissions and defeat
 * the disable control). The UI only offers enabled agent-harness providers, but a
 * direct REST write, a provider whose type later changed to `api`, or a post-pin
 * disable could slip a bad pin past it. An unusable pin is DROPPED so the stage
 * falls back to the install default and the commission still generates rather
 * than stalling. Fail open: an unresolvable provider (toolkit hiccup) also falls
 * back.
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
 * Distinct CD project ids named by a commission's run ledger, newest first. Pure.
 * The compatibility half of the lookup — see `commissionProjects`.
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
 * Every live, non-terminal project a commission owns. Unions the authoritative
 * `commissionId` query with the run ledger, so projects minted before the
 * back-pointer existed are still reachable on an install that just upgraded.
 */
async function commissionProjects(commissionId, preread) {
  const { listProjectsByCommissionId, getProjectsByIds } = await import('../creativeDirector/local.js');
  const owned = await listProjectsByCommissionId(commissionId).catch(() => []);
  // The ledger fallback needs the record. Callers that already hold it pass it
  // in; the delete path does not, and reading it here (rather than making every
  // caller remember) is what keeps pre-back-pointer projects reachable on a
  // delete as well as a pause.
  const commission = preread || await readCommission(commissionId);
  const known = new Set(owned.map((p) => p.id));
  const legacyIds = ledgerProjectIds(commission).filter((id) => !known.has(id));
  const legacy = legacyIds.length ? await getProjectsByIds(legacyIds).catch(() => []) : [];
  return [...owned, ...legacy].filter((p) => p && !PROJECT_TERMINAL_STATUSES.has(p.status));
}

/**
 * Retire the stages a commission's projects have ALREADY dispatched, so the next
 * dispatch picks up the commission's current provider instead of the one frozen
 * in the live task's metadata, then hand each project back to the advance loop.
 *
 * Only the LLM stages are torn down — a `plan-step` run is a tool dispatch (often
 * a render already burning GPU time) and has nothing to do with the LLM pin.
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
  // Which advance loop owns a project depends on its shape, and BOTH shapes can
  // carry a commissionId: a commission fire mints a directive project, but a plan
  // step's `cd_produceVideoFromIssue` mints a legacy scene-loop teaser that
  // inherits the same back-pointer. Handing a directive-less project to
  // advanceAfterPlanStepSettled is a silent no-op (it returns on `!project.directive`),
  // which would leave the stage we just retired with nothing to re-dispatch it —
  // wedged until a manual Resume. Same branch as recovery.js and
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
 * Hard-stop every project this commission spawned — the missing half of pausing
 * or deleting a commission. Cancelling the cron stops FUTURE fires; this stops
 * the work already running (agent processes, CoS tasks, run rows, media jobs).
 *
 * Stopped projects are parked as `paused` with the reason, NOT deleted: the
 * outputs already produced stay browsable, and the user can Resume an individual
 * project from the CD detail page if they only wanted to change the provider.
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

// A commission mutation that cannot possibly change what its in-flight work
// should be doing. `fields` is the patched key set, absent on emitters that don't
// report one — and absent must mean "reconcile" (we cannot prove it was
// irrelevant), never "skip".
const RECONCILABLE_FIELDS = ['enabled', 'assignment'];

/**
 * The `commission:changed` reconciler — the single decision table for what a
 * commission mutation must do to the work it already spawned:
 *
 *   delete            → stop everything (the user removed the job).
 *   update + disabled → stop everything (Pause means STOP, not "let it keep
 *                       retrying with no way to intervene").
 *   update + enabled  → restart the stages already dispatched, so they pick up
 *   restore             the commission's current provider on re-dispatch.
 *   create            → nothing; a brand-new commission has spawned nothing.
 *   merge (no id)     → nothing; a peer merge only carries the federated brief,
 *                       never the machine-local schedule/assignment/runs.
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
  // Tombstoned, but reached here on some action other than 'delete' (a restore
  // that lost the LWW, a hand-fired event). Deleted outranks everything else:
  // restarting a dead commission's stages would re-dispatch work the user removed.
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
 * Subscribe the reconciler to every commission write. Lives here rather than in
 * the cron scheduler so that module stays about arming crons; called once at
 * import by whoever pulls this module into the boot graph.
 */
export function registerCommissionProjectReconciler() {
  commissionEvents.on('commission:changed', (change) => {
    reconcileCommissionProjects(change).catch((err) =>
      console.error(`❌ Creative commission project reconcile failed: ${err.message}`));
  });
}

/**
 * One-shot boot backfill for projects minted BEFORE the back-pointer existed.
 * Reads the commission's run ledger and, for each project it still names:
 *
 *   1. stamps `commissionId`, and
 *   2. CLEARS the `modelOverrides.{treatment,plan}` snapshot the old fire path
 *      wrote onto it.
 *
 * Both halves are needed, and (2) is the one that actually unsticks the user's
 * problem. The dispatch path only consults a commission when the project names
 * one — so without (1) a wedged project keeps its frozen provider forever. But a
 * per-project pin now outranks the commission's (it means "the user chose this in
 * the models drawer"), and every pre-change project carries one purely because
 * the fire wrote it — so without (2) the stamp would land and the stale snapshot
 * would still win, leaving the project exactly as stuck as before.
 *
 * The trade-off is deliberate: on a pre-change project we cannot distinguish the
 * machine-written snapshot from a drawer edit made on top of it, and clearing is
 * the only choice that honors the commission going forward. A user who wants a
 * per-project override can re-set it in the drawer, where it will now stick.
 *
 * The ledger is capped, so this recovers what it still remembers; anything
 * already evicted stays unlinked (nothing else can recover it, and a fresh fire
 * mints a correctly-stamped project with no snapshot at all).
 *
 * Finally, a commission that was PAUSED or DELETED before the upgrade gets its
 * newly-linked projects stopped here. Its `commission:changed` event fired on the
 * old build, which had no reconciler — so nothing ever stopped that work, and
 * without this pass it keeps re-dispatching after the user already asked for it to
 * stop. That is the exact complaint this whole change exists to answer, and on an
 * upgrading install it is the projects reachable ONLY through this backfill that
 * are still stuck.
 *
 * Pure data movement, no LLM (a stop kills processes and cancels renders; it never
 * calls a provider), so this is compliant with the no-cold-bootstrap-LLM rule.
 * Idempotent: a project that already carries the back-pointer is skipped, so a
 * re-run writes nothing and stops nothing. Best-effort — a failure leaves the
 * install exactly as it was.
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
    // A commission stopped BEFORE this build shipped never had its work stopped —
    // the reconciler didn't exist when its pause/delete event fired. Catch up now,
    // or the projects we just linked keep retrying forever.
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
