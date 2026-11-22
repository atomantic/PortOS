/**
 * Pure rules for autonomous-job failure incidents and the zero-spend unreachable retry ladder.
 *
 * `normalizeFailureSignature` collapses volatile fragments (timestamps, durations, UUIDs, run ids, hex, numbers) so the same failure repeating on every tick maps to one `(jobId, signature)` incident; `excerptFailure` secret-redacts and caps the stored sample. `recordFailure` / `recordSuccess` / `acknowledgeIncident` are the incident state machine (`detected` → `alerted` → `resolved`, or `acknowledged`) over a plain array, returning the next array plus whether the caller should notify. `isUnreachableError` and `nextUnreachableRetryDelayMs` decide when a pre-LLM transient network failure earns the 5m → 15m → 30m retry ladder, clamped before the job's next natural fire. No I/O: persistence lives in `services/autonomousJobs/incidents.js`.
 */

import { scrubSecretTokens } from './secretText.js';

export const INCIDENT_STATES = Object.freeze({
  DETECTED: 'detected',
  ALERTED: 'alerted',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
});

export const DEFAULT_REMINDER_COOLDOWN_HOURS = 6;
export const MAX_EXCERPT_CHARS = 500;
/** Resolved incidents kept per job so the file stays bounded. */
export const MAX_RESOLVED_PER_JOB = 5;

const OPEN_STATES = new Set([INCIDENT_STATES.DETECTED, INCIDENT_STATES.ALERTED, INCIDENT_STATES.ACKNOWLEDGED]);

export const UNREACHABLE_RETRY_DELAYS_MS = Object.freeze([5 * 60_000, 15 * 60_000, 30 * 60_000]);

const UNREACHABLE_PATTERN = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|network is unreachable|network error|getaddrinfo|dns (?:lookup|resolution)|could not resolve host|fetch failed|socket hang up|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET)/i;

/** True when an error message names a transient network/DNS/unreachable failure. */
export function isUnreachableError(message) {
  return typeof message === 'string' && UNREACHABLE_PATTERN.test(message);
}

/** Stable, secret-free signature for a failure message; empty input yields `unknown`. */
export function normalizeFailureSignature(message) {
  const text = scrubSecretTokens(String(message ?? ''));
  const normalized = text
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b(?:agent|run|task|job)[-_][a-z0-9-]*\d[a-z0-9-]*\b/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/g, '<dur>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'unknown';
}

/** Redacted, length-capped error excerpt for storage and notifications. */
export function excerptFailure(message) {
  const text = scrubSecretTokens(String(message ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS - 1)}…` : text;
}

export const isOpenIncident = (incident) => OPEN_STATES.has(incident?.state);

function pruneResolved(incidents, jobId) {
  const resolved = incidents
    .filter((i) => i.jobId === jobId && i.state === INCIDENT_STATES.RESOLVED)
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const drop = new Set(resolved.slice(MAX_RESOLVED_PER_JOB).map((i) => i.id));
  return drop.size ? incidents.filter((i) => !drop.has(i.id)) : incidents;
}

/**
 * Fold one failure into the incident list.
 *
 * Same `(jobId, signature)` as an open incident → count it; alert only when still `detected` or the reminder cooldown elapsed
 * (an acknowledged incident never re-alerts). A new signature mints a new incident and alerts immediately.
 *
 * @returns {{ incidents: object[], incident: object, shouldAlert: boolean, created: boolean }}
 */
export function recordFailure(incidents, { jobId, error, now = Date.now(), reminderCooldownHours = DEFAULT_REMINDER_COOLDOWN_HOURS, idFactory }) {
  const signature = normalizeFailureSignature(error);
  const sampleError = excerptFailure(error);
  const nowIso = new Date(now).toISOString();
  const existing = incidents.find((i) => i.jobId === jobId && i.signature === signature && isOpenIncident(i));

  if (!existing) {
    const incident = {
      id: idFactory(),
      jobId,
      signature,
      sampleError,
      state: INCIDENT_STATES.ALERTED,
      occurrenceCount: 1,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      lastAlertedAt: nowIso,
    };
    return { incidents: pruneResolved([...incidents, incident], jobId), incident, shouldAlert: true, created: true };
  }

  const cooldownMs = reminderCooldownHours * 3_600_000;
  const lastAlertMs = Date.parse(existing.lastAlertedAt);
  const reminderDue = existing.state === INCIDENT_STATES.DETECTED
    || (existing.state === INCIDENT_STATES.ALERTED && (!Number.isFinite(lastAlertMs) || now - lastAlertMs >= cooldownMs));
  const incident = {
    ...existing,
    sampleError,
    occurrenceCount: existing.occurrenceCount + 1,
    lastSeenAt: nowIso,
    ...(reminderDue ? { state: INCIDENT_STATES.ALERTED, lastAlertedAt: nowIso } : {}),
  };
  return {
    incidents: incidents.map((i) => (i.id === existing.id ? incident : i)),
    incident,
    shouldAlert: reminderDue,
    created: false,
  };
}

/** A green run resolves the job's `detected`/`alerted` incidents; `acknowledged` ones stay as the operator left them. */
export function recordSuccess(incidents, { jobId, now = Date.now() }) {
  const nowIso = new Date(now).toISOString();
  const resolved = [];
  const next = incidents.map((i) => {
    if (i.jobId !== jobId || (i.state !== INCIDENT_STATES.DETECTED && i.state !== INCIDENT_STATES.ALERTED)) return i;
    const done = { ...i, state: INCIDENT_STATES.RESOLVED, resolvedAt: nowIso };
    resolved.push(done);
    return done;
  });
  return { incidents: resolved.length ? pruneResolved(next, jobId) : incidents, resolved };
}

/** Operator acknowledgement of an open incident; null when the id is unknown or already resolved. */
export function acknowledgeIncident(incidents, id, now = Date.now()) {
  const target = incidents.find((i) => i.id === id);
  if (!target || !isOpenIncident(target)) return null;
  const incident = { ...target, state: INCIDENT_STATES.ACKNOWLEDGED, acknowledgedAt: new Date(now).toISOString() };
  return { incidents: incidents.map((i) => (i.id === id ? incident : i)), incident };
}

/**
 * Delay before the next unreachable retry, or null when the ladder is exhausted or the retry would land
 * at/after the job's own next natural fire (that occurrence covers it). Clamped, never overshooting.
 */
export function nextUnreachableRetryDelayMs(step, { now = Date.now(), nextNaturalFireAt = null } = {}) {
  if (!Number.isInteger(step) || step < 0 || step >= UNREACHABLE_RETRY_DELAYS_MS.length) return null;
  const delay = UNREACHABLE_RETRY_DELAYS_MS[step];
  if (Number.isFinite(nextNaturalFireAt) && now + delay >= nextNaturalFireAt) return null;
  return delay;
}
