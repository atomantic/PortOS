/** World projection and augmentation, including checkpoints and compensation. */

import { EIDOVERSE_ASSET_RECIPE_VERSION, EIDOVERSE_WORLD_DESIGN_VERSION } from '../lib/eidoverseWorldDesign.js';
import { eidoverseHostId } from '../lib/eidoverseWorldSignals.js';
import { ServerError } from '../lib/errorHandler.js';
import { canonicalStringify } from '../lib/objects.js';
import { getEidoverseStatus } from './eidoverse.js';
import { resolveAndLockAssets } from './eidoverseWorldAssets.js';
import {
  assertInstalled,
  createVerbPacing,
  ensureCosPresenceInternal,
  ensureEidoverseWorldConfig,
  getCosPresence,
  presenceSummary,
  PROJECTION_VERB_INTERVAL_MS,
  sendPacedVerb,
  throwIfAborted,
  worldLock,
} from './eidoverseWorldConnection.js';
import { buildProjectionPlan } from './eidoverseWorldProjection.js';
import {
  clone,
  configFromState,
  loadState,
  mutateState,
  safeNumber,
  safeText,
  shortHash,
  validAssetPath,
  validEntityId,
  vector3,
} from './eidoverseWorldState.js';
import { getInstanceFeatures } from './instanceFeatures.js';
import { getInstanceId } from './instanceIdentity.js';

const COMPONENT_TYPE_RE = /^[A-Za-z0-9._:-]{1,32}$/;
const COMPONENT_TYPE = 'portos';

async function sendOperations(connection, operations, {
  signal,
  onApplied,
  pacing = createVerbPacing(),
  verbIntervalMs = PROJECTION_VERB_INTERVAL_MS,
} = {}) {
  for (const operation of operations) {
    await sendPacedVerb(connection, operation.verb, operation.args, { signal, pacing, verbIntervalMs });
    onApplied?.(operation);
  }
}

async function recordReconciliationCheckpoint(patch) {
  return mutateState((state) => {
    state.reconciliation = { ...state.reconciliation, ...patch };
    return clone(state.reconciliation);
  });
}

function restoreEntityOperations(id, entity) {
  if (!entity) return [];
  if (entity.kind === 'light') {
    return [{ layer: 'compensation', verb: 'light', args: {
      id,
      pos: entity.pos,
      color: entity.color,
      intensity: entity.intensity,
      range: entity.range,
      ...(entity.keep ? { keep: true } : {}),
      ...(entity.day === false ? { day: false } : {}),
    } }];
  }
  if (!entity.lib) return [];
  const operations = [{ layer: 'compensation', verb: 'spawn', args: {
    id,
    lib: entity.lib,
    pos: entity.pos || [0, 0, 0],
    yaw: entity.yaw || 0,
    ...(entity.scale !== undefined ? { scale: entity.scale } : {}),
    ...(entity.collide ? { collide: entity.collide } : {}),
  } }];
  for (const [type, data] of Object.entries(entity.comp || {})) {
    // Legacy PortOS components may predate the privacy-safe WorldSignal shape.
    // They are visually inert, so do not duplicate their old contents into a
    // new append-only log during rollback.
    if (type === COMPONENT_TYPE && !(
      data?.managedBy === 'portos'
      && data?.designVersion === EIDOVERSE_WORLD_DESIGN_VERSION
      && data?.disclosure === 'aggregate'
    )) continue;
    operations.push({ layer: 'compensation', verb: 'comp', args: { id, type, data } });
  }
  return operations;
}

function inverseOperationsFor(operation, currentState) {
  const id = operation.args?.id;
  const existing = id ? currentState?.entities?.[id] : null;
  switch (operation.verb) {
    case 'spawn':
      return [{ layer: 'compensation', verb: 'remove', args: { id } }];
    case 'place':
      return existing ? [{ layer: 'compensation', verb: 'place', args: {
        id,
        pos: existing.pos || [0, 0, 0],
        yaw: existing.yaw || 0,
        ...(existing.scale !== undefined ? { scale: existing.scale } : {}),
      } }] : [];
    case 'comp':
      return [{ layer: 'compensation', verb: 'comp', args: {
        id,
        type: operation.args.type,
        data: existing?.comp?.[operation.args.type] ?? null,
      } }];
    case 'remove':
      return restoreEntityOperations(id, existing);
    case 'light':
      return existing
        ? restoreEntityOperations(id, existing)
        : [{ layer: 'compensation', verb: 'remove', args: { id } }];
    case 'terrain':
      return [{
        layer: 'compensation',
        verb: 'terrain',
        args: currentState?.terrain || {
          seed: 'portos-legacy-neutral', size: 128, segments: 2, amplitude: 0, flatRadius: 128,
          layers: [{ color: '#142338', repeat: 1 }],
        },
      }];
    case 'sky':
      return [{
        layer: 'compensation',
        verb: 'sky',
        args: currentState?.sky || {
          system: 'skymesh', hours: 0, azimuth: 0, sun: 0, ambient: 0.15,
          fill: 0, exposure: 0.35, fog: 1, clouds: 'none', weather: 'clear',
        },
      }];
    case 'grass':
      return [{
        layer: 'compensation',
        verb: 'grass',
        args: currentState?.grass || { clear: true },
      }];
    default:
      return [];
  }
}

function compensationOperations(applied, currentState) {
  return [...applied].reverse().flatMap((operation) => inverseOperationsFor(operation, currentState));
}

// Infrastructure and live signals are proven first so a V2 update cannot make
// its new atmosphere authoritative without the semantic world beneath it. The
// ambient layer follows the environment, then reconciliation retires only old
// PortOS-managed ids.
const PROJECTION_UPDATE_STAGES = ['infrastructure', 'live', 'environment', 'ambient', 'reconciliation'];
const PROJECTION_FRESH_STAGES = ['environment', 'infrastructure', 'live', 'ambient', 'reconciliation'];

async function applyProjectionPlan(presence, plan, {
  signal,
  freshInstall = false,
  verbIntervalMs,
} = {}) {
  const applied = [];
  const planFingerprint = shortHash(canonicalStringify({
    designVersion: EIDOVERSE_WORLD_DESIGN_VERSION,
    operations: plan.operations,
  }));
  await recordReconciliationCheckpoint({
    status: 'applying',
    checkpoint: 'plan-ready',
    planFingerprint,
    operationCount: plan.operations.length,
    appliedOperations: 0,
    compensationStatus: null,
  });

  const stageOrder = freshInstall ? PROJECTION_FRESH_STAGES : PROJECTION_UPDATE_STAGES;
  const stages = stageOrder.map((stage) => [
    stage,
    plan.operations.filter((operation) => operation.layer === stage),
  ]);
  const pacing = presence.pacing || createVerbPacing();
  const execution = stages.reduce((promise, [stage, operations]) => promise.then(async () => {
    if (operations.length === 0) return;
    await recordReconciliationCheckpoint({ checkpoint: `applying-${stage}` });
    await sendOperations(presence.connection, operations, {
      signal,
      pacing,
      verbIntervalMs,
      onApplied: (operation) => applied.push(operation),
    });
    await recordReconciliationCheckpoint({
      checkpoint: `${stage}-complete`,
      appliedOperations: applied.length,
    });
  }), Promise.resolve());

  return execution.catch(async (error) => {
    const rollback = compensationOperations(applied, presence.snapshot?.state || {});
    await recordReconciliationCheckpoint({
      status: 'compensating',
      checkpoint: 'compensation-started',
      appliedOperations: applied.length,
      compensationStatus: 'running',
    });
    const compensation = ensureCosPresenceInternal({ fresh: true, verbIntervalMs })
      .then((recoveryPresence) => sendOperations(recoveryPresence.connection, rollback, {
        pacing: recoveryPresence.pacing,
        verbIntervalMs,
      }));
    return compensation.then(
      async () => {
        await recordReconciliationCheckpoint({
          status: 'pending',
          checkpoint: 'compensation-complete',
          compensationStatus: 'complete',
        });
        error.compensationStatus = 'complete';
        throw error;
      },
      async (compensationError) => {
        await recordReconciliationCheckpoint({
          status: 'pending',
          checkpoint: 'compensation-failed',
          compensationStatus: 'failed',
          compensationError: safeText(compensationError?.message, 'Rollback failed', 500),
        });
        error.compensationStatus = 'failed';
        error.compensationError = compensationError;
        throw error;
      },
    );
  });
}

function reconciliationErrorContext(error) {
  if (['EIDOVERSE_ASSET_RECIPE_UNRESOLVED', 'EIDOVERSE_ASSET_OVERRIDE_UNAVAILABLE'].includes(error?.code)) {
    return {
      missing: Array.isArray(error.context?.missing)
        ? error.context.missing.filter((slot) => typeof slot === 'string').slice(0, 16)
        : [],
      assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
    };
  }
  if (error?.code === 'EIDOVERSE_PROTOCOL_INCOMPATIBLE') {
    return { remediation: '/apps', required: 'world-design-v2' };
  }
  return null;
}

async function recordProjection({ success, summary = null, error = null }) {
  const now = new Date().toISOString();
  return mutateState((state) => {
    state.projection = {
      ...state.projection,
      lastRunAt: now,
      ...(success ? { lastSuccessAt: now, lastError: null, lastSummary: summary } : {
        lastError: safeText(error?.message || error, 'Projection failed', 500),
      }),
    };
    if (success) {
      state.lastAppliedDesignVersion = EIDOVERSE_WORLD_DESIGN_VERSION;
      state.pendingDesignVersion = null;
      state.reconciliation = {
        ...state.reconciliation,
        status: 'complete',
        checkpoint: 'projection-committed',
        error: null,
        errorCode: null,
        errorContext: null,
        completedAt: now,
        appliedOperations: summary?.operationCount ?? state.reconciliation.operationCount,
        compensationStatus: null,
        compensationError: null,
      };
      if (state.migrationReport?.status === 'ready') state.migrationReport.status = 'applied';
    } else {
      state.pendingDesignVersion = EIDOVERSE_WORLD_DESIGN_VERSION;
      state.reconciliation = {
        ...state.reconciliation,
        status: 'failed',
        checkpoint: state.reconciliation?.checkpoint || 'projection-started',
        error: safeText(error?.message || error, 'Projection failed', 500),
        errorCode: safeText(error?.code, '', 80) || null,
        errorContext: reconciliationErrorContext(error),
        completedAt: now,
      };
    }
    return state.projection;
  });
}

export async function projectEidoverseWorld({ signal, compact = false, verbIntervalMs } = {}) {
  const run = async () => {
    throwIfAborted(signal);
    await assertInstalled();
    const config = await ensureEidoverseWorldConfig();
    const lockedConfig = await resolveAndLockAssets(config, { signal });
    const presence = await ensureCosPresenceInternal({ fresh: true, signal, verbIntervalMs });
    const { collectEidoverseWorldSources } = await import('./eidoverseWorldSources.js');
    const source = await collectEidoverseWorldSources({ signal });
    const hostId = eidoverseHostId(await getInstanceId());
    throwIfAborted(signal);
    const plan = buildProjectionPlan({
      source,
      recipe: lockedConfig.recipe,
      labelAliases: lockedConfig.design.labelAliases,
      assetResolutions: {
        ...lockedConfig.design.assetResolutions,
        // Preflight verifies legacy kind overrides too, even though only the
        // semantic slots have durable resolution locks.
        ...Object.fromEntries(Object.entries(lockedConfig.design.userOverrides?.assets || {})
          .map(([slot, path]) => [slot, {
            ...(lockedConfig.design.assetResolutions[slot]?.path === path ? lockedConfig.design.assetResolutions[slot] : {}),
            path, userOverride: true,
          }])),
      },
      currentState: presence.snapshot?.state || {},
      meta: { title: lockedConfig.design.name, hostId },
    });
    await applyProjectionPlan(presence, plan, {
      signal,
      freshInstall: lockedConfig.design.lastAppliedVersion === null,
      verbIntervalMs,
    });
    const summary = {
      world: lockedConfig.world,
      cosId: lockedConfig.cos.id,
      assetRecipeVersion: lockedConfig.design.assetRecipeVersion,
      assetCatalogFingerprint: Object.values(lockedConfig.design.assetResolutions)[0]?.catalogFingerprint || null,
      ...plan.summary,
    };
    const projection = await recordProjection({ success: true, summary });
    // Persist the complete legend for the drawer before selecting the compact
    // result used by tools, scheduled jobs, and boot reconciliation.
    // `projectEidoverseWorld` is already atomic — `applyProjectionPlan` above
    // rolls a failed run all the way back to the prior authoritative design —
    // so a resolved promise here always means the whole plan committed. This
    // flag exists purely so callers can read the same accept/refuse contract
    // (#7454) as `eidoverse.augment` without special-casing this tool.
    if (compact) {
      const { objects, ...counts } = summary;
      return { success: true, committed: true, summary: { ...counts, objectCount: objects.length }, presence: presenceSummary(presence) };
    }
    const appliedConfig = configFromState(await loadState(), getCosPresence());
    return {
      success: true,
      committed: true,
      summary,
      projection,
      presence: presenceSummary(presence),
      design: appliedConfig.design,
      recipe: appliedConfig.recipe,
    };
  };

  return worldLock(() => run().catch(async (error) => {
    await recordProjection({ success: false, error });
    throw error;
  }));
}

/**
 * Boot-time, non-AI reconciliation for an update-prepared design. It never
 * starts or installs the external runtime: if Eidoverse is not already online,
 * the pending checkpoint remains visible for the page to remediate later.
 */
async function recoverInterruptedProjection() {
  const state = await loadState();
  if (!['applying', 'compensating'].includes(state.reconciliation.status)) {
    return { recovered: false, state };
  }
  const interruptedStatus = state.reconciliation.status;
  const recoveredState = await mutateState((current) => {
    current.pendingDesignVersion = EIDOVERSE_WORLD_DESIGN_VERSION;
    current.reconciliation = {
      ...current.reconciliation,
      status: 'failed',
      checkpoint: 'interrupted',
      error: 'The previous Eidoverse projection stopped before it completed. Retry the world update.',
      errorCode: 'EIDOVERSE_PROJECTION_INTERRUPTED',
      errorContext: null,
      completedAt: new Date().toISOString(),
      ...(interruptedStatus === 'compensating' ? { compensationStatus: 'interrupted' } : {}),
    };
    return clone(current);
  });
  return { recovered: true, state: recoveredState };
}

export async function reconcilePendingEidoverseWorld({ verbIntervalMs } = {}) {
  const recovery = await recoverInterruptedProjection();
  if (recovery.recovered) return { reconciled: false, reason: 'interrupted' };
  const { features } = await getInstanceFeatures();
  if (features.find(({ id }) => id === 'eidoverse')?.enabled !== true) {
    return { reconciled: false, reason: 'feature-disabled' };
  }
  const setup = await getEidoverseStatus();
  const state = recovery.state;
  if (state.pendingDesignVersion !== EIDOVERSE_WORLD_DESIGN_VERSION
    || (state.lastAppliedDesignVersion === null && !state.migrationReport)) {
    return { reconciled: false, reason: 'current' };
  }
  if (!setup.installed) return { reconciled: false, reason: 'not-installed' };
  if (setup.runtimeStatus !== 'online') return { reconciled: false, reason: 'runtime-offline' };
  const result = await projectEidoverseWorld({ compact: true, verbIntervalMs });
  return { reconciled: true, result };
}

function objectArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ServerError('Eidoverse operation args must be an object.', {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  if (JSON.stringify(args).length > 8192) {
    throw new ServerError('Eidoverse operation args must be at most 8KB.', {
      status: 400,
      code: 'EIDOVERSE_ARGUMENT_INVALID',
    });
  }
  return args;
}

function normalizeAugmentOperation(operation) {
  const args = objectArgs(operation.args);
  switch (operation.verb) {
    case 'spawn': {
      const normalized = {
        id: validEntityId(args.id),
        lib: validAssetPath(args.lib),
        pos: args.pos === undefined ? [0, 0, 0] : vector3(args.pos, 'spawn.pos'),
        yaw: safeNumber(args.yaw, 'spawn.yaw', { fallback: 0 }),
        scale: safeNumber(args.scale, 'spawn.scale', { min: 0.01, max: 20, fallback: 1 }),
      };
      if (args.collide !== undefined) {
        if (!['box', 'exact'].includes(args.collide)) {
          throw new ServerError('spawn.collide must be box or exact.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
        }
        normalized.collide = args.collide;
      }
      return { verb: operation.verb, args: normalized };
    }
    case 'place': {
      const normalized = { id: validEntityId(args.id) };
      if (args.pos !== undefined) normalized.pos = vector3(args.pos, 'place.pos');
      if (args.yaw !== undefined) normalized.yaw = safeNumber(args.yaw, 'place.yaw');
      if (args.scale !== undefined) normalized.scale = safeNumber(args.scale, 'place.scale', { min: 0.01, max: 20 });
      if (Object.keys(normalized).length === 1) {
        throw new ServerError('place needs pos, yaw, or scale.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      return { verb: operation.verb, args: normalized };
    }
    case 'remove':
      return { verb: operation.verb, args: { id: validEntityId(args.id) } };
    case 'comp': {
      const id = validEntityId(args.id);
      const type = safeText(args.type, '').slice(0, 32);
      if (!COMPONENT_TYPE_RE.test(type)) {
        throw new ServerError('comp.type is invalid.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      const data = args.data === undefined ? null : args.data;
      if (JSON.stringify(data).length > 8192) {
        throw new ServerError('comp.data must be at most 8KB.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      return { verb: operation.verb, args: { id, type, data } };
    }
    case 'light':
      return {
        verb: operation.verb,
        args: {
          id: validEntityId(args.id),
          pos: args.pos === undefined ? [0, 1, 0] : vector3(args.pos, 'light.pos'),
          color: safeNumber(args.color, 'light.color', { min: 0, max: 0xffffff, fallback: 0xffd9a0 }),
          intensity: safeNumber(args.intensity, 'light.intensity', { min: 0, max: 100, fallback: 16 }),
          range: safeNumber(args.range, 'light.range', { min: 0.1, max: 100, fallback: 10 }),
        },
      };
    case 'grant': {
      const id = validEntityId(args.id);
      const normalized = { id };
      if (args.role !== undefined) {
        // null clears the role: the world has no revoke verb (guest revocation).
        if (args.role !== null && !['owner', 'builder', 'visitor'].includes(args.role)) {
          throw new ServerError('grant.role must be owner, builder, visitor, or null.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
        }
        normalized.role = args.role;
      }
      if (args.gen !== undefined) {
        if (typeof args.gen !== 'boolean') {
          throw new ServerError('grant.gen must be boolean.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
        }
        normalized.gen = args.gen;
      }
      if (!Object.hasOwn(normalized, 'role') && !Object.hasOwn(normalized, 'gen')) {
        throw new ServerError('grant needs role or gen.', { status: 400, code: 'EIDOVERSE_ARGUMENT_INVALID' });
      }
      return { verb: operation.verb, args: normalized };
    }
    case 'terrain':
    case 'grass':
    case 'sky':
      return { verb: operation.verb, args: JSON.parse(JSON.stringify(args)) };
    default:
      throw new ServerError(`Eidoverse verb is not available through PortOS: ${operation.verb}`, {
        status: 400,
        code: 'EIDOVERSE_ARGUMENT_INVALID',
      });
  }
}

// SwarmWorld's core lesson, applied to Eidoverse construction tools: a mind
// PROPOSES structured intent, and only the world's own ack determines the
// CONSEQUENCE. `proposeAugmentOperation` never throws — an operation that
// fails PortOS's own bounds check becomes a `refused` outcome the batch can
// report, exactly like a refusal from the world itself, so one malformed
// operation in a batch cannot make an unrelated valid one silently disappear
// into a thrown error.
function proposeAugmentOperation(operation) {
  const id = typeof operation?.args?.id === 'string' ? operation.args.id.slice(0, 64) : null;
  try {
    const normalized = normalizeAugmentOperation(operation);
    return { ok: true, verb: normalized.verb, id: typeof normalized.args.id === 'string' ? normalized.args.id : id, args: normalized.args };
  } catch (error) {
    return { ok: false, verb: operation?.verb ?? null, id, reason: safeText(error?.message, 'Eidoverse refused this proposal.', 300) };
  }
}

function refusedAugmentOutcome(proposal, { proposed = null, reason }) {
  return { verb: proposal.verb, id: proposal.id, outcome: 'refused', proposed, committed: null, reason };
}

// A world ack is the only authority on whether — and how — a proposal landed.
// The world may accept it verbatim, silently rewrite it (e.g. clamp a
// position), or refuse it outright (`type: 'error'`, surfaced by
// connection.sendVerb as a rejection). Comparing the ack's args back against
// what was proposed is what lets a `rewritten` outcome exist at all.
async function commitAugmentProposal(connection, proposal, { signal, pacing, verbIntervalMs }) {
  const entry = await sendPacedVerb(connection, proposal.verb, proposal.args, { signal, pacing, verbIntervalMs });
  const committed = entry?.args ?? proposal.args;
  const rewritten = canonicalStringify(committed) !== canonicalStringify(proposal.args);
  return { verb: proposal.verb, id: proposal.id, outcome: rewritten ? 'rewritten' : 'accepted', proposed: proposal.args, committed };
}

export async function augmentEidoverseWorld(operations, { signal, verbIntervalMs } = {}) {
  return worldLock(async () => {
    throwIfAborted(signal);
    await assertInstalled();
    const presence = await ensureCosPresenceInternal({ signal, verbIntervalMs });
    const proposals = operations.map(proposeAugmentOperation);
    const results = [];
    // A refusal from the world (as opposed to a local validation refusal)
    // halts the rest of the batch: later operations often reference an id an
    // earlier one was supposed to create, so continuing to send them past a
    // world-level refusal would just compound an already-refused proposal.
    let worldRefused = false;
    for (const proposal of proposals) {
      if (worldRefused) {
        results.push(refusedAugmentOutcome(proposal, {
          proposed: proposal.ok ? proposal.args : null,
          reason: 'Not attempted: an earlier operation in this batch was refused by the world.',
        }));
        continue;
      }
      if (!proposal.ok) {
        results.push(refusedAugmentOutcome(proposal, { reason: proposal.reason }));
        continue;
      }
      throwIfAborted(signal);
      // Verbs apply in submitted order over one paced connection; the world
      // protocol has no batch form, so this await is intentionally serial.
      const outcome = await commitAugmentProposal(presence.connection, proposal, { signal, pacing: presence.pacing, verbIntervalMs })
        .catch((error) => {
          if (error?.name === 'AbortError') throw error;
          worldRefused = true;
          return refusedAugmentOutcome(proposal, { proposed: proposal.args, reason: safeText(error?.message, 'Eidoverse refused this operation.', 300) });
        });
      results.push(outcome);
    }
    const committedCount = results.filter((result) => result.outcome !== 'refused').length;
    return {
      success: committedCount === results.length,
      world: presence.connection.world,
      // `applied` is the pre-existing committed-count field; `operations`
      // carries the full proposed/committed breakdown per #7454.
      applied: committedCount,
      operations: results,
      presence: presenceSummary(presence),
    };
  });
}
