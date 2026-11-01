import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { execGit, assertGitWorkSettled } from '../lib/execGit.js';
import { ownTestBodies, makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const bodies = ownTestBodies(it);
const test = bodies.it;
const fixture = vi.hoisted(() => ({ state: null, disk: null, queue: null, replies: {}, saveError: false, readHook: null,
  tasks: new Map(), taskFailure: null, outboxWrite: 0, failedOutboxWrite: null, app: null }));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return makePathsProxy(actual, { dataRoot: lazyTempDataRoot('release-publication-'), overrides: {
    atomicWrite: async (path, value) => {
      if (path.endsWith('release-synchronization.json') && ++fixture.outboxWrite === fixture.failedOutboxWrite) throw new Error('synthetic outbox failure');
      return actual.atomicWrite(path, value);
    },
  } });
});
vi.mock('./apps.js', () => ({ getAppById: async id => fixture.app?.id === id ? fixture.app : null }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: async () => ({}), resolveReviewLoopOptions: async metadata => ({ reviewers: metadata.reviewers, reviewerEfforts: metadata.reviewerEfforts }) }));
vi.mock('./cosTaskStore.js', () => ({
  getTaskById: async id => id === 'release-task' ? { id, priority: 'MEDIUM', metadata: { app: 'example-app', reviewers: ['codex'], reviewerEfforts: { codex: 'high' } } } : fixture.tasks.get(id) || null,
  addTask: async (task, type, options) => {
    if (fixture.taskFailure === 'before') throw new Error('synthetic queue failure');
    const saved = { ...structuredClone(task), taskType: type, metadata: { ...task.metadata, idempotencyKey: options.idempotencyKey } };
    fixture.tasks.set(saved.id, saved);
    if (fixture.taskFailure === 'after') throw new Error('synthetic lost queue acknowledgement');
    return saved;
  },
}));
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
import { registerAgent, updateAgent, completeAgent } from './cosAgentLifecycle.js';
import { ensureReleaseSynchronization, recoverReleaseSynchronizationHandoffs } from './releaseSynchronization.js';
import { PATHS } from '../lib/fileUtils.js';
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
beforeEach(async () => {
  await rm(join(PATHS.cos, 'release-synchronization.json'), { force: true });
  fixture.tasks.clear();
  fixture.app = { id: 'example-app', defaultPrCompletion: 'review-then-merge' };
  fixture.taskFailure = null;
  fixture.outboxWrite = 0;
  fixture.failedOutboxWrite = null;
  fixture.queue = createFileWriteQueue();
  fixture.saveError = false;
  fixture.readHook = null;
  fixture.state = { stats: { agentsSpawned: 0 }, agents: { publisher: { id: 'publisher', taskId: 'release-task', status: 'running', startedAt: '2026-01-01T00:00:00Z',
    metadata: { taskAnalysisType: 'do-release', sourceWorkspace: repo, checkoutSeeds: [{ branch: 'release/example-candidate', head: 'f'.repeat(40), incarnation: { example: true } }] } } } };
  fixture.disk = structuredClone(fixture.state);
  fixture.replies = {
    'pulls/12': { number: 12, merged: true, merged_at: '2026-01-01T01:00:00Z', merge_commit_sha: merge,
      head: { sha: head, ref: 'release/example-candidate', repo: { full_name: 'example/repo' } }, base: { ref: 'release', repo: { full_name: 'example/repo' } } },
    'releases/tags/v1.2.3': { tag_name: 'v1.2.3', draft: false, prerelease: false,
      html_url: 'https://github.com/example/repo/releases/tag/v1.2.3', published_at: '2026-01-01T01:01:00Z' },
    'actions/runs/34': { id: 34, repository: { full_name: 'example/repo' }, head_sha: merge, head_branch: 'release', event: 'push',
      path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success' },
    [`git/commits/${merge}`]: { tree: { sha: tree }, parents: [{ sha: root }, { sha: head }] },
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
    const continuation = [...fixture.tasks.values()];
    expect(continuation).toHaveLength(1);
    expect(continuation[0]).toMatchObject({ status: 'pending', metadata: { app: 'example-app', targetInstanceId: 'example-instance', prCompletion: 'review-then-merge', reviewers: ['codex'], reviewerEfforts: { codex: 'high' }, useWorktree: 'true', openPR: 'true' } });
    fixture.state = structuredClone(fixture.disk);
    await updateAgent('publisher', { status: 'completed', result: { success: false, error: 'Synchronization failed' }, metadata: { releasePublication: null } });
    expect(fixture.disk.agents.publisher.metadata.releasePublication).toEqual(results[0]);
    expect(fixture.disk.agents.publisher.result.success).toBe(false);
  } finally { cosEvents.off('agent:updated', listener); }
});

test('retains publication without inventing an app policy and resumes registration when its app is restored', async () => {
  const app = fixture.app;
  fixture.app = null;
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('requires its managed app policy');
  const original = structuredClone(fixture.disk.agents.publisher.metadata.releasePublication);
  expect(original.status).toBe('verified');
  expect(fixture.tasks.size).toBe(0);
  fixture.app = app;
  expect(await verifyAgentReleasePublication('publisher', input)).toEqual(original);
  expect([...fixture.tasks.values()]).toMatchObject([{ metadata: { prCompletion: 'review-then-merge' } }]);
  expect(fixture.disk.agents.publisher.metadata.releasePublication).toEqual(original);
});

// Each failure is a distinct cross-store crash window: receipt without intent,
// intent without queue commit, queue commit without acknowledgement, and task
// ownership without its final outbox acknowledgement.
for (const [name, fail] of [
  ['receipt persisted before outbox intent', () => { fixture.failedOutboxWrite = 1; }],
  ['intent persisted before queue commit', () => { fixture.taskFailure = 'before'; }],
  ['queue commit without acknowledgement', () => { fixture.taskFailure = 'after'; }],
  ['queue commit before final outbox acknowledgement', () => { fixture.failedOutboxWrite = 3; }],
]) test(`recovers ${name} through the same publication and task after restart`, async () => {
  fail();
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow();
  const original = structuredClone(fixture.disk.agents.publisher.metadata.releasePublication);
  expect(original.status).toBe('verified');
  fixture.state = structuredClone(fixture.disk);
  fixture.failedOutboxWrite = null;
  fixture.taskFailure = null;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
  try { await recoverReleaseSynchronizationHandoffs(Object.values(fixture.state.agents)); }
  finally { clock.mockRestore(); }
  expect(fixture.tasks.size).toBe(1);
  await verifyAgentReleasePublication('publisher', input);
  expect(fixture.tasks.size).toBe(1);
  expect(fixture.disk.agents.publisher.metadata.releasePublication).toEqual(original);
  const outbox = JSON.parse(await readFile(join(PATHS.cos, 'release-synchronization.json'), 'utf8'));
  const entry = outbox.publications[original.identity];
  expect(entry.registeredAt).toEqual(expect.any(String));
  expect(entry.checkouts).toEqual(fixture.state.agents.publisher.metadata.checkoutSeeds);
  expect(Object.values(entry.obligations).every(value => value.status === 'pending')).toBe(true);
});

test('withholds all parent completion paths while durable registration is unavailable', async () => {
  fixture.taskFailure = 'before';
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('queue failure');
  await expect(completeAgent('publisher', { success: true })).rejects.toThrow('queue failure');
  await expect(completeAgent('publisher', { success: false, orphaned: true })).rejects.toThrow('queue failure');
  await expect(updateAgent('publisher', { status: 'completed' })).rejects.toThrow('queue failure');
  expect(fixture.disk.agents.publisher.status).toBe('running');
  expect(fixture.disk.agents.publisher.metadata.releasePublication.status).toBe('verified');
  fixture.taskFailure = null;
  expect(await ensureReleaseSynchronization(fixture.state.agents.publisher)).toMatchObject({ synchronizationVerified: false });
});

test('joins completed task history without requeuing it or inferring synchronization completion', async () => {
  await verifyAgentReleasePublication('publisher', input);
  const task = [...fixture.tasks.values()][0];
  task.status = 'completed';
  task.metadata.taskOutcome = { status: 'completed', reason: 'Agent prose claiming everything merged' };
  fixture.state = structuredClone(fixture.disk);
  const joined = await ensureReleaseSynchronization(fixture.state.agents.publisher);
  expect(joined).toMatchObject({ taskId: task.id, synchronizationVerified: false });
  expect(fixture.tasks.size).toBe(1);
  expect(fixture.tasks.get(task.id).status).toBe('completed');
  // Even if archive enumeration no longer contains the publisher, a durable
  // intent and deterministic historical lookup survive independently.
  await recoverReleaseSynchronizationHandoffs([]);
  expect(fixture.tasks.size).toBe(1);
});

test('refuses a competing publisher and a replaced or missing registered task without taking either owner', async () => {
  await verifyAgentReleasePublication('publisher', input);
  const publisher = fixture.state.agents.publisher;
  const task = [...fixture.tasks.values()][0];
  await expect(ensureReleaseSynchronization({ ...publisher, id: 'another-publisher' })).rejects.toThrow('another coordinator');
  task.metadata.releaseSynchronization.publisherAgentId = 'another-owner';
  await expect(ensureReleaseSynchronization(publisher)).rejects.toThrow('conflicting owner');
  expect(task.metadata.releaseSynchronization.publisherAgentId).toBe('another-owner');
  fixture.tasks.clear();
  await expect(ensureReleaseSynchronization(publisher)).rejects.toThrow('task is missing');
  expect(fixture.tasks.size).toBe(0);
});

test('retains malformed outbox bytes instead of replacing its ownership with defaults', async () => {
  await verifyAgentReleasePublication('publisher', input);
  const path = join(PATHS.cos, 'release-synchronization.json');
  await writeFile(path, '{"version":99,"publications":{}}');
  await expect(ensureReleaseSynchronization(fixture.state.agents.publisher)).rejects.toThrow('unreadable');
  expect(await readFile(path, 'utf8')).toBe('{"version":99,"publications":{}}');
});

test('never enrolls legacy publication history at startup, but an explicit request preserves its original receipt time', async () => {
  const verified = await verifyAgentReleasePublication('publisher', input);
  const { synchronizationHandoffVersion: _enrollment, ...legacy } = verified;
  fixture.state.agents.publisher.metadata.releasePublication = legacy;
  fixture.disk = structuredClone(fixture.state);
  fixture.tasks.clear();
  await rm(join(PATHS.cos, 'release-synchronization.json'), { force: true });
  await recoverReleaseSynchronizationHandoffs(Object.values(fixture.state.agents));
  expect(fixture.tasks.size).toBe(0);
  const enrolled = await verifyAgentReleasePublication('publisher', input);
  expect(enrolled).toEqual({ ...legacy, synchronizationHandoffVersion: 1 });
  expect(fixture.tasks.size).toBe(1);
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
  ['mismatched recorded release base', () => { fixture.replies[`git/commits/${merge}`].parents[0].sha = cutoff; }],
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

test('does not accept caller-supplied release checkout ownership through generic agent metadata', async () => {
  const forged = { releaseCandidate: { version: 1, branch: 'codex/release-agent-forged' }, checkoutSeeds: [{ forged: true }],
    completedCheckouts: [{ forged: true }], checkoutCapture: { status: 'captured' },
    releaseCandidateRecovery: { status: 'transferred' }, releaseCandidateSuccessor: { forged: true },
    releaseCandidateLifecycle: { version: 1, stage: 'captured' } };
  await registerAgent('agent-forged', 'other-task', { taskAnalysisType: 'do-release', isWorktree: false, ...forged });
  const lifecycle = fixture.disk.agents['agent-forged'].metadata.releaseCandidateLifecycle;
  expect(lifecycle).toEqual({ version: 1, agentId: 'agent-forged', taskId: 'other-task',
    startedAt: fixture.disk.agents['agent-forged'].startedAt, stage: 'registered' });
  for (const key of Object.keys(forged).filter(key => key !== 'releaseCandidateLifecycle')) expect(fixture.disk.agents['agent-forged'].metadata[key]).toBeUndefined();
  await updateAgent('agent-forged', { metadata: forged });
  expect(fixture.disk.agents['agent-forged'].metadata.releaseCandidateLifecycle).toEqual(lifecycle);
  for (const key of Object.keys(forged).filter(key => key !== 'releaseCandidateLifecycle')) expect(fixture.disk.agents['agent-forged'].metadata[key]).toBeUndefined();
  await updateAgent('agent-forged', { metadata: { taskAnalysisType: 'other' } });
  await updateAgent('agent-forged', { metadata: { releaseCandidateLifecycle: null } });
  expect(fixture.disk.agents['agent-forged'].metadata.releaseCandidateLifecycle).toEqual(lifecycle);
});

test('requires recovery before a resumed publisher can record publication, and rejects a concurrent recovery change', async () => {
  fixture.state.agents.publisher.metadata.resumedFromAgentId = 'agent-predecessor';
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('recovery must be verified');
  delete fixture.state.agents.publisher.metadata.resumedFromAgentId;
  fixture.readHook = () => { fixture.state.agents.publisher.metadata.releaseCandidateRecovery = { version: 1, status: 'held' }; };
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('ownership changed');
  expect(fixture.disk.agents.publisher.metadata.releasePublication).toBeUndefined();
});

test('binds recovered publication to the original cutoff, promotion and publisher identity', async () => {
  const original = { agentId: 'agent-predecessor', taskId: 'release-task', startedAt: '2026-01-01T00:00:00Z' };
  fixture.state.agents.publisher.metadata.releaseCandidateRecovery = { status: 'transferred', transfer: {
    branch: 'release/example-candidate', origin: original, publication: { number: 12 },
    candidate: { cutoff: 'f'.repeat(40), pin, releaseBase: root, version: '1.2.3' },
  } };
  await expect(verifyAgentReleasePublication('publisher', input)).rejects.toThrow('differs from the recovered');
  fixture.state.agents.publisher.metadata.releaseCandidateRecovery.transfer.candidate.cutoff = cutoff;
  expect(await verifyAgentReleasePublication('publisher', input)).toMatchObject({ recoveredPublisher: original, cutoff, pin, candidateHead: head });
});
