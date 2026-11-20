/** Exercise indexed archive-policy reads against the disposable PostgreSQL database. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { readBranchCompletionHold, readBranchCompletionPolicies } from './branchCompletionPolicy.js';
import { publishArchivePolicyChange } from './cos/cosBranchPolicyArchive.js';
import { up as backfill } from '../scripts/db-migrations/033-cos-branch-completion-policy.js';

const fixture = vi.hoisted(() => ({ dir: null, live: {}, metadataReads: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, readFile(path, ...options) {
    if (String(path).endsWith('metadata.json')) fixture.metadataReads++;
    return fs.readFile(path, ...options);
  } };
});
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, get cos() { return fixture.dir; } } };
});
vi.mock('../lib/pgFileFacade.js', async importOriginal => ({ ...await importOriginal(), isFileBackend: () => false }));
vi.mock('./cos/cosState.js', () => ({
  readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: fixture.live }),
}));

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('services/branchCompletionPolicy.db.test', health.connected, 'disposable PostgreSQL unavailable');

const repoPath = '/synthetic/repository';
const branch = 'feature/handoff';
const date = '2026-01-01';
const prUrl = 'https://github.com/example/repository/pull/42';
const dir = () => join(fixture.dir, 'agents');
const agent = (id, workspace = repoPath, branchName = branch) => ({
  id, status: 'completed', completedAt: `${date}T01:00:00Z`, startedAt: `${date}T00:00:00Z`,
  metadata: {
    sourceWorkspace: workspace,
    branchCompletionPolicy: { branch: branchName, completion: 'leave-open', prUrl },
  },
});
const writeAgent = async record => {
  const target = join(dir(), date, record.id);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'metadata.json'), JSON.stringify(record));
};
const writeIndex = index => writeFile(join(dir(), 'index.json'), JSON.stringify(index));
const hold = args => readBranchCompletionHold({ repoPath, branch, tip: null, ...args });
const reset = async () => {
  await query('DELETE FROM cos_branch_completion_policies');
  await query('DELETE FROM cos_branch_policy_archive');
};

afterAll(async () => { if (health.connected) await close(); });
describe.skipIf(!runDb)('PostgreSQL branch policy projection', () => {
  beforeEach(async () => {
    await reset();
    fixture.dir = await mkdtemp(join(tmpdir(), 'portos-policy-db-'));
    fixture.live = {};
    fixture.metadataReads = 0;
    await writeAgent(agent('agent-a'));
    await writeAgent(agent('agent-b', repoPath, 'feature/b'));
    await writeAgent(agent('agent-c', '/synthetic/other'));
    await writeIndex({ 'agent-a': date, 'agent-b': date, 'agent-c': date });
  });
  afterEach(async () => {
    await reset();
    await rm(fixture.dir, { recursive: true, force: true });
  });

  it('backfills once, scopes by repo and branch, and honors a live duplicate from another repo', async () => {
    await withTransaction(backfill);
    expect(fixture.metadataReads).toBe(3);
    await expect(hold()).resolves.toBe('pr-completion-human-handoff');
    await expect(hold({ branch: 'feature/absent' })).resolves.toBeNull();
    await expect(readBranchCompletionPolicies({ repoPath, branches: [branch, 'feature/b'] })).resolves.toHaveLength(2);
    const { rows } = await query('SELECT pr_url FROM cos_branch_completion_policies WHERE repo_path = $1 AND branch = $2', [repoPath, branch]);
    expect(rows).toEqual([{ pr_url: prUrl }]);
    fixture.live = { 'agent-a': agent('agent-a', '/synthetic/other') };
    await expect(hold()).resolves.toBeNull();
    fixture.live = {};
    await expect(hold()).resolves.toBe('pr-completion-human-handoff');
    expect(fixture.metadataReads).toBe(3);
  });

  it('updates only affected archive rows and rejects an old database stamp after interrupted publication', async () => {
    await withTransaction(backfill);
    const next = agent('agent-a', repoPath, 'feature/moved');
    await publishArchivePolicyChange(dir(), () => writeAgent(next), { ids: [next.id] });
    expect(fixture.metadataReads).toBe(4);
    await expect(hold()).resolves.toBeNull();
    await expect(hold({ branch: 'feature/moved' })).resolves.toBe('pr-completion-human-handoff');
    expect(fixture.metadataReads).toBe(4);

    await expect(publishArchivePolicyChange(dir(), async () => {
      await writeAgent(agent('agent-a'));
      throw new Error('synthetic interruption');
    }, { ids: [next.id] })).rejects.toThrow('synthetic interruption');
    await expect(hold()).resolves.toBe('pr-completion-human-handoff');
    await expect(hold({ branch: 'feature/moved' })).resolves.toBeNull();
    expect(fixture.metadataReads).toBe(7);
  });

  it('rebuilds after a file-only restore and carries unreadable scope through the index', async () => {
    await withTransaction(backfill);
    await publishArchivePolicyChange(dir(), async () => {
      const record = agent('agent-c');
      record.metadata.claimReleasedBranches = 'malformed';
      await writeAgent(record);
    }, { restore: true });
    await expect(hold({ branch: 'feature/unrelated' })).resolves.toBe('pr-completion-policy-unavailable');
    const index = { 'agent-a': date, 'agent-b': date };
    await publishArchivePolicyChange(dir(), () => writeIndex(index), { index });
    await expect(hold({ branch: 'feature/unrelated' })).resolves.toBeNull();
  });
});
