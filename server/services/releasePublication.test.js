import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { execGit, assertGitWorkSettled } from '../lib/execGit.js';
import { ownTestBodies, makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const bodies = ownTestBodies(it);
const test = bodies.it;
const fixture = vi.hoisted(() => ({ state: null, disk: null, queue: null, replies: {}, saveError: false, readHook: null }));
vi.mock('../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: lazyTempDataRoot('release-publication-') }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: '/unused-synthetic-agents',
  loadState: async () => fixture.state,
  withStateLock: fn => fixture.queue(fn),
  saveState: async state => {
    if (fixture.saveError) throw new Error('synthetic persistence failure');
    fixture.disk = structuredClone(state);
    fixture.state = state;
  },
}));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ isGithub: true, host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async cwd => ({ cwd, env: {} }) }));
vi.mock('./github.js', () => ({ execGh: async args => {
  await fixture.readHook?.();
  const path = args.at(-1).replace('repos/example/repo/', '');
  if (!Object.hasOwn(fixture.replies, path)) throw new Error('synthetic forge failure');
  return JSON.stringify(fixture.replies[path]);
} }));
import { verifyAgentReleasePublication } from './releasePublication.js';
import { registerAgent, updateAgent } from './cosAgentLifecycle.js';
import { cosEvents } from './cosEvents.js';

let repo, root, cutoff, pin, head, tree;
const merge = 'a'.repeat(40), annotated = 'b'.repeat(40);
const input = { version: '1.2.3', promotionPrNumber: 12, workflowRunId: 34 };
const git = async args => (await execGit(args, repo)).stdout.trim();
beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'publication-git-'));
  await git(['init']);
  await git(['config', 'user.name', 'Example']);
  await git(['config', 'user.email', 'example@example.com']);
  await writeFile(join(repo, 'package.json'), '{"version":"1.2.3"}');
  await git(['add', 'package.json']);
  await git(['commit', '-m', 'initial']);
  root = await git(['rev-parse', 'HEAD']);
  // Previous publications' pins remain in history; only the current pin wins.
  const message = cut => `chore: pin release candidate\n\nRelease-Cut: ${cut}\nRelease-Base: ${root}\nRelease-Previous-Tag: v1.2.2\nRelease-Previous-Commit: ${root}`;
  await git(['commit', '--allow-empty', '-m', message(root)]);
  cutoff = await git(['rev-parse', 'HEAD']);
  await git(['commit', '--allow-empty', '-m', message(cutoff)]);
  pin = await git(['rev-parse', 'HEAD']);
  await git(['commit', '--allow-empty', '-m', 'release preparation']);
  head = await git(['rev-parse', 'HEAD']);
  tree = await git(['rev-parse', 'HEAD^{tree}']);
});
afterAll(async () => {
  await bodies.drain();
  assertGitWorkSettled(repo);
  await rm(repo, { recursive: true, force: true });
  cleanupTempDataRoots();
});
beforeEach(() => {
  fixture.queue = createFileWriteQueue();
  fixture.saveError = false;
  fixture.readHook = null;
  fixture.state = { stats: { agentsSpawned: 0 }, agents: { publisher: { id: 'publisher', taskId: 'release-task', status: 'running', startedAt: '2026-01-01T00:00:00Z',
    metadata: { taskAnalysisType: 'do-release', sourceWorkspace: repo } } } };
  fixture.disk = structuredClone(fixture.state);
  fixture.replies = {
    'pulls/12': { number: 12, merged: true, merged_at: '2026-01-01T01:00:00Z', merge_commit_sha: merge,
      head: { sha: head, repo: { full_name: 'example/repo' } }, base: { ref: 'release', repo: { full_name: 'example/repo' } } },
    'releases/tags/v1.2.3': { tag_name: 'v1.2.3', draft: false, prerelease: false,
      html_url: 'https://github.com/example/repo/releases/tag/v1.2.3', published_at: '2026-01-01T01:01:00Z' },
    'actions/runs/34': { id: 34, repository: { full_name: 'example/repo' }, head_sha: merge, head_branch: 'release', event: 'push',
      path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success' },
    [`git/commits/${merge}`]: { tree: { sha: tree }, parents: [{ sha: head }] },
    'git/ref/tags/v1.2.3': { ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: annotated } },
    [`git/tags/${annotated}`]: { object: { type: 'commit', sha: merge } },
  };
});

test('publishes a durable live milestone once, emits it, and retains it across restart and later execution failure', async () => {
  const events = [];
  const listener = agent => events.push(structuredClone(agent));
  cosEvents.on('agent:updated', listener);
  try {
    const results = await Promise.all([verifyAgentReleasePublication('publisher', input), verifyAgentReleasePublication('publisher', input)]);
    expect(results[1]).toEqual(results[0]);
    expect(events).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'verified', repository: 'example/repo', cutoff, pin, candidateHead: head, promotionMerge: merge, tagCommit: merge, tagTree: tree, workflowRunId: 34 });
    expect(events[0]).toMatchObject({ status: 'running' });
    expect(events[0].result).toBeUndefined();
    fixture.state = structuredClone(fixture.disk);
    await updateAgent('publisher', { status: 'completed', result: { success: false, error: 'Synchronization failed' }, metadata: { releasePublication: null } });
    expect(fixture.disk.agents.publisher.metadata.releasePublication).toEqual(results[0]);
    expect(fixture.disk.agents.publisher.result.success).toBe(false);
  } finally { cosEvents.off('agent:updated', listener); }
});

for (const [name, change] of [
  ['draft release', () => { fixture.replies['releases/tags/v1.2.3'].draft = true; }],
  ['wrong repository', () => { fixture.replies['pulls/12'].head.repo.full_name = 'other/repo'; }],
  ['wrong candidate version', () => { input.version = '1.2.4'; }],
  ['wrong tag tree', () => { fixture.replies[`git/tags/${annotated}`].object.sha = 'c'.repeat(40); fixture.replies[`git/commits/${'c'.repeat(40)}`] = { tree: { sha: 'd'.repeat(40) } }; }],
  ['missing tag', () => { delete fixture.replies['git/ref/tags/v1.2.3']; }],
  ['failed workflow', () => { fixture.replies['actions/runs/34'].conclusion = 'failure'; }],
  ['unrelated workflow', () => { fixture.replies['actions/runs/34'].path = '.github/workflows/ci.yml'; }],
  ['wrong workflow head', () => { fixture.replies['actions/runs/34'].head_sha = head; }],
  ['changed candidate tree', () => { fixture.replies[`git/commits/${merge}`].tree.sha = 'e'.repeat(40); }],
  ['missing candidate pin', () => { fixture.replies['pulls/12'].head.sha = root; }],
]) test(`refuses ${name} without writing a milestone`, async () => {
  change();
  try {
    await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow();
    expect(fixture.disk.agents.publisher.metadata.releasePublication).toBeUndefined();
  } finally { input.version = '1.2.3'; }
});

test('rejects ownership changes during forge verification and conflicting identities', async () => {
  fixture.readHook = () => { fixture.state.agents.publisher.startedAt = '2026-01-02T00:00:00Z'; };
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('ownership changed');
  expect(fixture.disk.agents.publisher.metadata.releasePublication).toBeUndefined();
  fixture.readHook = null;
  fixture.state.agents.publisher.metadata.releasePublication = { identity: 'another-release' };
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('different publication');
});

test('does not expose a failed persistence attempt and safely retries it', async () => {
  fixture.saveError = true;
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('persistence failure');
  expect(fixture.state.agents.publisher.metadata.releasePublication).toBeUndefined();
  fixture.saveError = false;
  await verifyAgentReleasePublication('publisher', input);
  expect(fixture.disk.agents.publisher.metadata.releasePublication.status).toBe('verified');
});

test('does not accept publication prose or caller-supplied receipts through registration and updates', async () => {
  await registerAgent('synthetic', 'other-task', { releasePublication: { status: 'verified' } });
  expect(fixture.disk.agents.synthetic.metadata.releasePublication).toBeNull();
  await updateAgent('synthetic', { metadata: { releasePublication: { status: 'verified' } } });
  expect(fixture.disk.agents.synthetic.metadata.releasePublication).toBeNull();
  await expect(verifyAgentReleasePublication('synthetic', input)).rejects.toThrow('active release');
  await expect(verifyAgentReleasePublication('publisher', { ...input, releaseUrl: 'https://example.com' })).rejects.toThrow();
});
