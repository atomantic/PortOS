/**
 * Autonomous-job cadence vocabulary (#6375).
 *
 * Two contracts that a higher-level test can't pin cheaply:
 *  - `resolveIntervalMs` must return an explicit no-interval sentinel rather
 *    than falling through to `DAY`. The fall-through was silent, so only a
 *    direct assertion catches its return.
 *  - the client mirror in `client/src/utils/cronHelpers.js` is hand-maintained.
 *    A row added on one side only would leave a cadence the server accepts
 *    invisible in the picker (or a picker row the Zod enum rejects), so the
 *    mirror is compared by reading the client source rather than importing it
 *    (a server test that imports a client module breaks CI dependency-wise).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDeclaration } from './mirrorParity.js';

// Declared here rather than imported from fileUtils: this suite's whole point is
// that autonomousJobIntervals.js stays import-free, and pulling fileUtils in
// through the test would put its closure back into the suite's import budget.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
import {
  INTERVAL_OPTIONS,
  JOB_INTERVAL_VALUES,
  ON_DEMAND_INTERVAL,
  isOnDemandJob,
  resolveIntervalMs
} from './autonomousJobIntervals.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(HERE, '../../client/src/utils/cronHelpers.js');

describe('resolveIntervalMs', () => {
  it('returns the no-interval sentinel for the on-demand cadence — not DAY, not NaN', () => {
    const resolved = resolveIntervalMs(ON_DEMAND_INTERVAL);
    expect(resolved).toBeNull();
    expect(resolved).not.toBe(DAY);
    expect(Number.isNaN(resolved)).toBe(false);
  });

  it('no longer falls through to DAY for a cadence outside the vocabulary', () => {
    // The `default: return DAY` this replaced turned a typo'd cadence into a
    // daily job that nobody asked for.
    expect(resolveIntervalMs('dailyy')).toBeNull();
    expect(resolveIntervalMs(undefined)).toBeNull();
  });

  it('resolves every recurring option to its declared duration', () => {
    for (const opt of INTERVAL_OPTIONS) {
      expect(resolveIntervalMs(opt.value), opt.value).toBe(opt.ms);
    }
  });

  it('custom uses the caller-supplied duration and falls back to a day', () => {
    expect(resolveIntervalMs('custom', 90_000)).toBe(90_000);
    expect(resolveIntervalMs('custom')).toBe(DAY);
  });

  it('JOB_INTERVAL_VALUES covers every option plus custom', () => {
    expect(JOB_INTERVAL_VALUES).toEqual([...INTERVAL_OPTIONS.map(o => o.value), 'custom']);
  });
});

describe('isOnDemandJob', () => {
  it('is true for the cadence and for a job left with no resolvable interval', () => {
    expect(isOnDemandJob({ interval: ON_DEMAND_INTERVAL, intervalMs: null })).toBe(true);
    expect(isOnDemandJob({ interval: 'daily', intervalMs: null })).toBe(true);
  });

  it('is false for a recurring job', () => {
    expect(isOnDemandJob({ interval: 'daily', intervalMs: DAY })).toBe(false);
  });

  it('is false for a cron-mode job that kept a stale on-demand cadence', () => {
    // Switching a job to Cron does not rewrite `interval`, so the cron fields
    // have to win or the job would silently stop firing.
    expect(isOnDemandJob({ interval: ON_DEMAND_INTERVAL, intervalMs: null, cronExpression: '0 4 * * *' })).toBe(false);
    expect(isOnDemandJob({ interval: ON_DEMAND_INTERVAL, intervalMs: null, cronSchedule: { kind: 'DAILY' } })).toBe(false);
  });
});

describe('client JOB_INTERVAL_OPTIONS mirror', () => {
  const clientSrc = readFileSync(CLIENT_PATH, 'utf8');
  const clientDecl = extractDeclaration(clientSrc, 'JOB_INTERVAL_OPTIONS');

  // Parses `{ value: X, label: 'Y' }` rows — X is a quoted literal for most
  // rows and the ON_DEMAND_INTERVAL identifier for the on-demand one.
  const ROW_RE = /\{\s*value:\s*(?:'([^']+)'|([A-Z_][A-Z0-9_]*))\s*,\s*label:\s*'([^']+)'\s*\}/g;
  const clientRows = [...(clientDecl ?? '').matchAll(ROW_RE)].map(m => ({
    value: m[1] ?? (m[2] === 'ON_DEMAND_INTERVAL' ? ON_DEMAND_INTERVAL : m[2]),
    label: m[3]
  }));

  it('finds the client declaration and parses every row', () => {
    expect(clientDecl, 'client cronHelpers.js is missing JOB_INTERVAL_OPTIONS').not.toBeNull();
    expect(clientRows.length).toBe(INTERVAL_OPTIONS.length);
  });

  it('carries the same values and labels, in the same order, as the server list', () => {
    expect(clientRows).toEqual(INTERVAL_OPTIONS.map(({ value, label }) => ({ value, label })));
  });

  it('declares the on-demand cadence with the same string the server validates', () => {
    expect(clientSrc).toContain(`export const ON_DEMAND_INTERVAL = '${ON_DEMAND_INTERVAL}';`);
  });
});
