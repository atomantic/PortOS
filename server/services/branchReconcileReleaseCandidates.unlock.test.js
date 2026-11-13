import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';

const f = vi.hoisted(() => ({ agents: {}, open: [] }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: () => [] }));
vi.mock('./cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: f.agents }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async cwd => ({ cwd }) }));
vi.mock('./github.js', () => ({ execGh: async () => JSON.stringify(f.open) }));
import { retireMergedReleaseCandidates } from './branchReconcileReleaseCandidates.js';

let root, repo, path, head;
const branch = 'codex/release-agent-old';
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'abandoned-release-')));
  repo = join(root, 'repo'); path = join(root, 'candidate');
  await materializeGitRepo(repo);
  await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
  await execGit(['worktree', 'lock', '--reason', 'Active release candidate ' + branch, path], repo);
  await writeFile(join(path, 'unfinished.txt'), 'Preserve unpublished work');
  head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
});
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it('preserves a live or open-PR candidate, then unlocks abandonment without removing unique work', async () => {
  const app = { repoPath: repo };
  const tree = { branch, path, head, locked: true, lockReason: 'Active release candidate ' + branch };
  const deps = { beforeMutation: vi.fn(), readPr: async () => null, prepare: vi.fn(), retire: vi.fn() };
  const run = () => retireMergedReleaseCandidates(app, { worktreeInventory: [tree] }, deps);
  f.agents = { 'agent-old': { id: 'agent-old', status: 'running', metadata: {
    workspacePath: path, sourceWorkspace: repo, taskAnalysisType: 'do-release',
  } } };
  expect(await run()).toEqual({ retired: [], held: [] });
  f.agents['agent-old'].status = 'completed';
  f.open = [{ number: 1 }];
  expect(await run()).toEqual({ retired: [], held: [] });
  f.open = [];
  expect(await run()).toMatchObject({ retired: [], held: [{ reason: 'candidate-unlocked-for-reconciliation' }] });
  expect(await readFile(join(path, 'unfinished.txt'), 'utf8')).toBe('Preserve unpublished work');
  expect((await execGit(['show-ref', '--verify', 'refs/heads/' + branch], repo)).exitCode).toBe(0);
  expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).not.toContain('locked');
});
