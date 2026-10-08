import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';

const paths = vi.hoisted(() => ({ worktrees: `${process.env.TMPDIR || process.env.TEMP || '/tmp'}/deep-worktrees-${process.pid}`, cos: `${process.env.TMPDIR || process.env.TEMP || '/tmp'}/deep-cos-${process.pid}` }));
vi.mock('../lib/fileUtils.js', async original => ({ ...(await original()), PATHS: paths }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: async () => 'fixture-instance' }));
vi.mock('./appQualitySchedule.js', () => ({ detectRepoCapabilities: async () => ({ capabilities: {} }) }));
import { createWorktree } from './worktreeManager.js';
import { prepareDeepAudit, getDeepAuditSourceRevision, checkpointDeepAudit } from './deepAudit.js';

let root, repo, ledger;
const task = { id: 'audit', description: 'Inspect all source', metadata: { auditDepth: 'deep', app: 'fixture', fileIssues: true, deepAuditId: 'fixture-audit' } };
const git = async (args, cwd = repo) => (await execGit(args, cwd)).stdout.trim();
const commit = async cwd => git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-am', 'fixture'], cwd);
const deps = {
  write: async () => {},
  mutate: async (_id, initial, mutate) => (ledger = await mutate(structuredClone(ledger || initial))),
  readLedger: async () => ledger,
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deep-workspace-'));
  repo = join(root, 'repo');
  ledger = null;
  // Local fixture transport only; no production Git configuration is changed.
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.file.allow');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'always');
  await git(['init', '-b', 'main', repo], root);
  await writeFile(join(repo, 'source.js'), 'export const value = 1;\n');
  await git(['add', '.']); await commit(repo);
  await git(['init', '--bare', join(root, 'remote.git')], root);
  await git(['remote', 'add', 'origin', join(root, 'remote.git')]);
  await git(['push', '-u', 'origin', 'main']);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); await rm(paths.worktrees, { recursive: true, force: true }); });

it('keeps accepted coverage on a fresh resume after remote main advances; Quick still follows main', async () => {
  const first = await createWorktree('agent-first', repo, task.id, { baseBranch: 'main', linkDependencies: false });
  await prepareDeepAudit({ task, agentId: 'agent-first', workspacePath: first.worktreePath }, deps);
  const pin = ledger.scope.revision;
  const attempt = ledger.attempts['agent-first'];
  const unit = ledger.units[0];
  const report = { version: 1, scopeHash: ledger.scopeHash, attemptId: attempt.id, prerequisiteHash: attempt.prerequisiteHash,
    pass: attempt.pass, units: [{ id: unit.id, status: 'evidenced', reason: 'Read the full fixture source',
      sources: unit.files.map(path => ({ path, blob: ledger.scope.files.find(f => f.path === path).blob })),
      evidence: { method: 'Read source.js', observations: 'Exports a constant without side effects' } }], candidates: [], stopReason: 'Partial checkpoint' };
  await checkpointDeepAudit({ task, agentId: attempt.id, workspacePath: first.worktreePath, success: true }, { ...deps, read: async () => JSON.stringify(report) });
  expect(ledger.units[0].evidence.static).toBeTruthy();
  await writeFile(join(repo, 'source.js'), 'export const value = 2;\n'); await commit(repo); await git(['push', 'origin', 'main']);
  const baseCommit = await getDeepAuditSourceRevision(task, deps);
  expect(baseCommit).toBe(pin);
  const resumed = await createWorktree('agent-resume', repo, task.id, { baseBranch: 'main', baseCommit, linkDependencies: false });
  await prepareDeepAudit({ task: { ...task, id: 'new-resume-task', metadata: { ...task.metadata, resumedFromAgentId: 'agent-first' } }, agentId: 'agent-resume', workspacePath: resumed.worktreePath }, deps);
  expect(ledger.generation).toBe(1);
  expect(ledger.units[0].evidence.static).toBeTruthy();
  expect(await git(['rev-parse', 'HEAD'], resumed.worktreePath)).toBe(pin);
  const quick = await createWorktree('agent-quick', repo, 'quick', { baseBranch: 'main', linkDependencies: false });
  expect(await git(['rev-parse', 'HEAD'], quick.worktreePath)).toBe(await git(['rev-parse', 'HEAD']));
  await expect(createWorktree('agent-missing', repo, task.id, { baseBranch: 'main', baseCommit: 'f'.repeat(40) })).rejects.toThrow();
});

it('expands a fresh submodule at its gitlink and refuses to reset retained submodule commits or dirt', async () => {
  const child = join(root, 'child'); await mkdir(child);
  await git(['init', child], root); await writeFile(join(child, 'nested.js'), 'export const nested = true;\n');
  await git(['add', '.'], child); await commit(child);
  await git(['submodule', 'add', child, 'lib/child']); await commit(repo); await git(['push', 'origin', 'main']);
  const worktree = await createWorktree('agent-submodule', repo, task.id, { baseBranch: 'main', linkDependencies: false });
  const workspacePath = worktree.worktreePath;
  await prepareDeepAudit({ task, agentId: 'agent-submodule', workspacePath }, deps);
  expect(ledger.scope.capabilities.submodules).toEqual([]);
  expect(ledger.scope.files.some(f => f.path === 'lib/child/nested.js' && f.kind === 'blob')).toBe(true);
  const nested = join(workspacePath, 'lib/child');
  await writeFile(join(nested, 'nested.js'), 'export const nested = false;\n'); await commit(nested);
  const retained = await git(['rev-parse', 'HEAD'], nested);
  await expect(prepareDeepAudit({ task, agentId: 'next', workspacePath }, deps)).rejects.toThrow('clean source snapshot');
  expect(await git(['rev-parse', 'HEAD'], nested)).toBe(retained);
});
