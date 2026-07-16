import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './192-post-dates-to-local-timezone.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 192 — normalize POST dates to the user local timezone', () => {
  let rootDir;
  let sessionsPath;
  let trainingPath;
  let settingsPath;

  let morsePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-192-'));
    mkdirSync(join(rootDir, 'data', 'meatspace'), { recursive: true });
    sessionsPath = join(rootDir, 'data', 'meatspace', 'post-sessions.json');
    trainingPath = join(rootDir, 'data', 'meatspace', 'post-training-log.json');
    morsePath = join(rootDir, 'data', 'meatspace', 'post-morse-progress.json');
    settingsPath = join(rootDir, 'data', 'settings.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops when no data files exist (and tz is set)', async () => {
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(existsSync(sessionsPath)).toBe(false);
    expect(existsSync(trainingPath)).toBe(false);
  });

  it('short-circuits with no file rewrites when the timezone resolves to UTC', async () => {
    writeJson(settingsPath, { timezone: 'UTC' });
    // A session whose UTC completion day differs from its stored date would be
    // rewritten if the migration ran — assert it is left untouched under UTC.
    writeJson(sessionsPath, {
      sessions: [{ id: 's1', date: '2026-07-16', completedAt: '2026-07-16T05:00:00.000Z' }],
    });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'utc-timezone' });
    expect(readJson(sessionsPath).sessions[0].date).toBe('2026-07-16');
  });

  it('re-derives a session date from completedAt in a non-UTC timezone', async () => {
    // 2026-07-16T05:00Z = 2026-07-15 22:00 PDT — stored under the UTC day, but the
    // session was completed on the user local day July 15.
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(sessionsPath, {
      sessions: [
        { id: 's1', date: '2026-07-16', completedAt: '2026-07-16T05:00:00.000Z', score: 80 },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(readJson(sessionsPath).sessions[0].date).toBe('2026-07-15');
  });

  it('does not collapse a genuinely-next-local-day session onto the prior day', async () => {
    // Two sessions: one completed local July 15 evening (UTC July 16), one local
    // July 16 evening (UTC July 17). Under local semantics they stay on distinct
    // days — the exact "missing day / collapse" case the migration prevents.
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(sessionsPath, {
      sessions: [
        { id: 's1', date: '2026-07-16', completedAt: '2026-07-16T05:00:00.000Z' },
        { id: 's2', date: '2026-07-17', completedAt: '2026-07-17T05:00:00.000Z' },
      ],
    });
    await migration.up({ rootDir });
    const days = readJson(sessionsPath).sessions.map((s) => s.date).sort();
    expect(days).toEqual(['2026-07-15', '2026-07-16']);
  });

  it('prefers startedAt over completedAt so a cross-midnight retry keeps its original day', async () => {
    // An idempotent re-submit preserves the original startedAt (local July 15)
    // but overwrites completedAt to the retry instant (local July 16). The
    // migration must key off startedAt so the session stays on July 15.
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(sessionsPath, {
      sessions: [{
        id: 's1', date: '2026-07-16',
        startedAt: '2026-07-16T04:00:00.000Z',   // 2026-07-15 21:00 PDT
        completedAt: '2026-07-17T05:00:00.000Z', // 2026-07-16 22:00 PDT (retry)
      }],
    });
    await migration.up({ rootDir });
    expect(readJson(sessionsPath).sessions[0].date).toBe('2026-07-15');
  });

  it('re-derives Morse round dates from their timestamps', async () => {
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(morsePath, {
      kochLevel: 2, settings: null,
      rounds: [{ id: 'r1', date: '2026-07-16', timestamp: '2026-07-16T05:00:00.000Z', mode: 'copy' }],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(readJson(morsePath).rounds[0].date).toBe('2026-07-15');
  });

  it('re-derives a training entry date from its timestamp', async () => {
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(trainingPath, {
      entries: [
        { id: 't1', date: '2026-07-16', timestamp: '2026-07-16T05:00:00.000Z', module: 'mental-math' },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(readJson(trainingPath).entries[0].date).toBe('2026-07-15');
  });

  it('preserves the exact instant of a legacy practice entry (full-ISO date, no timestamp) before rewriting date', async () => {
    // A legacy memory-practice entry's only instant is the full ISO in `date`;
    // the migration must stash it in `timestamp` before overwriting `date`.
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(trainingPath, {
      entries: [{ id: 't1', date: '2026-07-16T05:00:00.000Z', memoryItemId: 'm1' }],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const entry = readJson(trainingPath).entries[0];
    expect(entry.date).toBe('2026-07-15');
    expect(entry.timestamp).toBe('2026-07-16T05:00:00.000Z');
  });

  it('does not overwrite an existing timestamp/startedAt when normalizing date', async () => {
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(sessionsPath, {
      sessions: [{
        id: 's1', date: '2026-07-16',
        startedAt: '2026-07-16T05:00:00.000Z',
        completedAt: '2026-07-16T05:30:00.000Z',
      }],
    });
    await migration.up({ rootDir });
    const s = readJson(sessionsPath).sessions[0];
    expect(s.date).toBe('2026-07-15');
    expect(s.startedAt).toBe('2026-07-16T05:00:00.000Z'); // untouched
    expect(s.completedAt).toBe('2026-07-16T05:30:00.000Z'); // untouched
    expect(s.timestamp).toBeUndefined(); // not added — instant already preserved
  });

  it('leaves a record with no recoverable instant untouched', async () => {
    // Bare date-only, no completedAt/startedAt/timestamp — no way to know the
    // local day, so it must be preserved rather than guessed.
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(sessionsPath, { sessions: [{ id: 's1', date: '2026-07-16' }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(readJson(sessionsPath).sessions[0].date).toBe('2026-07-16');
  });

  it('is idempotent across re-runs', async () => {
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeJson(sessionsPath, {
      sessions: [{ id: 's1', date: '2026-07-16', completedAt: '2026-07-16T05:00:00.000Z' }],
    });
    await migration.up({ rootDir });
    const afterFirst = readJson(sessionsPath);
    const second = await migration.up({ rootDir });
    expect(second.updated).toBe(0);
    expect(readJson(sessionsPath)).toEqual(afterFirst);
  });

  it('falls back to UTC (never the host tz) when none is configured, so it is a no-op on any runner', async () => {
    // No settings file → resolves to UTC, matching the runtime's own TZ=UTC
    // fallback. This must hold regardless of the runner's system timezone: the
    // migration can run outside PM2 (via `npm run update`) on a non-UTC host, and
    // keying off the host tz would rewrite history the UTC runtime reads as local.
    writeJson(sessionsPath, {
      sessions: [{ id: 's1', date: '2026-07-16', startedAt: '2026-07-16T05:00:00.000Z' }],
    });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'utc-timezone' });
    expect(readJson(sessionsPath).sessions[0].date).toBe('2026-07-16');
  });

  it('skips a malformed data file without throwing', async () => {
    writeJson(settingsPath, { timezone: 'America/Los_Angeles' });
    writeFileSync(sessionsPath, '{ not json');
    const result = await migration.up({ rootDir });
    // Malformed sessions file is skipped; training absent → total 0, no throw.
    expect(result.updated).toBe(0);
  });
});
