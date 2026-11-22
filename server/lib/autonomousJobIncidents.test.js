import { describe, it, expect } from 'vitest';
import {
  normalizeFailureSignature,
  excerptFailure,
  recordFailure,
  recordSuccess,
  acknowledgeIncident,
  isUnreachableError,
  nextUnreachableRetryDelayMs,
  UNREACHABLE_RETRY_DELAYS_MS,
  MAX_EXCERPT_CHARS,
} from './autonomousJobIncidents.js';

const HOUR = 3_600_000;
let counter = 0;
const idFactory = () => `inc-${++counter}`;
const fail = (incidents, error, now) => recordFailure(incidents, { jobId: 'job-a', error, now, idFactory });

describe('normalizeFailureSignature', () => {
  it('collapses timestamps, durations, uuids, run ids and counters into one signature', () => {
    const a = 'Spawn failed at 2026-11-22T08:15:01.123Z after 4500ms for run agent-0aa7b2aa (id 3f2b1c9e-1111-4222-8333-444455556666), retry 2';
    const b = 'Spawn failed at 2026-11-23T09:20:44Z after 12 seconds for run agent-ffe01234 (id aaaaaaaa-0000-4000-8000-bbbbbbbbbbbb), retry 3';
    expect(normalizeFailureSignature(a)).toBe(normalizeFailureSignature(b));
  });

  it('keeps genuinely different errors apart', () => {
    expect(normalizeFailureSignature('Provider has no credential')).not.toBe(normalizeFailureSignature('Repo path is missing'));
  });

  it('never leaks a secret into the signature and tolerates empty input', () => {
    expect(normalizeFailureSignature('auth failed sk-ant-abcdefghijklmnop1234567890')).not.toContain('abcdefghijklmnop');
    expect(normalizeFailureSignature('')).toBe('unknown');
    expect(normalizeFailureSignature(undefined)).toBe('unknown');
  });
});

describe('excerptFailure', () => {
  it('redacts secrets and caps length', () => {
    const out = excerptFailure(`token ghp_${'a'.repeat(30)} ${'x'.repeat(900)}`);
    expect(out).toContain('[REDACTED]');
    expect(out.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
  });
});

describe('incident lifecycle', () => {
  const t0 = Date.parse('2026-11-22T00:00:00Z');

  it('alerts on the first failure, counts silent repeats, and reminds only after the cooldown', () => {
    const first = fail([], 'boom after 3s', t0);
    expect(first.shouldAlert).toBe(true);
    expect(first.incident).toMatchObject({ state: 'alerted', occurrenceCount: 1 });

    const second = fail(first.incidents, 'boom after 9s', t0 + HOUR);
    expect(second.shouldAlert).toBe(false);
    expect(second.incidents).toHaveLength(1);
    expect(second.incident.occurrenceCount).toBe(2);

    const reminder = fail(second.incidents, 'boom after 1s', t0 + 6 * HOUR);
    expect(reminder.shouldAlert).toBe(true);
    expect(reminder.incident.lastAlertedAt).toBe(new Date(t0 + 6 * HOUR).toISOString());
  });

  it('mints a new incident and alerts immediately when the signature changes', () => {
    const first = fail([], 'boom', t0);
    const other = fail(first.incidents, 'a different failure', t0 + 1000);
    expect(other.shouldAlert).toBe(true);
    expect(other.created).toBe(true);
    expect(other.incidents).toHaveLength(2);
  });

  it('resolves detected/alerted incidents on success but leaves acknowledged ones alone', () => {
    const a = fail([], 'first failure', t0);
    const b = fail(a.incidents, 'second failure', t0 + 1000);
    const acked = acknowledgeIncident(b.incidents, b.incident.id, t0 + 2000);
    const { incidents, resolved } = recordSuccess(acked.incidents, { jobId: 'job-a', now: t0 + 3000 });
    expect(resolved.map(i => i.id)).toEqual([a.incident.id]);
    expect(incidents.find(i => i.id === b.incident.id).state).toBe('acknowledged');
  });

  it('an acknowledged incident never re-alerts for the same signature, but a new one does', () => {
    const first = fail([], 'boom', t0);
    const acked = acknowledgeIncident(first.incidents, first.incident.id, t0 + 1);
    const repeat = fail(acked.incidents, 'boom', t0 + 24 * HOUR);
    expect(repeat.shouldAlert).toBe(false);
    expect(repeat.incident.state).toBe('acknowledged');
    expect(fail(repeat.incidents, 'new problem', t0 + 25 * HOUR).shouldAlert).toBe(true);
  });

  it('a resolved failure that recurs opens a fresh incident', () => {
    const first = fail([], 'boom', t0);
    const { incidents } = recordSuccess(first.incidents, { jobId: 'job-a', now: t0 + 1 });
    const again = fail(incidents, 'boom', t0 + 2);
    expect(again.created).toBe(true);
    expect(again.shouldAlert).toBe(true);
  });

  it('acknowledge refuses unknown and resolved ids', () => {
    const first = fail([], 'boom', t0);
    expect(acknowledgeIncident(first.incidents, 'nope')).toBeNull();
    const { incidents } = recordSuccess(first.incidents, { jobId: 'job-a' });
    expect(acknowledgeIncident(incidents, first.incident.id)).toBeNull();
  });
});

describe('unreachable retry ladder', () => {
  it('recognizes transient network failures only', () => {
    expect(isUnreachableError('getaddrinfo ENOTFOUND api.example.com')).toBe(true);
    expect(isUnreachableError('connect ETIMEDOUT 192.0.2.1:443')).toBe(true);
    expect(isUnreachableError('401 invalid api key')).toBe(false);
    expect(isUnreachableError(undefined)).toBe(false);
  });

  it('steps 5m → 15m → 30m then exhausts', () => {
    const now = 1_000_000;
    expect([0, 1, 2].map(step => nextUnreachableRetryDelayMs(step, { now }))).toEqual([...UNREACHABLE_RETRY_DELAYS_MS]);
    expect(nextUnreachableRetryDelayMs(3, { now })).toBeNull();
    expect(nextUnreachableRetryDelayMs(-1, { now })).toBeNull();
  });

  it('never lands at or past the next natural occurrence', () => {
    const now = 1_000_000;
    expect(nextUnreachableRetryDelayMs(0, { now, nextNaturalFireAt: now + 5 * 60_000 })).toBeNull();
    expect(nextUnreachableRetryDelayMs(0, { now, nextNaturalFireAt: now + 5 * 60_000 + 1 })).toBe(5 * 60_000);
    expect(nextUnreachableRetryDelayMs(2, { now, nextNaturalFireAt: now + 20 * 60_000 })).toBeNull();
  });
});
