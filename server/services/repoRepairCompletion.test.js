import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { ownTestBodies, makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const facts = vi.hoisted(() => ({ repo: '', agents: [], owner: null, task: null, forge: true, pr: null, prs: {}, names: {} }));
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('repair-completion-data-'), extraOverrides: { get root() { return facts.repo; } },
}));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgent: async () => facts.owner, completeAgent: vi.fn(async () => { facts.owner.status = 'completed'; return facts.owner; }), getAgentRecord: vi.fn(async () => facts.owner), getAgents: vi.fn(async () => facts.agents),
  updateAgent: async (id, patch) => { Object.assign(facts.owner.metadata, patch.metadata); return facts.owner; },
}));
vi.mock('./cosTaskStore.js', () => ({ updateTask: vi.fn(async (id, patch) => { Object.assign(facts.task, patch); return facts.task; }), getAllTasks: async () => ({ user: { tasks: [] }, cos: { tasks: [] } }), getTaskById: vi.fn(async () => facts.task), addTask: vi.fn(async (data, type, options) => ({ data, type, options })) }));
vi.mock('../lib/gitRemote.js', async original => ({ ...(await original()), getOriginInfo: async dir => ({ isGithub: true, host: 'github.com', owner: 'example', fullName: facts.names[dir] || 'example/PortOS' }) }));
vi.mock('./github.js', () => ({ execGh: vi.fn(async (args, timeout, { cwd }) => {
  expect(args).not.toContain('--jq'); // gh forbids --slurp together with --jq.
  expect(args.at(-1)).toContain(`repos/${facts.names[cwd] || 'example/PortOS'}/pulls?`);
  if (!facts.forge) throw new Error('Unavailable');
  const pr = cwd === facts.repo ? facts.pr : facts.prs[cwd];
  return JSON.stringify([[pr && { state: pr.state, merged_at: pr.merged_at, head: { sha: pr.headSha, repo: { full_name: pr.headRepo } }, base: { ref: pr.base } }].filter(Boolean)]);
}) }));
vi.mock('./codeReview.js', async original => ({ ...(await original()), getGoalFidelityConfig: async () => null }));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: async () => null }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: async () => null }));
vi.mock('../lib/gitCommitProbe.js', () => ({ committedDuringRun: vi.fn(async () => false) }));

import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { bindCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';
import { captureRepoRepairContract } from './updateRepoRepairCompletion.js';
import { checkUpdateRepoReadiness, queueRepoRepairTask } from './updateRepoReadiness.js';
import { evaluateSuccessCriteria, finalizeAgent } from './agentFinalization.js';
import { resolveTaskOutcome } from '../lib/agentOutcome.js';
import { committedDuringRun } from '../lib/gitCommitProbe.js';
import { getAgents, completeAgent } from './cosAgentLifecycle.js';

const owned = ownTestBodies(vitestIt);
const it = owned.it;
const repos = [];
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo() {
  const origin = mkdtempSync(join(tmpdir(), 'repair-origin-'));
  const clone = mkdtempSync(join(tmpdir(), 'repair-clone-'));
  repos.push(origin, clone);
  git(origin, 'init', '--bare', '--initial-branch=main');
  git(clone, 'clone', origin, '.');
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Example Tester');
  writeFileSync(join(clone, 'README.md'), 'seed\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-m', 'seed'); git(clone, 'push', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  facts.repo = clone;
  return clone;
}
async function dispatch() {
  const verdict = await checkUpdateRepoReadiness({ repoPath: facts.repo });
  const contract = { ...await captureRepoRepairContract(verdict), taskId: 'sys-repair' };
  facts.task = { id: 'sys-repair', taskType: 'internal', status: 'in_progress', metadata: {
    app: PORTOS_APP_ID, repoRepairContract: contract, claimedBy: 'example-instance', claimedAt: '2026-01-01T00:00:00Z',
    totalSpawnCount: '2', lastSpawnedAt: '2026-01-01T00:01:00Z', failureCount: '1',
  } };
  facts.owner = { id: 'agent-repair', taskId: 'sys-repair', status: 'running', metadata: {
    instanceId: 'example-instance', workspacePath: facts.repo,
  } };
  expect(await bindCompletionTaskDispatch(facts.owner.id, facts.task)).toBe(true);
  facts.agents = [facts.owner];
  return facts.task;
}
function publish(dir = facts.repo) {
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'branch', 'preserved-work'); git(dir, 'push', 'origin', 'preserved-work');
  const pr = { state: 'open', merged_at: null, headSha: head, headRepo: facts.names[dir] || 'example/PortOS', base: 'main' };
  if (dir === facts.repo) facts.pr = pr; else facts.prs[dir] = pr;
  git(dir, 'reset', '--hard', 'origin/main');
  return head;
}
function submodule(parent, path, name = 'example/Child') {
  const root = facts.repo;
  const source = repo();
  facts.repo = root;
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', git(source, 'remote', 'get-url', 'origin'), path);
  const child = join(parent, path);
  git(child, 'config', 'user.email', 'test@example.com'); git(child, 'config', 'user.name', 'Example Tester');
  facts.names[child] = name;
  git(parent, 'add', '.'); git(parent, 'commit', '-m', 'track child'); git(parent, 'push', 'origin', 'main');
  return child;
}
function localChildWork(child) {
  writeFileSync(join(child, 'README.md'), 'existing child commit\n'); git(child, 'commit', '-am', 'existing child work');
  writeFileSync(join(child, 'README.md'), 'staged child work\n'); git(child, 'add', '.');
  writeFileSync(join(child, 'README.md'), 'unstaged child work\n');
  writeFileSync(join(child, 'draft.txt'), 'untracked child work\n');
}
function preserveChild(child) {
  git(child, 'commit', '-m', 'preserve staged child work'); git(child, 'add', '.');
  git(child, 'commit', '-m', 'preserve unstaged child work'); return publish(child);
}
const evaluate = (task = facts.task) => evaluateSuccessCriteria({ task, agentId: 'agent-repair', success: true,
  workspacePath: facts.repo, startedAt: Date.now() });

beforeEach(() => { vi.clearAllMocks(); Object.assign(facts, { agents: [], owner: null, task: null, forge: true, pr: null, prs: {}, names: {} }); });
afterAll(async () => { await owned.drain(); repos.forEach(dir => rmSync(dir, { recursive: true, force: true })); cleanupTempDataRoots(); });

describe('checkout repair public completion boundary', () => {
  it('accepts a published existing commit and a merged-PR retry without a new commit or spawn', async () => {
    repo(); const original = git(facts.repo, 'rev-parse', 'HEAD');
    writeFileSync(join(facts.repo, 'README.md'), 'existing work\n'); git(facts.repo, 'commit', '-am', 'pre-existing work');
    await dispatch(); const budget = structuredClone(facts.task.metadata); const parked = publish();
    expect(await checkUpdateRepoReadiness({ repoPath: facts.repo })).toMatchObject({ reasons: ['agent-at-work'] });
    const result = await finalizeAgent({ agentId: 'agent-repair', task: structuredClone(facts.task), success: true,
      exitCode: 0, duration: 1000, workspacePath: facts.repo,
      finalSummary: JSON.stringify({ summary: 'Repair complete', taskOutcome: { status: 'completed', reason: 'Repair complete' } }) });
    expect(result).toMatchObject({ success: true, taskOutcome: { status: 'completed' } });
    const validationPassed = completeAgent.mock.calls.at(-1)[1].validationPassed;
    expect(validationPassed).toBe(true);
    expect(resolveTaskOutcome({ reported: { status: 'completed', reason: 'Repair complete' }, success: true, validationPassed }).status).toBe('completed');
    expect(git(facts.repo, 'rev-parse', 'HEAD')).toBe(original);
    for (const key of ['totalSpawnCount', 'failureCount', 'lastSpawnedAt']) expect(facts.task.metadata[key]).toBe(budget[key]);
    git(facts.repo, 'merge', '--ff-only', 'preserved-work'); git(facts.repo, 'push', 'origin', 'main');
    facts.pr.state = 'closed'; facts.pr.merged_at = '2026-01-01T00:02:00Z';
    facts.task.status = 'in_progress'; facts.owner.status = 'running';
    facts.task.metadata.totalSpawnCount = '3';
    facts.owner.metadata.completionTaskDispatch.expected = ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, facts.task.metadata[key]]);
    expect(await evaluate()).toBe(true);
    expect(git(facts.repo, 'rev-parse', 'HEAD')).toBe(parked);
    expect(committedDuringRun).not.toHaveBeenCalled();
    facts.owner.status = 'completed';
    expect(await checkUpdateRepoReadiness({ repoPath: facts.repo })).toMatchObject({ ready: true, needsAgent: false });
  });

  it('requires publication evidence and preserves separately staged and unstaged file versions', async () => {
    repo(); writeFileSync(join(facts.repo, 'README.md'), 'staged work\n'); git(facts.repo, 'add', '.');
    writeFileSync(join(facts.repo, 'README.md'), 'unstaged work\n'); await dispatch();
    git(facts.repo, 'reset', '--hard', 'origin/main'); expect(await evaluate()).toBe(false);
    writeFileSync(join(facts.repo, 'README.md'), 'staged work\n'); git(facts.repo, 'commit', '-am', 'preserve staged');
    writeFileSync(join(facts.repo, 'README.md'), 'unstaged work\n'); git(facts.repo, 'commit', '-am', 'preserve unstaged');
    publish(); facts.forge = false; expect(await evaluate()).toBe(false);
    facts.forge = true; facts.pr.state = 'closed'; expect(await evaluate()).toBe(false);
    facts.pr.state = 'open'; expect(await evaluate()).toBe(true);
    facts.pr.headSha = 'a'.repeat(40); expect(await evaluate()).toBe(false);
  });

  for (const kind of ['dirty', 'conflicted', 'detached', 'wrong-branch', 'interrupted', 'unpublished', 'other-owner', 'paused-owner', 'unreadable-owners', 'task', 'dispatch', 'repository', 'instance', 'origin', 'unreadable-fetch', 'missing-binding']) it(`refuses ${kind} without changing Git or ownership`, async () => {
    repo(); await dispatch();
    if (kind === 'dirty') writeFileSync(join(facts.repo, 'README.md'), 'dirty\n');
    if (kind === 'conflicted') { const blob = git(facts.repo, 'rev-parse', 'HEAD:README.md'); execFileSync('git', ['update-index', '--index-info'], { cwd: facts.repo, input: `0 ${'0'.repeat(40)}\tREADME.md\n100644 ${blob} 1\tREADME.md\n100644 ${blob} 2\tREADME.md\n100644 ${blob} 3\tREADME.md\n` }); }
    if (kind === 'detached') git(facts.repo, 'checkout', '--detach');
    if (kind === 'wrong-branch') git(facts.repo, 'checkout', '-b', 'other');
    if (kind === 'interrupted') writeFileSync(join(facts.repo, '.git', 'MERGE_HEAD'), git(facts.repo, 'rev-parse', 'HEAD'));
    if (kind === 'unpublished') { writeFileSync(join(facts.repo, 'README.md'), 'new\n'); git(facts.repo, 'commit', '-am', 'unpublished'); }
    if (['other-owner', 'paused-owner'].includes(kind)) facts.agents.push({ id: 'agent-other', status: kind === 'paused-owner' ? 'paused' : 'running', metadata: { workspacePath: facts.repo } });
    if (kind === 'unreadable-owners') getAgents.mockRejectedValueOnce(new Error('unreadable'));
    if (kind === 'task') facts.owner.taskId = 'sys-other';
    if (kind === 'dispatch') facts.task.metadata.totalSpawnCount = '9';
    if (kind === 'repository') facts.owner.metadata.workspacePath = '/example/other';
    if (kind === 'instance') facts.owner.metadata.instanceId = 'another-instance';
    if (kind === 'unreadable-fetch') { git(facts.repo, 'remote', 'set-url', 'origin', '/example/missing'); facts.task.metadata.repoRepairContract.origin = '/example/missing'; facts.owner.metadata.completionTaskDispatch.repoRepairContract.origin = '/example/missing'; }
    if (kind === 'origin') git(facts.repo, 'remote', 'set-url', 'origin', '/example/missing');
    if (kind === 'missing-binding') delete facts.owner.metadata.completionTaskDispatch.repoRepairContract;
    const before = git(facts.repo, 'status', '--porcelain'); const owners = structuredClone(facts.agents);
    expect(await evaluate()).toBe(false);
    expect(git(facts.repo, 'status', '--porcelain')).toBe(before); expect(facts.agents).toEqual(owners);
  });

  it('allows behind-origin completion and retains ordinary tasks commit validation', async () => {
    repo(); await dispatch(); const old = git(facts.repo, 'rev-parse', 'HEAD');
    writeFileSync(join(facts.repo, 'README.md'), 'remote update\n'); git(facts.repo, 'commit', '-am', 'remote');
    git(facts.repo, 'push', 'origin', 'main'); git(facts.repo, 'reset', '--hard', old);
    expect(await evaluate()).toBe(true);
    expect(await evaluate({ id: 'sys-ordinary', taskType: 'internal', metadata: {} })).toBe(false);
    expect(committedDuringRun).toHaveBeenCalledOnce(); expect(git(facts.repo, 'rev-parse', 'HEAD')).toBe(old);
  });


  it('captures conflicted index versions and Git-normalized working files for repair', async () => {
    repo();
    const blob = git(facts.repo, 'rev-parse', 'HEAD:README.md');
    execFileSync('git', ['update-index', '--index-info'], { cwd: facts.repo, input: `0 ${'0'.repeat(40)}\tREADME.md\n100644 ${blob} 1\tREADME.md\n100644 ${blob} 2\tREADME.md\n100644 ${blob} 3\tREADME.md\n` });
    writeFileSync(join(facts.repo, 'README.md'), 'local conflict resolution\n');
    const queued = await queueRepoRepairTask(await checkUpdateRepoReadiness({ repoPath: facts.repo }));
    expect(queued.options.repoRepairContract.files).toHaveLength(4);
    expect(queued.options.repoRepairContract.files[0].blob).toBe(git(facts.repo, 'hash-object', 'README.md'));
    expect(queued.options.repoRepairContract.files).toContainEqual({ path: 'README.md', mode: '100644', blob });
    git(facts.repo, 'reset', '--hard', 'HEAD');
    git(facts.repo, 'config', 'core.autocrlf', 'true');
    writeFileSync(join(facts.repo, 'README.md'), 'normalized\r\n');
    const contract = await captureRepoRepairContract(await checkUpdateRepoReadiness({ repoPath: facts.repo }));
    git(facts.repo, 'add', '.');
    expect(contract.files[0].blob).toBe(git(facts.repo, 'rev-parse', ':README.md'));
  });


  it('requires a preserved path/blob/mode tree, including an index-only executable change', async () => {
    repo(); git(facts.repo, 'update-index', '--chmod=+x', 'README.md'); await dispatch();
    git(facts.repo, 'reset', '--hard', 'origin/main');
    expect(await evaluate()).toBe(false);
    git(facts.repo, 'update-index', '--chmod=+x', 'README.md'); git(facts.repo, 'commit', '-m', 'preserve executable');
    publish(); expect(await evaluate()).toBe(true);
  });

  it('refuses lost working-tree conflict edits even if all index stages remain in origin', async () => {
    repo(); const blob = git(facts.repo, 'rev-parse', 'HEAD:README.md');
    execFileSync('git', ['update-index', '--index-info'], { cwd: facts.repo, input: `0 ${'0'.repeat(40)}\tREADME.md\n100644 ${blob} 1\tREADME.md\n100644 ${blob} 2\tREADME.md\n100644 ${blob} 3\tREADME.md\n` });
    writeFileSync(join(facts.repo, 'README.md'), 'local resolution work\n'); await dispatch();
    git(facts.repo, 'reset', '--hard', 'origin/main'); expect(await evaluate()).toBe(false);
    writeFileSync(join(facts.repo, 'README.md'), 'local resolution work\n'); git(facts.repo, 'commit', '-am', 'preserve resolution');
    publish(); expect(await evaluate()).toBe(true);
  });


  it('captures a rename source deletion and refuses a PR that restores it', async () => {
    repo(); git(facts.repo, 'mv', 'README.md', 'renamed.md'); await dispatch();
    expect(facts.task.metadata.repoRepairContract.files).toContainEqual({ path: 'README.md', blob: null, mode: null });
    writeFileSync(join(facts.repo, 'README.md'), 'seed\n'); git(facts.repo, 'add', '.'); git(facts.repo, 'commit', '-m', 'retain both paths');
    publish(); expect(await evaluate()).toBe(false);
  });

  it('checks filenames literally instead of borrowing matching content from another path', async () => {
    repo(); writeFileSync(join(facts.repo, 'draft1.txt'), 'draft\n'); git(facts.repo, 'add', '.');
    git(facts.repo, 'commit', '-m', 'existing draft'); git(facts.repo, 'push', 'origin', 'main');
    writeFileSync(join(facts.repo, 'draft[1].txt'), 'draft\n'); await dispatch();
    unlinkSync(join(facts.repo, 'draft[1].txt')); expect(await evaluate()).toBe(false);
    writeFileSync(join(facts.repo, 'draft[1].txt'), 'draft\n'); git(facts.repo, 'add', '.'); git(facts.repo, 'commit', '-m', 'preserve literal filename');
    publish(); expect(await evaluate()).toBe(true);
  });


  it('keeps HTTPS remote credentials out of persisted repair baselines', async () => {
    repo(); git(facts.repo, 'remote', 'set-url', 'origin', 'https://example-user:example-secret@example.com/example/PortOS.git');
    const contract = await captureRepoRepairContract(await checkUpdateRepoReadiness({ repoPath: facts.repo }));
    expect(contract.origin).toBe('https://***@example.com/example/PortOS.git');
    expect(JSON.stringify(contract)).not.toContain('example-secret');
    expect(JSON.stringify(contract)).not.toContain('example-user');
  });

  it('queues the server-owned contract without inferring it from task prose', async () => {
    repo(); const queued = await queueRepoRepairTask(await checkUpdateRepoReadiness({ repoPath: facts.repo }));
    expect(queued.options.repoRepairContract).toMatchObject({ version: 2, instanceId: 'example-instance', repoPath: facts.repo });
    expect(queued.data.targetInstanceId).toBe('example-instance');
    expect(queued.data.useWorktree).toBe(false); expect(queued.type).toBe('internal');
  });
  it('queues and completes dirty child preservation without a parent commit or changed retry budgets', async () => {
    repo(); const child = submodule(facts.repo, 'deps/child [one]');
    const original = git(facts.repo, 'rev-parse', 'HEAD');
    localChildWork(child); git(facts.repo, 'add', 'deps/child [one]');
    const ready = await checkUpdateRepoReadiness({ repoPath: facts.repo });
    expect(ready.reasons).toContain('uncommitted-changes');
    const queued = await queueRepoRepairTask(ready);
    const baseline = queued.options.repoRepairContract;
    expect(baseline.submodules[0]).toMatchObject({ path: 'deps/child [one]', repository: { repoPath: child,
      origin: git(child, 'remote', 'get-url', 'origin'), head: git(child, 'rev-parse', 'HEAD') } });
    expect(baseline.files).toEqual([]); expect(baseline.submodules[0].repository.files).toHaveLength(3);
    await dispatch(); const before = structuredClone(facts.task.metadata);
    preserveChild(child); git(facts.repo, 'reset', '--hard', 'origin/main');
    expect(await evaluate()).toBe(true); expect(git(facts.repo, 'rev-parse', 'HEAD')).toBe(original);
    expect(facts.task.metadata).toEqual(before); expect(committedDuringRun).not.toHaveBeenCalled();
    facts.prs[child].state = 'closed'; facts.prs[child].merged_at = '2026-01-01T00:02:00Z';
    expect(await evaluate()).toBe(true);
  });

  it('requires preservation of a staged parent gitlink independent of the child checkout HEAD', async () => {
    repo(); const child = submodule(facts.repo, 'deps/child');
    writeFileSync(join(child, 'pinned.txt'), 'staged pointer work\n'); git(child, 'add', '.'); git(child, 'commit', '-m', 'staged pin');
    const pinned = git(child, 'rev-parse', 'HEAD'); git(facts.repo, 'add', 'deps/child');
    git(child, 'reset', '--hard', 'origin/main'); localChildWork(child); await dispatch();
    preserveChild(child); git(facts.repo, 'reset', '--hard', 'origin/main');
    expect(await evaluate()).toBe(false);
    git(child, 'checkout', 'preserved-work'); git(child, 'merge', '--no-edit', pinned);
    git(child, 'push', 'origin', 'preserved-work'); facts.prs[child].headSha = git(child, 'rev-parse', 'HEAD');
    git(child, 'checkout', '--detach', 'origin/main');
    expect(await evaluate()).toBe(true);
  });

  it('recursively preserves nested child work and independently requires its own publication', async () => {
    repo(); const outer = submodule(facts.repo, 'deps/outer', 'example/Outer');
    const inner = submodule(outer, 'nested/inner', 'example/Inner');
    git(facts.repo, 'commit', '-am', 'pin nested dependency'); git(facts.repo, 'push', 'origin', 'main');
    localChildWork(inner); await dispatch();
    expect(facts.task.metadata.repoRepairContract.submodules[0].repository.submodules[0].path).toBe('nested/inner');
    preserveChild(inner); const proof = facts.prs[inner]; delete facts.prs[inner];
    expect(await evaluate()).toBe(false); facts.prs[inner] = proof; expect(await evaluate()).toBe(true);
  });

  for (const kind of ['lost-work', 'lost-staged', 'unpublished-commit', 'origin', 'path', 'gitlink', 'child-pr', 'unreadable', 'other-owner', 'symlink']) it(`refuses submodule ${kind} at the public completion boundary`, async () => {
    repo(); const child = submodule(facts.repo, 'deps/child'); localChildWork(child); await dispatch();
    if (kind === 'lost-work') { git(child, 'reset', '--hard', 'origin/main'); unlinkSync(join(child, 'draft.txt')); }
    else if (kind === 'lost-staged') { git(child, 'add', '.'); git(child, 'commit', '-m', 'lost staged version'); publish(child); }
    else preserveChild(child);
    if (kind === 'unpublished-commit') delete facts.prs[child];
    if (kind === 'origin') git(child, 'remote', 'set-url', 'origin', '/example/missing');
    if (['path', 'gitlink'].includes(kind)) {
      const evidence = facts.task.metadata.repoRepairContract.submodules[0];
      if (kind === 'path') evidence.path = '../outside'; else evidence.headGitlink = 'a'.repeat(40);
      facts.owner.metadata.completionTaskDispatch.repoRepairContract = structuredClone(facts.task.metadata.repoRepairContract);
    }
    if (kind === 'child-pr') facts.prs[child].headRepo = 'example/PortOS';
    if (kind === 'unreadable') facts.forge = false;
    if (kind === 'other-owner') facts.agents.push({ id: 'other-child-owner', status: 'paused', metadata: { workspacePath: child } });
    if (kind === 'symlink') { const moved = child + '-moved'; renameSync(child, moved); symlinkSync(moved, child, 'dir'); }
    expect(await evaluate()).toBe(false);
  });

  it('retains version-one and legacy repair completion contracts', async () => {
    repo(); await dispatch(); const contract = facts.task.metadata.repoRepairContract;
    contract.version = 1; delete contract.submodules;
    facts.owner.metadata.completionTaskDispatch.repoRepairContract = structuredClone(contract);
    expect(await evaluate()).toBe(true);
    facts.task.description = 'Restore the PortOS checkout to a clean default branch so automatic updates can run';
    facts.task.metadata.useWorktree = false;
    delete facts.task.metadata.repoRepairContract; delete facts.owner.metadata.completionTaskDispatch.repoRepairContract;
    expect(await evaluate()).toBe(true);
  });

});
