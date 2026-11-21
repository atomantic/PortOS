import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runtime = vi.hoisted(() => ({ dir: null, metadataReads: 0 }));
vi.mock('../lib/fileUtils.js', async () => ({
  ...await vi.importActual('../lib/fileUtils.js'),
  PATHS: { root: '/synthetic/repository', data: '/synthetic/data', worktrees: '/synthetic/worktrees', get cos() { return runtime.dir ?? '/synthetic/cos'; } },
}));
vi.mock('./cos/cosState.js', async () => ({ ...await vi.importActual('./cos/cosState.js'), readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: {} }) }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return { ...actual, readFile: (path, ...rest) => {
    if (String(path).endsWith('metadata.json')) runtime.metadataReads++;
    return actual.readFile(path, ...rest);
  } };
});
const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
const { archivedRecordCacheEpoch, cacheArchivedRecord, getCachedArchivedRecord, invalidateArchivedRecord, writeArchivedAgentMetadata } = await import('./cos/cosAgentIndex.js');

const date = '2026-01-01';
const writeRecord = async (id, patch = {}) => {
  const dir = join(runtime.dir, 'agents', date, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, status: 'completed', ...patch }));
};

describe('archived agent record memoization', () => {
  beforeEach(async () => {
    runtime.dir = await mkdtemp(join(tmpdir(), 'portos-policy-cache-'));
    runtime.metadataReads = 0;
    await mkdir(join(runtime.dir, 'agents'), { recursive: true });
    await writeFile(join(runtime.dir, 'agents', 'index.json'), JSON.stringify({ 'agent-a': date, 'agent-b': date }));
    await writeRecord('agent-a');
    await writeRecord('agent-b');
    invalidateArchivedRecord();
  });
  afterEach(async () => { await rm(runtime.dir, { recursive: true, force: true }); });

  it('re-reads no archive record after the first pass and shows an invalidated write on the next read', async () => {
    await readBranchCompletionPolicies();
    expect(runtime.metadataReads).toBe(2);
    await readBranchCompletionPolicies();
    expect(runtime.metadataReads).toBe(2);

    await writeRecord('agent-a', { status: 'failed' });
    invalidateArchivedRecord('agent-a');
    const agents = await readBranchCompletionPolicies();
    expect(runtime.metadataReads).toBe(3);
    expect(agents.find(agent => agent.id === 'agent-a').status).toBe('failed');
  });

  it('retains at most 500 full records, touching reads and rejecting stale fills after invalidation', () => {
    const epoch = archivedRecordCacheEpoch();
    const store = id => cacheArchivedRecord(id, date, { id, output: 'full record' }, epoch);
    for (let id = 0; id < 500; id++) store(id);
    expect(getCachedArchivedRecord(0, date).agent.id).toBe(0);
    store(500);
    expect(getCachedArchivedRecord(1, date)).toBeNull();
    expect(getCachedArchivedRecord(0, date).agent.id).toBe(0);
    for (let id = 501; id < 1000; id++) store(id);
    expect(Array.from({ length: 1000 }, (_, id) => getCachedArchivedRecord(id, date)).filter(Boolean)).toHaveLength(500);
    invalidateArchivedRecord(1);
    store(1);
    expect(getCachedArchivedRecord(1, date)).toBeNull();
  });

  it('preserves scoped policy after full-record eviction, and observes a changed handoff after invalidation', async () => {
    const repoPath = '/synthetic/repository';
    const metadata = { sourceWorkspace: repoPath, worktreeBranch: 'feature/example', prCompletionPolicy: 'leave-open' };
    await writeRecord('agent-a', { metadata, output: 'large transcript' });
    const branch = metadata.worktreeBranch;
    const [projected] = await readBranchCompletionPolicies({ repoPath, branch });
    expect(projected.metadata.prCompletionPolicy).toBe('leave-open');
    expect(projected).not.toHaveProperty('output');
    await readBranchCompletionPolicies();
    const epoch = archivedRecordCacheEpoch();
    for (let id = 0; id < 500; id++) cacheArchivedRecord(id, date, {}, epoch);
    expect(getCachedArchivedRecord('agent-a', date)).toBeNull();
    expect(await readBranchCompletionPolicies({ repoPath, branch: 'feature/other' })).toEqual([]);
    await readBranchCompletionPolicies({ repoPath, branch });
    expect(runtime.metadataReads).toBe(4);
    await writeArchivedAgentMetadata(join(runtime.dir, 'agents', date, 'agent-a'), {
      id: 'agent-a', status: 'completed', metadata: { ...metadata, prCompletionPolicy: 'review-then-merge' },
    });
    const [changed] = await readBranchCompletionPolicies({ repoPath, branch });
    expect(changed.metadata.prCompletionPolicy).toBe('review-then-merge');
    expect(runtime.metadataReads).toBe(5);
  });

  it('names the unreadable record when one archive file is corrupt', async () => {
    await writeFile(join(runtime.dir, 'agents', date, 'agent-b', 'metadata.json'), '{broken');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readBranchCompletionPolicies()).rejects.toThrow('pr-completion-policy-unavailable');
    expect(error.mock.calls[0][0]).toContain('agent-b');
    error.mockRestore(); warn.mockRestore();
  });
});
