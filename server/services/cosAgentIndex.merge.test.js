import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';

// Isolated file so cosAgentIndex's lazy agentIndex singleton starts clean (a shared
// file would carry the cache across describes). cosState is mocked to point
// AGENTS_DIR at a tmpdir so addAgentArchivesToIndex (#1650 receiver hook) never
// touches the real data/cos/agents index.
const mockCosState = vi.hoisted(() => ({
  agentsDir: `${process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp'}/portos-cos-indexmerge-${process.pid}`,
}));

vi.mock('./cosState.js', () => ({
  AGENTS_DIR: mockCosState.agentsDir,
  loadState: vi.fn(),
  saveState: vi.fn(),
  withStateLock: async (fn) => fn(),
}));
vi.mock('./domainUsage.js', () => ({ recordDomainUsage: vi.fn(async () => {}) }));

import { addAgentArchivesToIndex, getAgentIdsForDates, loadAgentIndex } from './cosAgentIndex.js';

const INDEX_FILE = join(mockCosState.agentsDir, 'index.json');

describe('addAgentArchivesToIndex (#1650)', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    // Seed an empty index so loadAgentIndex takes the read path (not migration).
    await writeFile(INDEX_FILE, '{}');
  });
  afterEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('unions new pairs, is idempotent, rejects invalid, and persists', async () => {
    expect(await addAgentArchivesToIndex([
      { agentId: 'agent-x', date: '2026-06-20' },
      { agentId: 'agent-y', date: '2026-06-21' },
    ])).toBe(2);

    // Re-adding the same pair is a no-op.
    expect(await addAgentArchivesToIndex([{ agentId: 'agent-x', date: '2026-06-20' }])).toBe(0);

    // A pre-existing agentId is NEVER overwritten, even with a different date —
    // a peer id-collision must not repoint a locally-owned agent's bucket.
    expect(await addAgentArchivesToIndex([{ agentId: 'agent-x', date: '2026-07-01' }])).toBe(0);
    expect((await loadAgentIndex()).get('agent-x')).toBe('2026-06-20');

    // Invalid entries are skipped: empty id, malformed date, empty object.
    expect(await addAgentArchivesToIndex([
      { agentId: '', date: '2026-06-20' },
      { agentId: 'agent-z', date: 'not-a-date' },
      {},
    ])).toBe(0);

    // A genuinely new pair still lands.
    expect(await addAgentArchivesToIndex([{ agentId: 'agent-w', date: '2026-06-22' }])).toBe(1);

    const idx = await loadAgentIndex();
    expect(idx.get('agent-x')).toBe('2026-06-20');
    expect(idx.get('agent-w')).toBe('2026-06-22');
    expect(idx.has('agent-z')).toBe(false);

    const onDisk = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
    expect(onDisk['agent-y']).toBe('2026-06-21');
    expect(onDisk['agent-z']).toBeUndefined();
  });

  it('returns 0 for a non-array / empty input', async () => {
    expect(await addAgentArchivesToIndex(null)).toBe(0);
    expect(await addAgentArchivesToIndex([])).toBe(0);
  });
});

describe('getAgentIdsForDates (#3501)', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    await writeFile(INDEX_FILE, '{}');
    await addAgentArchivesToIndex([
      { agentId: 'agent-sep1a', date: '2026-09-01' },
      { agentId: 'agent-sep1b', date: '2026-09-01' },
      { agentId: 'agent-sep2', date: '2026-09-02' },
    ]);
  });
  afterEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('groups ids per requested date and returns an empty list for unknown dates', async () => {
    const byDate = await getAgentIdsForDates(['2026-09-01', '2026-09-02', '2026-09-03']);

    expect([...byDate.get('2026-09-01')].sort()).toEqual(['agent-sep1a', 'agent-sep1b']);
    expect(byDate.get('2026-09-02')).toEqual(['agent-sep2']);
    // Requested but unindexed dates are still keyed — callers can read without a guard.
    expect(byDate.get('2026-09-03')).toEqual([]);
    // Dates outside the request never leak into the result.
    expect(byDate.has('2026-06-20')).toBe(false);
  });

  it('returns an empty map for an empty date list', async () => {
    expect((await getAgentIdsForDates([])).size).toBe(0);
  });
});
