/**
 * The ONE path a quota-burn step takes to run its work.
 *
 * A burn step is a REFERENCE to a scheduled task the user already owns
 * (`lib/quotaBurnTaskRef.js`), so "running" it means invoking that task the way
 * anything else invokes it — never re-implementing it. That is the whole point
 * of the reference model: the retired `quotaBurnJobs/agentPrompt.js` executor
 * called `cosTaskStore.addTask` directly with a synthesized free-form task,
 * which walked past canonical task generation and every gate that lives in it.
 * #6381 converted the plans that used it and removed it, so this is now the ONLY
 * way a burn spends quota — a step still carrying a legacy `jobType` resolves to
 * `LEGACY_UNMIGRATED` here and is refused, never executed.
 *
 * Three reference shapes, three canonical invocations — and no fourth:
 *
 *   built-in AGENT task  → `taskSchedule.triggerOnDemandTask(type, appId,
 *                           { origin: QUOTA_BURN, burn })`. The on-demand
 *                           engines generate the task; acceptance is
 *                           ASYNCHRONOUS, and the burn provenance rides on the
 *                           request (`lib/quotaBurnOrigin.js`).
 *   built-in PROGRAMMATIC → `scheduledHandlers.runScheduledHandler` directly,
 *                           with the burning `family`. That registry documents
 *                           the burn as its second sanctioned caller precisely
 *                           so the render backend stays pinned to the
 *                           subscription being drained; routing it through the
 *                           request queue would drop `family` on the floor
 *                           (`cosTaskGenerator#drainProgrammaticOnDemandRequests`
 *                           passes none) and spend the wrong provider.
 *   CUSTOM app job        → `autonomousJobs.generateTaskFromJob` + `addTask`,
 *                           the same pair the scheduled fire uses.
 *
 * **This is not the manual endpoint.** `routes/cosJobRoutes.js`'s
 * `POST /jobs/:id/trigger` deliberately hands a human three privileges an
 * unattended burn must never inherit — `approvalRequired: false` regardless of
 * the job's autonomy level, `forceSpawnTask` past the autonomous scheduling
 * gates, and `reviveBlockedTask` on a failure-blocked twin. A burn queues the
 * task and stops: the daemon decides when it spawns, a blocked twin stays
 * blocked, and a job that would need a human to approve it is REFUSED rather
 * than parked awaiting approval — parking one would consume the family's
 * dispatch budget for work that spends nothing.
 *
 * `force` reaches here already meaning "the user clicked ▶". It bypasses the
 * QUOTA gates in `quotaBurn.js#evaluateFamily`, and it is threaded into a
 * programmatic handler so that handler can relax its OWN in-flight cooldown —
 * which is the whole point of the button on a `universe-bible-images` row whose
 * probe reports zero for entries that are merely already queued. What it never
 * relaxes: task eligibility, approval, target scope, enabled state, the master
 * Improve gate, and the duplicate checks below. Those are facts about whether
 * the work may run at all, not about this window's budget — and a duplicate in
 * particular is not "declined because of a gate", it is the same work twice.
 */

import {
  QUOTA_BURN_TASK_REF_KIND,
  QUOTA_BURN_UNAVAILABLE,
  enabledAppIdsByTaskType,
  resolveQuotaBurnStepAvailability,
} from '../lib/quotaBurnTaskRef.js';
import { generatedJobTaskFields } from '../lib/autonomousJobTask.js';
import { isProgrammaticScheduledTaskType } from '../lib/taskTargetScope.js';
import { ON_DEMAND_ORIGINS } from './taskScheduleConstants.js';

/** The autonomy level a custom job must carry for an UNATTENDED burn to run it. */
const UNATTENDED_AUTONOMY_LEVEL = 'yolo';

const declined = (reason) => ({ dispatched: false, reason });
const noWork = (detail) => ({ count: 0, detail });
// `Object.hasOwn`, not a truthiness check, so a reference naming an inherited
// key like `constructor` cannot resolve to anything.
const entryOf = (map, key) => (map && Object.hasOwn(map, key) ? map[key] : null);

/**
 * The live task catalog `resolveQuotaBurnStepAvailability` resolves a reference
 * against: `{ builtin: { [taskType]: { enabled, featureEnabled, feature,
 * eligible, appIds } }, custom: { [jobId]: { enabled, eligible, appId } },
 * improvementEnabled }`.
 *
 * The built-in entry is exactly the `entry` shape `evaluateOnDemandEligibility`
 * reads, so the page's verdict is produced by the same ladder that decides the
 * dispatch — every rung is filled here and judged there, never re-derived. That
 * is why the instance-FEATURE gate is a field of its own rather than folded into
 * `enabled`: the ladder can then say which of the two switches is off.
 * `eligible` is the picker restriction: a type another automation owns
 * (`userInvokable: false`) and a custom job that is not an agent job — a shell
 * command or a built-in script handler — are not things a burn may invoke.
 *
 * `appIds` per built-in type is the set of ACTIVE managed apps that have the
 * type switched on, so a reference to an app that was removed (or had the type
 * turned off) resolves as wrong-scope instead of silently dispatching nothing.
 *
 * `improvementEnabled` is the master CoS Improve switch, `null` when the state
 * could not be read — which fails CLOSED, because "we could not check" is not
 * "it is on".
 *
 * Each entry also carries the record it was derived from — the task's schedule
 * config, the custom job — and the catalog carries the `queued` set of on-demand
 * requests already waiting, all read off the SAME schedule/app/job snapshot.
 * `loadSchedule()` is uncached (a disk read plus a deep merge over every default
 * interval), so going back to the stores per step made the status page's probe
 * pay that whole cost once per configured step. The pure resolver ignores every
 * key it does not know.
 */
export async function getQuotaBurnTaskCatalog() {
  const [{ loadSchedule }, { getTaskTypeInvocation }, { getActiveApps }, { createFeatureGate }, { getAllJobs }, { isImprovementEnabled, loadState }] =
    await Promise.all([
      import('./taskScheduleStore.js'),
      import('./taskScheduleRegistry.js'),
      import('./apps.js'),
      import('./taskSchedule.js'),
      import('./autonomousJobs.js'),
      import('./cosState.js'),
    ]);

  const [schedule, apps, jobs, state] = await Promise.all([
    loadSchedule(),
    getActiveApps().catch(() => []),
    getAllJobs().catch(() => []),
    loadState().catch(() => null),
  ]);

  // The overrides come off the app records `getActiveApps` already returned.
  // `getAppTaskTypeOverrides(id)` would re-enter the app store twice per app to
  // produce the same answer for this filter — the legacy migration it also runs
  // only ever synthesizes `{ enabled: false }` entries, which are exactly what
  // gets discarded here. Other callers still perform that migration.
  const appIdsByTaskType = enabledAppIdsByTaskType(apps);

  // The schedule's own memoized gate, not a second copy: the burn catalog's
  // feature verdict has to agree with the one `triggerOnDemandTask` applies,
  // and two implementations of one rule drift silently.
  const featureEnabled = createFeatureGate();
  const builtin = {};
  await Promise.all(Object.entries(schedule?.tasks || {}).map(async ([taskType, config]) => {
    builtin[taskType] = {
      enabled: config?.enabled === true,
      featureEnabled: await featureEnabled(config),
      feature: config?.feature || null,
      eligible: getTaskTypeInvocation(taskType).userInvokable !== false,
      appIds: appIdsByTaskType.get(taskType) || [],
      config,
    };
  }));

  const custom = Object.fromEntries((jobs || []).map((job) => [job.id, {
    enabled: job.enabled === true,
    eligible: isBurnEligibleCustomJob(job),
    appId: job.appId || null,
    job,
  }]));

  return {
    builtin,
    custom,
    improvementEnabled: state ? isImprovementEnabled(state) : null,
    queued: queuedOnDemandKeys(schedule),
  };
}

/** `taskType` + app scope of every on-demand request already waiting to drain. */
const onDemandKey = (taskType, appId) => `${taskType}::${appId ?? ''}`;
const queuedOnDemandKeys = (schedule) =>
  new Set((schedule?.onDemandRequests || []).map((request) => onDemandKey(request.taskType, request.appId)));

/**
 * Whether a custom app job is something a burn may invoke at all.
 *
 * A `shell` job runs an allowlisted command and a `script` job runs a built-in
 * handler — neither spends provider quota, which is the only thing a burn is
 * for. Everything else is an agent job (`type` is absent on jobs written before
 * the field existed, and those are agent jobs).
 */
export function isBurnEligibleCustomJob(job) {
  return Boolean(job) && (!job.type || job.type === 'agent');
}

/**
 * Resolve a step against the live catalog into everything an invocation needs,
 * or the `unavailable` verdict that stops it.
 *
 * `effective` is the settings the invocation will actually run with: the step's
 * per-invocation overrides layered over the referenced task's SAVED settings.
 * An unset override inherits; nothing here writes back to the schedule or the
 * job record.
 */
export async function resolveQuotaBurnStep(step, catalog = null) {
  const resolvedCatalog = catalog || await getQuotaBurnTaskCatalog();
  const unavailable = resolveQuotaBurnStepAvailability(step, resolvedCatalog);
  if (unavailable) return { unavailable };

  const ref = step.taskRef;
  if (ref.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM) {
    // An EMPTY catalog (the caller's read failed) answers no existence question,
    // so the resolver above passed the step through. Display can afford that;
    // dispatch cannot — with no record to read there are no saved settings to
    // inherit, and running on the overrides alone would silently change the work.
    const job = entryOf(resolvedCatalog.custom, ref.jobId)?.job;
    if (!job) {
      return { unavailable: { code: QUOTA_BURN_UNAVAILABLE.DANGLING_JOB, reason: `custom scheduled job "${ref.jobId}" could not be read` } };
    }
    return { kind: 'custom', catalog: resolvedCatalog, ref, job, effective: effectiveSettings(step, job) };
  }

  const interval = entryOf(resolvedCatalog.builtin, ref.taskType)?.config;
  if (!interval) {
    return { unavailable: { code: QUOTA_BURN_UNAVAILABLE.UNKNOWN_TASK, reason: `scheduled task "${ref.taskType}" could not be read` } };
  }
  return {
    kind: isProgrammaticScheduledTaskType(ref.taskType) ? 'programmatic' : 'builtin',
    // Handed back so a caller that resolved through a catalog keeps reading that
    // one snapshot instead of going back to the (uncached) schedule store.
    catalog: resolvedCatalog,
    ref,
    interval,
    effective: effectiveSettings(step, interval),
  };
}

/**
 * Layer a step's overrides over a task's saved settings.
 *
 * Presence, not truthiness: `normalizeQuotaBurnJob` already reduces an unset
 * override to `null`, so `??` is the correct join — a step that pins nothing
 * inherits, and a step that pins something wins. `params` MERGE key-by-key
 * rather than replacing the bag, so overriding one run parameter does not blank
 * every other saved one.
 */
export function effectiveSettings(step, saved) {
  const overrides = step?.overrides || {};
  return {
    providerId: overrides.providerId ?? saved?.providerId ?? null,
    model: overrides.model ?? saved?.model ?? null,
    effort: overrides.effort ?? saved?.effort ?? null,
    params: { ...(saved?.taskMetadata || {}), ...(overrides.params || {}) },
  };
}

/**
 * `countPending(reference) → { count, detail, context? }` — the shared probe
 * contract the runner's ordered selection and the status page both read.
 *
 * Side-effect free, always: it writes nothing, enqueues nothing, and makes no
 * AI provider call (AGENTS.md — no cold-bootstrap LLM calls; the status page
 * calls this for every configured step on every load).
 *
 *   - an eligible AI agent task (built-in or custom) reports ONE ready unit —
 *     a task is one unit of work, and there is no backlog to count;
 *   - an ineligible, disabled, dangling or ALREADY-ACTIVE task reports zero
 *     with the reason, so the runner skips it and the page can say why;
 *   - a programmatic handler reports its own domain backlog count, and may hand
 *     back the opaque `context` its scan produced for `run` to reuse.
 */
export async function countQuotaBurnStepPending({ step, family, catalog = null } = {}) {
  const resolved = await resolveQuotaBurnStep(step, catalog);
  if (resolved.unavailable) return noWork(resolved.unavailable.reason);

  if (resolved.kind === 'programmatic') {
    const { countScheduledHandlerPending } = await import('./scheduledHandlers/index.js');
    return countScheduledHandlerPending({
      taskType: resolved.ref.taskType,
      params: resolved.effective.params,
      job: resolved.effective,
      family,
    });
  }

  // Approval outranks the provider check, matching the order `runCustomJobStep`
  // applies — a job the burn may never run at all should say so rather than
  // report a provider problem the user would then go and "fix".
  const approval = resolved.kind === 'custom' ? unattendedApprovalRefusal(resolved.job) : null;
  if (approval) return noWork(approval);

  // Both agent lanes need a provider in the burning family before they can
  // report a ready unit — a step whose family has none is not "one unit of work
  // waiting", it is unrunnable, and the runner has to move to the next step
  // rather than dispatch onto some other subscription.
  const picked = await resolveStepProvider(resolved.effective, family);
  if (picked.error) return noWork(picked.error);

  if (resolved.kind === 'custom') {
    const active = await activeCustomJobReason(resolved.job);
    return active ? noWork(active) : { count: 1, detail: `ready to queue "${resolved.job.name}" via ${picked.provider.id}` };
  }

  const queued = await queuedOnDemandReason(resolved.catalog?.queued, resolved.ref.taskType, resolved.ref.appId);
  return queued
    ? noWork(queued)
    : { count: 1, detail: `ready to run scheduled task "${resolved.ref.taskType}" via ${picked.provider.id}` };
}

/**
 * The provider a burn will actually spend, or a refusal.
 *
 * A burn exists to draw down ONE family's window, so this is not optional
 * plumbing: without it a step whose family has no enabled CLI/TUI provider would
 * queue on whatever the daemon picks and spend a different subscription
 * entirely, and a pin naming another family's provider would do the same on
 * purpose. `providerForFamily` honors an explicit pin WITHOUT re-checking its
 * family (by design — the pin is how you name a specific binary), so the family
 * check is made here, against the resolved provider record rather than its id:
 * the command basename is what identifies a family (`antigravity-cli` is
 * `agy`), and an id-substring rule strands whole families.
 *
 * Programmatic handlers do NOT come through here — each resolves its own
 * backend from the `family` it is handed (`prefer: 'cli'`, and the render
 * backend is not always a provider at all).
 */
async function resolveStepProvider(effective, family) {
  const { noProviderReason, matchesFamily, resolveBurnProvider } = await import('./scheduledHandlers/providerPick.js');
  const provider = await resolveBurnProvider({ job: { providerId: effective.providerId }, family });
  if (!provider) {
    return {
      error: effective.providerId
        ? `pinned provider "${effective.providerId}" is not an enabled CLI/TUI provider`
        : noProviderReason(family),
    };
  }
  if (!matchesFamily(provider, family.id)) {
    return { error: `pinned provider "${provider.id}" does not belong to the ${family.id} family` };
  }
  return { provider };
}

/**
 * Why an unattended burn may not run this custom job, or null.
 *
 * `autonomyLevel` is the job's own statement about whether it may run without a
 * human confirming it (`generateTaskFromJob` turns `yolo` into `autoApprove`).
 * Anything below that needs an approval a burn cannot give, and the manual
 * endpoint's `approvalRequired: false` is exactly the bypass this path must not
 * inherit — so it refuses instead, with the level named so the row is
 * actionable.
 */
function unattendedApprovalRefusal(job) {
  return job.autonomyLevel === UNATTENDED_AUTONOMY_LEVEL
    ? null
    : `custom scheduled job "${job.name}" needs approval to run (autonomy level "${job.autonomyLevel || 'manager'}") — a quota burn cannot approve it`;
}

/**
 * Whether an equivalent invocation of this custom job is already in flight.
 *
 * `cosJobScheduler.isJobFireInFlight` is the scheduler's OWN admission check,
 * shared rather than copied: half of it (`spawningJobIds`) is process-local
 * state a re-implementation here could not see at all, which would leave the
 * whole spawn window open for a burn to double-queue a job the clock just fired.
 */
async function activeCustomJobReason(job) {
  const [{ loadState }, { isJobFireInFlight }] = await Promise.all([
    import('./cosState.js'),
    import('./cosJobScheduler.js'),
  ]);
  const state = await loadState().catch(() => null);
  if (!state) return null;
  return isJobFireInFlight(job.id, state) ? `a run of "${job.name}" is already in flight` : null;
}

/**
 * Whether this built-in task already has an on-demand request waiting.
 *
 * Two burn cycles can otherwise stack requests for the same task faster than the
 * engines drain them: the second would spend the family's budget on a task the
 * first already asked for. `addTask`'s duplicate detection catches the collision
 * one step later, but only after the cap was already charged.
 */
async function queuedOnDemandReason(queued, taskType, appId) {
  const pending = queued instanceof Set
    ? queued.has(onDemandKey(taskType, appId))
    // No snapshot (a caller passed a bare catalog, or the read failed): ask the
    // schedule directly rather than reporting "nothing queued", which would let
    // a second cycle stack a duplicate request onto the family's budget.
    : (await import('./taskSchedule.js')
      .then(({ getOnDemandRequests }) => getOnDemandRequests())
      .catch(() => []))
      .some((request) => onDemandKey(request.taskType, request.appId) === onDemandKey(taskType, appId));
  return pending ? `an on-demand run of "${taskType}" is already queued` : null;
}

/**
 * Invoke one burn step. Returns the registry's dispatch shape —
 * `{ dispatched, summary?, reason?, detail?, awaiting? }` — so the runner's
 * accounting, run log and skip reporting read identically whichever reference
 * shape ran.
 *
 * A decline is reported, never thrown: work that failed to start must not
 * charge the window's cap. `awaiting` says the opposite thing about a dispatch
 * that DID go out: the work is not accepted yet, so the runner reserves the
 * step's place instead of charging it (see `quotaBurnAcceptance.js`).
 *
 * The master Improve switch is refused HERE, in the shared resolution, for all
 * three lanes: the catalog carries the switch, so the page reports it on the
 * same step the dispatch would refuse — and a burn cannot be the one path that
 * spends a subscription while the user has CoS improvement switched off.
 */
export async function invokeQuotaBurnStep({ step, family, candidate, context, force = false, catalog = null } = {}) {
  const resolved = await resolveQuotaBurnStep(step, catalog);
  if (resolved.unavailable) return declined(resolved.unavailable.reason);

  if (resolved.kind === 'programmatic') return runProgrammaticStep({ resolved, family, context, force });
  if (resolved.kind === 'custom') return runCustomJobStep({ resolved, step, family, candidate });
  return runBuiltinTaskStep({ resolved, step, family, candidate });
}

/**
 * A programmatic handler runs INLINE — PortOS performs the work itself, spawns
 * no agent and consumes no slot, so there is nothing to generate and nothing to
 * wait for. `family` is what keeps the render backend pinned to the window being
 * drained (see `scheduledHandlers/index.js`).
 */
async function runProgrammaticStep({ resolved, family, context, force }) {
  const { runScheduledHandler } = await import('./scheduledHandlers/index.js');
  return runScheduledHandler({
    taskType: resolved.ref.taskType,
    params: resolved.effective.params,
    job: resolved.effective,
    family,
    context,
    force,
  });
}

/**
 * A built-in agent task goes through the schedule's own on-demand lane, so the
 * master Improve gate, the enabled + instance-feature gates, target scope, the
 * per-app switch and invocation eligibility are all enforced by
 * `triggerOnDemandTask` itself rather than restated here — and it reaches them
 * through `evaluateOnDemandEligibility`, the same ladder `resolveQuotaBurnStep`
 * already ran against the catalog. One ladder, two consumers.
 *
 * `force` is NOT passed through: it means "past the quota gates", and the
 * schedule's gates are not quota gates.
 */
async function runBuiltinTaskStep({ resolved, step, family, candidate }) {
  // Re-checked HERE, not left to the probe: a forced run of a named step skips
  // the probe entirely (the click IS the selection), and `triggerOnDemandTask`
  // appends unconditionally — so without this, two forced clicks queue the same
  // task twice and charge the window's cap twice for one piece of work. The
  // legacy executor never had this hole because `addTask` deduplicated one step
  // further down; a request has no such backstop.
  const queued = await queuedOnDemandReason(resolved.catalog?.queued, resolved.ref.taskType, resolved.ref.appId);
  if (queued) return declined(queued);

  const picked = await resolveStepProvider(resolved.effective, family);
  if (picked.error) return declined(picked.error);

  const { triggerOnDemandTask } = await import('./taskSchedule.js');
  const request = await triggerOnDemandTask(resolved.ref.taskType, resolved.ref.appId, {
    origin: ON_DEMAND_ORIGINS.QUOTA_BURN,
    burn: {
      family: family.id,
      stepId: step.id,
      limitingResetAt: candidate?.limitingResetAt ?? null,
      overrides: {
        // The RESOLVED provider, not the step's pin: an unpinned step must still
        // land on this family's provider rather than the daemon's active one, or
        // the burn spends a window nobody asked it to.
        providerId: picked.provider.id,
        model: resolved.effective.model,
        effort: resolved.effective.effort,
        // The step's run params, which the on-demand engines hand to the
        // generator as `runOverrides` — layered over the task's saved
        // `taskMetadata` BEFORE the mode banner and the prompt are built. This
        // is what carries a migrated issues-only burn's explicit
        // `fileIssues: true` (#6381); without it the burn would run the
        // referenced task's SAVED mode and start writing code.
        params: resolved.effective.params,
      },
    },
  });
  if (request?.error) return declined(request.error);

  console.log(`🔥 Quota-burn requested scheduled task ${resolved.ref.taskType} for ${family.id} (${request.id})`);
  return {
    dispatched: true,
    // The ONLY lane whose acceptance is asynchronous: the request is recorded
    // now and an on-demand engine generates the task later — or refuses it. The
    // runner reserves against this instead of charging, and settles the charge
    // when the request is joined to the task it produced
    // (`quotaBurnAcceptance.js`). The two synchronous lanes below return no
    // `awaiting`, because their work is accepted the moment they return.
    awaiting: { requestId: request.id },
    summary: `Requested "${resolved.ref.taskType}"${resolved.ref.appId ? ` for ${resolved.ref.appId}` : ''}`,
    detail: {
      requestId: request.id,
      taskType: resolved.ref.taskType,
      appId: resolved.ref.appId,
      providerId: picked.provider.id,
      model: resolved.effective.model,
      effort: resolved.effective.effort,
    },
  };
}

/**
 * A custom app job is generated by the job's own generator and queued with
 * `addTask` — the same pair the scheduled fire uses — carrying the step's
 * provider/model/effort overrides and the burn provenance.
 *
 * `approvalRequired` follows the job's autonomy level (already gated to `yolo`
 * above, so it lands `false` legitimately rather than by bypass); no
 * `forceSpawnTask`, and a blocked twin is reported as a decline instead of
 * revived. See this module's header for why each of those matters.
 */
async function runCustomJobStep({ resolved, step, family, candidate }) {
  const approval = unattendedApprovalRefusal(resolved.job);
  if (approval) return declined(approval);
  // `addTask`'s duplicate detection catches an identical QUEUED twin below, but
  // not one already mid-spawn — and a forced run reaches here with no probe.
  const active = await activeCustomJobReason(resolved.job);
  if (active) return declined(active);
  const picked = await resolveStepProvider(resolved.effective, family);
  if (picked.error) return declined(picked.error);

  const [{ generateTaskFromJob }, { addTask }] = await Promise.all([
    import('./autonomousJobs.js'),
    import('./cosTaskStore.js'),
  ]);
  const generated = await generateTaskFromJob(resolved.job);
  const persisted = await addTask({
    // The generator's own field projection, shared with the manual endpoint so
    // a key added to `generateTaskFromJob` cannot reach one lane and not the
    // other. Everything below OVERRIDES it — that is where the two legitimately
    // differ.
    ...generatedJobTaskFields(generated),
    context: `Quota burn (${family.id}): ${resolved.job.name}`,
    approvalRequired: !generated.autoApprove,
    // The step's overrides win over the job's saved pins (see effectiveSettings),
    // and an unpinned step still lands on THIS family's provider.
    provider: picked.provider.id,
    model: resolved.effective.model || undefined,
    effort: resolved.effective.effort || undefined,
    // The attribution keys the built-in lane stamps via its request, so
    // `isCooldownExemptTask`, the completion continuation and the denial ledger
    // cannot tell the two lanes apart. There is deliberately no
    // `quotaBurnRequestId`: this lane queues the task synchronously, so no
    // request ever exists to name — that key records the ASYNC hop, and minting
    // a fake one would make a join over it silently wrong.
    quotaBurnFamily: family.id,
    quotaBurnLimitingResetAt: candidate?.limitingResetAt ?? null,
    quotaBurnStepId: step.id,
  }, 'internal', { suppressDequeue: true });

  if (!persisted?.id) return declined(`"${resolved.job.name}" was not queued`);
  // A blocked twin stays blocked: reviving it is the manual endpoint's explicit
  // retry, and an unattended burn has no such intent to express.
  if (persisted.duplicate) return declined(`an identical "${resolved.job.name}" task is already ${persisted.status}`);

  console.log(`🔥 Quota-burn queued custom job ${resolved.job.id} as task ${persisted.id} for ${family.id}`);
  return {
    dispatched: true,
    summary: `Queued "${resolved.job.name}" via ${picked.provider.id}`,
    detail: {
      taskId: persisted.id,
      jobId: resolved.job.id,
      providerId: picked.provider.id,
      model: resolved.effective.model,
      effort: resolved.effective.effort,
    },
  };
}
