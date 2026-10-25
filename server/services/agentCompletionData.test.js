import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('../lib/fileUtils.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-completion-data-') });
});

import { PATHS } from '../lib/fileUtils.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { loadAgentIndex } from './cosAgentIndex.js';
import { readCompletionData, storeCompletionData } from './agentCompletionData.js';

afterAll(cleanupTempDataRoots);

describe('completion data against a cold agent index (#13461)', () => {
  // The first loadAgentIndex() migrates every flat run directory into a date
  // bucket. A publish that resolved its path before that migration read its
  // bytes through a file handle whose pathname had since moved, so the
  // identity check failed with ENOENT on a payload that was written correctly.
  it('publishes and verifies a payload while the cold index is migrating the run directory', async () => {
    const agent = { id: 'agent-example-cold', startedAt: '2026-10-01T12:00:00.000Z' };
    const flatDir = join(PATHS.cosAgents, agent.id);
    await mkdir(join(flatDir, 'extra'), { recursive: true });
    await writeFile(join(flatDir, 'metadata.json'), JSON.stringify({ completedAt: '2026-10-01T12:30:00.000Z' }));

    const migration = loadAgentIndex();
    const value = { summary: 'Synthetic completion payload.' };
    const reference = await storeCompletionData(agent, 'sentinel', value);
    await migration;

    expect(await readCompletionData(agent, reference)).toEqual(value);
    // The run directory ended in exactly one canonical home: its date bucket.
    expect(await readdir(join(PATHS.cosAgents, '2026-10-01', agent.id))).toContain('completion');
    expect(await readdir(PATHS.cosAgents)).not.toContain(agent.id);
  });
});
