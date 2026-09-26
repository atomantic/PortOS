/**
 * Strict-read regression for the weekly goal check-in (#4115).
 *
 * `runGoalCheckIn` reads goals.json, appends a check-in to each active goal,
 * and writes the whole file back. While the read swallowed unreadable files, a
 * corrupt goals.json read as `{ goals: [] }` and the run reported
 * `{ checked: 0 }` — indistinguishable from a user who genuinely has no active
 * goals, and the check-in silently never happened.
 *
 * Corrupt JSON is the portable way to produce "present but unreadable": it
 * fails the parse identically on every platform and needs no privileges.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Allocate lazily: `vi.mock` is hoisted above this file's static imports, so a
// `const` here would still be in its TDZ when goalCheckIn.js resolves
// GOALS_FILE at module load. `var` + a function declaration both hoist without
// a TDZ, so the factory can call it.
var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'goal-checkin-test-'));
  return tempRoot;
}

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => getTempRoot() }));

const provider = { id: 'p1', defaultModel: 'test-model' };
vi.mock('./providers.js', () => ({ getActiveProvider: vi.fn(async () => provider) }));

vi.mock('./aiProvider.js', () => ({
  callProviderAISimple: vi.fn(async () => ({ text: '{"assessment":"ok","recommendations":["keep going"]}' })),
  parseLLMJSON: (text) => JSON.parse(text),
}));

vi.mock('./notifications.js', () => ({
  addNotification: vi.fn(async () => {}),
  NOTIFICATION_TYPES: { HEALTH_ISSUE: 'health_issue' },
}));

// MortalLoom is the swappable "active source" the mirror-on-save test drives —
// `ml.enabled` toggles isMortalLoomEnabled() without touching a real iCloud path.
const ml = vi.hoisted(() => ({ enabled: false }));
vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn(async () => ml.enabled),
  mlArrayIfEnabled: vi.fn(async () => null),
  mlReplace: vi.fn(async () => {}),
}));

import { runGoalCheckIn } from './goalCheckIn.js';
import { addProgressEntry } from './identity/goals.js';
import { mlReplace } from './mortalLoomStore.js';
import { callProviderAISimple } from './aiProvider.js';
import { dashboardEvents } from './dashboardEvents.js';

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

describe('runGoalCheckIn strict reads (#4115)', () => {
  const CORRUPT = '{"goals": [{"id": "g1", "status": "active"';
  const goalsFile = () => join(getTempRoot(), 'digital-twin', 'goals.json');

  const activeGoal = {
    id: 'g1',
    title: 'Example Goal',
    status: 'active',
    targetDate: '2027-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    progress: 40,
  };

  beforeEach(() => {
    rmSync(getTempRoot(), { recursive: true, force: true });
    mkdirSync(join(getTempRoot(), 'digital-twin'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('rejects instead of reporting a check-in over zero goals', async () => {
    writeFileSync(goalsFile(), CORRUPT);
    await expect(runGoalCheckIn()).rejects.toThrow(/Unreadable identity file/);
  });

  it('leaves the unreadable goals file byte-for-byte intact', async () => {
    writeFileSync(goalsFile(), CORRUPT);
    await expect(runGoalCheckIn()).rejects.toThrow(/Unreadable identity file/);
    expect(
      readFileSync(goalsFile(), 'utf8'),
      'goals.json is the digital twin — a failed read must never rewrite it'
    ).toBe(CORRUPT);
  });

  it('still reports a genuine zero when the file is absent', async () => {
    const result = await runGoalCheckIn();
    expect(result, 'ENOENT is the one errno that proves absence').toEqual({ checked: 0 });
  });

  it('runs and persists normally when the file is readable', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [activeGoal] }));
    const result = await runGoalCheckIn();
    expect(result.checked).toBe(1);
    const written = JSON.parse(readFileSync(goalsFile(), 'utf8'));
    expect(written.goals[0].checkIns).toHaveLength(1);
    expect(written.goals[0].checkIns[0].assessment).toBe('ok');
  });
});

// #8755: runGoalCheckIn used to read goals.json once, await one LLM call per
// goal (which can take seconds to minutes), then write back the WHOLE snapshot
// it captured before the calls started — silently dropping any edit made while
// the run was in flight. It now routes through `mutateGoals`, which re-reads
// goals.json right before saving.
describe('runGoalCheckIn concurrency and MortalLoom mirroring (#8755)', () => {
  const goalsFile = () => join(getTempRoot(), 'digital-twin', 'goals.json');

  const activeGoal = {
    id: 'g1',
    title: 'Example Goal',
    status: 'active',
    targetDate: '2027-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    progress: 40,
  };

  beforeEach(() => {
    rmSync(getTempRoot(), { recursive: true, force: true });
    mkdirSync(join(getTempRoot(), 'digital-twin'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ml.enabled = false;
    vi.mocked(mlReplace).mockClear();
  });

  it('keeps a progress entry added while the LLM call is in flight', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [activeGoal] }));

    let resolveLLM;
    vi.mocked(callProviderAISimple).mockImplementationOnce(
      () => new Promise((resolve) => { resolveLLM = resolve; })
    );

    const checkInPromise = runGoalCheckIn();

    // Let runGoalCheckIn get past its initial read and into the pending LLM
    // call before the concurrent edit lands.
    await new Promise((r) => setTimeout(r, 10));
    const entry = await addProgressEntry('g1', { date: '2026-06-01', note: 'did the thing', durationMinutes: 30 });
    expect(entry).not.toBeNull();

    resolveLLM({ text: '{"assessment":"ok","recommendations":["keep going"]}' });
    const result = await checkInPromise;
    expect(result.checked).toBe(1);

    const written = JSON.parse(readFileSync(goalsFile(), 'utf8'));
    const goal = written.goals[0];
    expect(goal.checkIns, 'the check-in itself must still land').toHaveLength(1);
    expect(goal.progressLog, 'the concurrent progress entry must not be clobbered').toHaveLength(1);
    expect(goal.progressLog[0].note).toBe('did the thing');
  });

  it('mirrors the check-in to MortalLoom and emits goals:changed when enabled', async () => {
    ml.enabled = true;
    writeFileSync(goalsFile(), JSON.stringify({ goals: [activeGoal] }));

    const changed = new Promise((resolve) => dashboardEvents.once('goals:changed', resolve));
    const result = await runGoalCheckIn();
    expect(result.checked).toBe(1);

    expect(mlReplace).toHaveBeenCalledWith('goals', expect.arrayContaining([
      expect.objectContaining({ id: 'g1', checkIns: expect.arrayContaining([expect.objectContaining({ assessment: 'ok' })]) })
    ]));
    await changed;
  });
});
