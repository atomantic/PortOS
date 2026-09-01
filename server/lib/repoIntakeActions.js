/**
 * The opt-in post-clone agent actions a Brain capture can request for a
 * repo URL. Pure — the queueing itself lives in `services/repoIntake.js`, which
 * pulls the whole CoS task graph; this half is safe to import from the link
 * write path and from the Zod schemas.
 *
 * `malwareScan` → the read-only `/do:scan` audit of the clone.
 * `learn`       → a `repo-study` review: read the clone for feature/design ideas worth adopting
 *                 into PortOS and file them in the work tracker (clean-room).
 */

import { isPlainObject } from './objects.js';
import { EFFORT_LEVELS } from './providerModels.js';

export const REPO_INTAKE_KEYS = ['malwareScan', 'learn'];

const normalizeOptionalString = (value, maxLength) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
};

const normalizeOptionalEffort = (value) => {
  const effort = normalizeOptionalString(value, 32)?.toLowerCase();
  return effort && EFFORT_LEVELS.includes(effort) ? effort : undefined;
};

/**
 * Normalize a client-supplied intake object to the two action booleans plus
 * optional repo-study context/provider pins, or null when nothing was requested.
 *
 * Returning null rather than an all-false object matters: it's what keeps
 * "the user ticked nothing" from being persisted onto every captured link and
 * from scheduling a no-op intake pass after each clone.
 *
 * @param {unknown} input
 * @returns {{ malwareScan: boolean, learn: boolean, targetAppId?: string, studyContext?: string, providerId?: string, model?: string, effort?: string } | null}
 */
export function normalizeRepoIntake(input) {
  if (!isPlainObject(input)) return null;
  const normalized = Object.fromEntries(REPO_INTAKE_KEYS.map(key => [key, input[key] === true]));
  if (!REPO_INTAKE_KEYS.some(key => normalized[key])) return null;
  if (normalized.learn && typeof input.targetAppId === 'string' && input.targetAppId.trim()) {
    normalized.targetAppId = input.targetAppId.trim();
  }
  if (normalized.learn && typeof input.studyContext === 'string' && input.studyContext.trim()) {
    normalized.studyContext = input.studyContext.trim();
  }
  if (normalized.learn) {
    const providerId = normalizeOptionalString(input.providerId, 120);
    const model = normalizeOptionalString(input.model, 200);
    const effort = normalizeOptionalEffort(input.effort);
    if (providerId) normalized.providerId = providerId;
    if (model) normalized.model = model;
    if (effort) normalized.effort = effort;
  }
  return normalized;
}
