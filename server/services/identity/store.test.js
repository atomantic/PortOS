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

const { loadJSON, GOALS_FILE, LONGEVITY_FILE, DEFAULT_GOALS, DEFAULT_LONGEVITY } = await import('./store.js');

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
