import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('memory-lineage-') });
});
vi.mock('./memoryBackend.js', () => ({
  DEFAULT_MEMORY_CONFIG: { maxContextTokens: 2000, minRelevanceThreshold: 0.5 },
  getMemories: vi.fn(),
  getMemory: vi.fn(async id => ({ id, type: 'preference', content: `content of ${id}`, importance: 0.9 })),
  searchMemories: vi.fn(), hybridSearchMemories: vi.fn(),
}));
vi.mock('./memoryEmbeddings.js', () => ({
  estimateTokens: text => Math.ceil(text.length / 4),
  generateQueryEmbedding: vi.fn(), truncateToTokens: vi.fn(),
}));
vi.mock('./usage.js', () => ({ recordSession: async () => {} }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: async () => {} }));

const { PATHS } = await import('../lib/fileUtils.js');
const { getMemories } = await import('./memoryBackend.js');
const { getMemorySection } = await import('./memoryRetriever.js');
const { createAgentRun } = await import('./agentRunTracking.js');
const { findRecentRunsUsingMemory } = await import('./memoryRunUsage.js');

const provider = { id: 'example-provider', name: 'Example', defaultModel: 'example-model' };
const spawn = async (agentId, injectedMemories) => {
  const { runDir } = await createAgentRun({ agentId, task: { id: `task-${agentId}`, description: 'Example prompt' }, provider, injectedMemories });
  return JSON.parse(await readFile(join(runDir, 'metadata.json'), 'utf8'));
};

beforeEach(async () => {
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(PATHS.runs, { recursive: true });
});
afterAll(cleanupTempDataRoots);

describe('memory lineage: retrieval -> run record (#10495)', () => {
  it('stores the ids that went into the prompt section on the run, and finds the run from the memory', async () => {
    vi.mocked(getMemories).mockResolvedValue({ memories: [{ id: 'mem-a' }, { id: 'mem-b' }] });
    let injected = [];
    const section = await getMemorySection({}, { onInjected: list => { injected = list; } });
    expect(injected.map(m => m.id)).toEqual(['mem-a', 'mem-b']);
    expect(injected[0]).toEqual({ id: 'mem-a', version: null, relevance: 0.9 });
    for (const m of injected) expect(section).toContain(`content of ${m.id}`);

    const metadata = await spawn('agent-1', injected);
    expect(metadata.injectedMemories).toEqual(injected);

    const runs = await findRecentRunsUsingMemory('mem-b');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: metadata.id, agentId: 'agent-1' });
    expect(await findRecentRunsUsingMemory('mem-unused')).toEqual([]);
  });

  it('stores an empty list (not a missing field) when no memory was injected', async () => {
    vi.mocked(getMemories).mockResolvedValue({ memories: [] });
    let injected;
    expect(await getMemorySection({}, { onInjected: list => { injected = list; } })).toBeNull();
    expect(injected).toEqual([]);
    expect((await spawn('agent-2', injected)).injectedMemories).toEqual([]);
    expect((await spawn('agent-3', undefined)).injectedMemories).toEqual([]);
  });
});
