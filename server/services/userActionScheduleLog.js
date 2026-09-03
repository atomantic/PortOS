/**
 * Operator-action rows for CoS schedule writes that do not go through
 * PUT /api/settings (#5596). Changed keys only; long prompt/description
 * bodies are recorded as `{ changed: true }`, never copied in.
 */

import { recordUserAction } from './userActions.js';

const SHORT_SCALAR_MAX = 120;

const isShortScalar = (value) => (
  value === null
  || typeof value === 'boolean'
  || typeof value === 'number'
  || (typeof value === 'string' && value.length <= SHORT_SCALAR_MAX)
);

export function scheduleChangePayload(patch) {
  const keysChanged = Object.keys(patch || {})
    .filter((key) => patch[key] !== undefined)
    .sort();
  const changes = {};
  for (const key of keysChanged) {
    const value = patch[key];
    changes[key] = isShortScalar(value) ? { to: value } : { changed: true };
  }
  return { keysChanged, changes };
}

export async function logCosScheduleUpdate({ target, patch, source, extra = {} } = {}) {
  const { keysChanged, changes } = scheduleChangePayload(patch);
  if (keysChanged.length === 0) return null;
  try {
    const happenedAt = new Date().toISOString();
    return await recordUserAction({
      type: 'cos.schedule.update',
      actor: 'user',
      target,
      summary: `Updated CoS schedule: ${keysChanged.join(', ')}`,
      payload: { keysChanged, changes, ...extra },
      source,
      happenedAt,
      dedupeKey: `cos.schedule.update:${target}:${happenedAt}:${keysChanged.join(',').slice(0, 200)}`,
    });
  } catch (error) {
    console.error(`❌ Failed to record cos.schedule.update: ${error.message}`);
    return null;
  }
}
