/** Sync only the fields MortalLoom and PortOS both understand. Planning data lives in PortOS. */
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { storeFailure } from './mortalLoomCommit.js';
import { NATIVE_CATEGORIES, NATIVE_GOAL_STATUSES, NATIVE_GOAL_TYPES, NATIVE_HORIZONS } from './mortalLoomSchema.js';

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const knownPrefix = /^(?:goal|ms|ci)-/;
const explicitGoalFields = ['priority', 'checkInIntervalDays', 'mutedSignals', 'resolvedSignals', 'geneticEvidence', 'deferredUntil', 'completedDate'];
const checkInFields = ['progressPct', 'note', 'alignmentRating', 'blockers', 'commitments', 'promptAnswered'];
const has = (row, field) => Object.hasOwn(row, field);
const oneOf = (value, choices) => choices.includes(value) ? value : undefined;
const dateOnly = text => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined;
const addOptional = (out, value, fields) => {
  for (const field of fields) if (has(value, field)) out[field] = value[field];
  return out;
};

// Legacy PortOS rows use the same UUID with a type prefix. Keep the PortOS
// alias for existing references while using the stable unprefixed wire ID.
export function nativeGoalId(id) {
  const plain = typeof id === 'string' ? id.replace(knownPrefix, '') : '';
  return uuid.test(plain) ? plain.toUpperCase() : null;
}

function wireId(id) {
  const nativeId = nativeGoalId(id);
  if (!nativeId) throw storeFailure('invalid');
  return nativeId;
}

function milestoneWire(row) {
  const out = { id: wireId(row.id), title: row.title, completed: Boolean(row.completedAt || row.completed) };
  const completedDate = dateOnly(row.completedAt ?? row.completedDate);
  if (out.completed && completedDate) out.completedDate = completedDate;
  return out;
}

const isNativeCheckIn = row => nativeGoalId(row.id) && !row.id.startsWith('ci-') && (has(row, 'progressPct') || has(row, 'note'));
function checkInWire(row) {
  return addOptional({ id: wireId(row.id), date: row.date }, row, checkInFields);
}

function goalWire(goal) {
  return addOptional({
    id: wireId(goal.id), title: goal.title, notes: goal.description ?? goal.notes ?? '',
    createdDate: dateOnly(goal.createdDate ?? goal.createdAt),
    targetDate: goal.targetDate ?? null, parentId: goal.parentId == null ? null : wireId(goal.parentId),
    status: oneOf(goal.status, NATIVE_GOAL_STATUSES) ?? 'active',
    horizon: oneOf(goal.horizon, NATIVE_HORIZONS),
    category: oneOf(goal.category, NATIVE_CATEGORIES), goalType: oneOf(goal.goalType, NATIVE_GOAL_TYPES),
    milestones: (goal.milestones ?? []).map(milestoneWire),
    checkIns: (goal.checkIns ?? []).filter(isNativeCheckIn).map(checkInWire),
  }, goal, explicitGoalFields);
}

function localByWire(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = nativeGoalId(row.id);
    if (!id) continue;
    if (byId.has(id)) throw storeFailure('invalid');
    byId.set(id, row);
  }
  return byId;
}

function mergeNativeMilestones(native, local) {
  const byId = localByWire(local ?? []);
  return (native ?? []).map(row => {
    const extra = byId.get(nativeGoalId(row.id));
    return {
      ...extra, ...row, id: extra?.id ?? row.id,
      completedAt: row.completed ? row.completedDate ?? extra?.completedAt ?? row.createdDate ?? 'completed' : null,
    };
  });
}

export function overlayMortalLoomGoals(native, local) {
  const byId = localByWire(local ?? []);
  const aliases = new Map(native.map(row => {
    const id = nativeGoalId(row.id);
    return [id, byId.get(id)?.id ?? row.id];
  }));
  return native.map(row => {
    const extra = byId.get(nativeGoalId(row.id));
    const result = {
      // Preserve PortOS-only values that older versions wrote to the cloud
      // until the next physical local save migrates them into this overlay.
      ...row, ...extra, id: extra?.id ?? row.id, title: row.title, notes: row.notes ?? '',
      description: row.notes ?? row.description ?? '', createdDate: row.createdDate,
      targetDate: row.targetDate ?? null, status: row.status ?? 'active',
      parentId: aliases.get(nativeGoalId(row.parentId)) ?? row.parentId ?? null,
      milestones: mergeNativeMilestones(row.milestones, extra?.milestones),
      checkIns: [...(row.checkIns ?? []), ...(extra?.checkIns ?? row.checkIns ?? []).filter(e => !isNativeCheckIn(e))],
    };
    // Native fields cannot survive from the overlay after an explicit native clear.
    for (const field of explicitGoalFields) {
      if (has(row, field)) result[field] = row[field];
      else delete result[field];
    }
    for (const [field, choices] of [['horizon', NATIVE_HORIZONS], ['category', NATIVE_CATEGORIES], ['goalType', NATIVE_GOAL_TYPES]]) {
      if (row[field] != null) result[field] = row[field];
      else if (extra?.[field] && !choices.includes(extra[field])) result[field] = extra[field];
      else delete result[field];
    }
    const lastProgress = row.checkIns?.findLast(item => typeof item.progressPct === 'number');
    if (lastProgress) result.progress = lastProgress.progressPct;
    else if (row.checkIns?.length) result.progress = 0;
    return result;
  });
}

function same(a, b) {
  // Null/omitted optional keys have the same Codable value.
  return (a == null && b == null) || isDeepStrictEqual(a, b);
}

function changedFields(current, old, next, fields) {
  const merged = { ...current };
  for (const field of fields) {
    if (same(old[field], next[field])) continue;
    if (!same(current[field], old[field]) && !same(current[field], next[field])) throw storeFailure('revisionChanged');
    if (next[field] === undefined) delete merged[field];
    else merged[field] = next[field];
  }
  return merged;
}

function reconcileRows(current, old, next, normalize, update) {
  const oldById = localByWire(old);
  const nextById = localByWire(next);
  const currentById = localByWire(current);
  const result = new Map(currentById);
  for (const [id, prior] of oldById) {
    const desired = nextById.get(id);
    const actual = currentById.get(id);
    if (!desired) {
      if (actual && !isDeepStrictEqual(normalize(actual), normalize(prior))) throw storeFailure('revisionChanged');
      result.delete(id);
    } else if (!isDeepStrictEqual(prior, desired)) {
      if (!actual) throw storeFailure('revisionChanged');
      result.set(id, update(actual, prior, desired));
    }
  }
  for (const [id, fresh] of nextById) {
    if (oldById.has(id)) continue;
    if (currentById.has(id)) throw storeFailure('revisionChanged');
    result.set(id, fresh);
  }
  return [...result.values()];
}

const scalarFields = ['title', 'notes', 'targetDate', 'parentId', 'status', 'horizon', 'category', 'goalType', ...explicitGoalFields];
const milestoneFields = ['title', 'completed', 'completedDate'];
const checkInPatch = ['date', ...checkInFields];
const normalizedEquality = row => Object.fromEntries(Object.entries(row).filter(([, value]) => value != null));

// Compare changes against the current *canonical* fields, not the local UI
// result. Item-level merging preserves independently added children/check-ins.
function patchGoal(current, before, after) {
  // Project known defaults from the actual cloud row exactly as the read side did.
  const comparable = goalWire({ ...current, description: current.notes ?? current.description });
  return {
    ...current,
    ...Object.fromEntries(scalarFields.filter(field => !same(before[field], after[field])).map(field => {
      if (!same(comparable[field], before[field]) && !same(comparable[field], after[field])) throw storeFailure('revisionChanged');
      return [field, after[field]];
    })),
    ...(isDeepStrictEqual(before.milestones, after.milestones) ? {} : { milestones: reconcileRows(
      current.milestones ?? [], before.milestones, after.milestones, milestoneWire,
      (row, old, next) => changedFields(row, old, next, milestoneFields),
    ) }),
    ...(isDeepStrictEqual(before.checkIns, after.checkIns) ? {} : { checkIns: reconcileRows(
      current.checkIns ?? [], before.checkIns, after.checkIns, checkInWire,
      (row, old, next) => changedFields(row, old, next, checkInPatch),
    ) }),
  };
}

export function applyMortalLoomGoalChanges(native, previous, desired) {
  const old = previous.map(goalWire);
  const previousById = localByWire(previous);
  const next = desired.map(goal => {
    const row = goalWire(goal);
    const prior = previousById.get(row.id);
    if (prior && typeof goal.progress === 'number' && (prior.progress ?? 0) !== goal.progress) {
      const date = dateOnly(goal.progressHistory?.at(-1)?.date ?? goal.updatedAt);
      if (!date) throw storeFailure('invalid');
      row.checkIns.push({ id: randomUUID().toUpperCase(), date, progressPct: goal.progress, note: '' });
    }
    return row;
  });
  for (const row of [...old, ...next]) {
    if (row.createdDate === undefined && !old.some(prior => prior.id === row.id)) throw storeFailure('invalid');
  }
  const current = native;
  const merged = reconcileRows(current, old, next,
    row => normalizedEquality(goalWire({ ...row, milestones: row.milestones, checkIns: row.checkIns })),
    patchGoal,
  );
  if (isDeepStrictEqual(merged, current)) return false;
  native.splice(0, native.length, ...merged);
  return true;
}
