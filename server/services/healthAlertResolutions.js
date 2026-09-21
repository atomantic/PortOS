/** Machine-local acknowledgement baselines; source evidence remains untouched. */
import { createHash } from 'node:crypto';
import { listReviewQueueTriage, upsertReviewQueueTriage } from './reviewQueueTriageStore.js';

export const HEALTH_RESOLUTION_PREFIX = 'health.resolved:';

// A resolution is its own action occurrence. Reuse the existing durable triage
// identity: occurrence records when it happened, revision fingerprints evidence.
// No titles, personal records, or copies of source payloads are persisted.
export async function getHealthAlertResolutions() {
  const entries = await listReviewQueueTriage();
  const resolutions = new Map();
  for (const entry of entries) {
    if (!entry.actionKey.startsWith(HEALTH_RESOLUTION_PREFIX) || !Number.isFinite(Date.parse(entry.occurrence))) continue;
    const id = entry.actionKey.slice(HEALTH_RESOLUTION_PREFIX.length);
    if (!resolutions.has(id) || Date.parse(entry.occurrence) > Date.parse(resolutions.get(id).at)) {
      resolutions.set(id, { at: entry.occurrence, evidence: entry.revision });
    }
  }
  return resolutions;
}

export function healthAlertEvidence(alert) {
  // Producers supply stable evidence, not rolling display text (e.g. days ago).
  const evidence = alert.evidence ?? alert.metadata ?? { message: alert.detail || alert.message };
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

export async function recordHealthAlertResolution(alert, now = new Date()) {
  return upsertReviewQueueTriage({
    actionKey: `${HEALTH_RESOLUTION_PREFIX}${alert.id}`,
    occurrence: now.toISOString(),
    revision: healthAlertEvidence(alert),
    dismissed: true,
  });
}
