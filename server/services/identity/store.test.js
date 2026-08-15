import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

// Real files off a temp tree — the point of these tests is the READ path, so
// stubbing the reader would defeat them.
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'identity-store-test-'));
const IDENTITY_DIR = join(TEST_DATA_ROOT, 'digital-twin');

vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: () => ({ digitalTwin: IDENTITY_DIR }),
  }));

// MortalLoom is the swappable "active source" these tests drive.
const ml = vi.hoisted(() => ({ goals: null }));
vi.mock('../mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn(async () => ml.goals !== null),
  mlArrayIfEnabled: vi.fn(async (key) => (key === 'goals' ? ml.goals : null)),
  mlReplace: vi.fn(async () => {}),
}));

// getIdentityStatus is the real strict `status === 'active'` consumer these tests reach through
// (#4123). Its other two inputs are unrelated domains — stubbed to "nothing uploaded" so the
// goals section is the only thing under test.
vi.mock('../genome.js', () => ({ getGenomeSummary: vi.fn(async () => null) }));
vi.mock('../taste-questionnaire.js', () => ({
  getTasteProfile: vi.fn(async () => ({ completedCount: 0, totalSections: 0, lastSessionAt: null })),
}));

const { loadJSON, normalizeGoal, GOALS_FILE, LONGEVITY_FILE, DEFAULT_GOALS, DEFAULT_LONGEVITY, PORTOS_GOAL_DEFAULTS } = await import('./store.js');
const { getIdentityStatus } = await import('./status.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

beforeEach(() => {
  ml.goals = null; // MortalLoom off unless a test turns it on
  rmSync(IDENTITY_DIR, { recursive: true, force: true });
  mkdirSync(IDENTITY_DIR, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('loadJSON — swallowing (default) behavior is unchanged (#2726)', () => {
  it('returns the default when the file was never written', async () => {
    expect(await loadJSON(GOALS_FILE, DEFAULT_GOALS)).toEqual(DEFAULT_GOALS);
  });

  it('returns the default for a corrupt file rather than throwing', async () => {
    writeFileSync(GOALS_FILE, '{"goals": [{');
    expect(await loadJSON(GOALS_FILE, DEFAULT_GOALS)).toEqual(DEFAULT_GOALS);
  });

  it('returns a fresh clone of the default each call — callers mutate what they get', async () => {
    const first = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
    first.goals.push({ id: 'mutation' });
    expect((await loadJSON(GOALS_FILE, DEFAULT_GOALS)).goals).toEqual([]);
  });

  it('reads a real file off disk', async () => {
    writeFileSync(GOALS_FILE, JSON.stringify({ goals: [{ id: 'g1' }], birthDate: '1990-01-01' }));
    expect(await loadJSON(GOALS_FILE, DEFAULT_GOALS)).toMatchObject({
      goals: [{ id: 'g1' }], birthDate: '1990-01-01',
    });
  });
});

describe('loadJSON — { strict: true } (#2726)', () => {
  it('does NOT throw for a genuinely absent file — absent is a trustworthy empty', async () => {
    expect(await loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true })).toEqual(DEFAULT_GOALS);
  });

  it('throws for a corrupt file instead of reporting it as "no goals filed"', async () => {
    writeFileSync(GOALS_FILE, '{"goals": [{');
    await expect(loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true }))
      .rejects.toThrow(/Unreadable identity file/);
  });

  it('throws for a file truncated to zero bytes (a partial write, not an empty list)', async () => {
    writeFileSync(GOALS_FILE, '');
    await expect(loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true }))
      .rejects.toThrow(/Unreadable identity file/);
  });

  it('applies to non-goals identity files too', async () => {
    writeFileSync(LONGEVITY_FILE, 'not json');
    await expect(loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY, { strict: true }))
      .rejects.toThrow(/Unreadable identity file/);
  });
});

// Regression: strictness must gate on the source that actually supplies the counted
// array. On a MortalLoom-backed install the local file holds only birthDate /
// lifeExpectancy metadata, so failing to read it costs no goals — throwing there
// would report Strategist "unavailable" while the goals sat readable in MortalLoom.
describe('loadJSON — strict defers to the active MortalLoom source (#2726)', () => {
  it('does NOT throw on a corrupt local file when MortalLoom supplies the goals', async () => {
    ml.goals = [{ id: 'ml1', title: 'From MortalLoom' }, { id: 'ml2', title: 'Also ML' }];
    writeFileSync(GOALS_FILE, '{"goals": [{');

    const data = await loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true });
    expect(data.goals).toHaveLength(2);
    expect(data.goals[0]).toMatchObject({ id: 'ml1' });
  });

  it('still throws on a corrupt local file when MortalLoom supplies nothing', async () => {
    ml.goals = null;
    writeFileSync(GOALS_FILE, '{"goals": [{');

    await expect(loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true }))
      .rejects.toThrow(/Unreadable identity file/);
  });

  it('lets MortalLoom goals win over a readable local file, as before', async () => {
    ml.goals = [{ id: 'ml1' }];
    writeFileSync(GOALS_FILE, JSON.stringify({ goals: [{ id: 'local' }], birthDate: '1990-01-01' }));

    const data = await loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true });
    expect(data.goals).toEqual([expect.objectContaining({ id: 'ml1' })]);
    expect(data.birthDate).toBe('1990-01-01'); // metadata still comes from local
  });
});

// A MortalLoom-synced goal passes through normalizeGoal and nothing else. Before #4123 the
// defaults backfilled every field EXCEPT status, so half the codebase (voice tools, the Character
// card) counted a status-less goal as active while the other half (check-in scheduling, Telegram
// digests, insights, jobGates, getGoalsTree's urgency enrichment, getIdentityStatus) tested
// `status === 'active'` and silently skipped it.
describe('normalizeGoal — status defaulting (#4123)', () => {
  it('stamps status:active on a goal that arrives without one', () => {
    expect(normalizeGoal({ id: 'ml1', title: 'Sync me' }).status).toBe('active');
  });

  it.each([['null', null], ['undefined', undefined], ['an empty string', '']])(
    'treats a falsy status (%s) as active rather than passing it through',
    (_label, status) => {
      // A falsy status is never a legitimate goal state — there is no "no status" goal — so it
      // must not survive the spread. `{ ...defaults, ...g }` alone would let an explicit null
      // re-open the split: null overwrites the default but still fails `status === 'active'`.
      expect(normalizeGoal({ id: 'ml1', status }).status).toBe('active');
    });

  it.each(['completed', 'abandoned', 'paused'])('preserves a real non-active status (%s)', (status) => {
    expect(normalizeGoal({ id: 'ml1', status }).status).toBe(status);
  });

  it('still backfills every other default alongside status', () => {
    const normalized = normalizeGoal({ id: 'ml1' });
    for (const [key, value] of Object.entries(PORTOS_GOAL_DEFAULTS)) {
      expect(normalized[key]).toEqual(value);
    }
    expect(normalized.id).toBe('ml1');
  });

  it('does not let the status default clobber a caller-supplied field', () => {
    const normalized = normalizeGoal({ id: 'ml1', progress: 42, goalType: 'habit', status: 'completed' });
    expect(normalized).toMatchObject({ progress: 42, goalType: 'habit', status: 'completed' });
  });
});

describe('loadJSON — status-less MortalLoom goals reach strict active-goal consumers (#4123)', () => {
  it('normalizes a status-less MortalLoom goal to active on the way out of loadJSON', async () => {
    ml.goals = [{ id: 'ml1', title: 'No status from the phone' }, { id: 'ml2', status: null }];

    const data = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
    expect(data.goals.map(g => g.status)).toEqual(['active', 'active']);
  });

  it('reports the goals section active in getIdentityStatus, which filters on status === active', async () => {
    // The end-to-end shape of the bug: a MortalLoom user with status-less goals saw the Character
    // card list them while the identity dashboard called the Goals section "unavailable".
    ml.goals = [{ id: 'ml1', title: 'No status from the phone' }];

    const status = await getIdentityStatus();
    expect(status.sections.goals).toMatchObject({ status: 'active', goalCount: 1 });
  });

  it('still reports unavailable when every synced goal is genuinely finished', async () => {
    // The default must not paper over real non-active goals — otherwise the section would claim
    // active goals for a user who has completed all of them.
    ml.goals = [{ id: 'ml1', status: 'completed' }, { id: 'ml2', status: 'abandoned' }];

    const status = await getIdentityStatus();
    expect(status.sections.goals.status).toBe('unavailable');
  });
});
