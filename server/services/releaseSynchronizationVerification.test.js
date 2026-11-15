import { pinPlatform } from '../lib/testHelper.js';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const f = vi.hoisted(() => ({ agents: [], pr: null, prs: null, unavailable: false, ancestor: true, notAncestor: new Set(), failSave: false,
  liveAgents: null, liveTrusted: true, forgeCalls: 0, developmentVersion: null, lockVersion: null, lockRootVersion: null,
  hasLock: true, versionUnavailable: false, versionReads: [], developmentHead: null, compareUnavailable: false, runner: [] }));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return makePathsProxy(actual, { dataRoot: lazyTempDataRoot('release-sync-verifier-'), overrides: {
    atomicWrite: async (path, value) => {
      if (f.failSave && path.endsWith('release-synchronization.json')) throw new Error('synthetic outbox write failure');
      return actual.atomicWrite(path, value);
    },
  } });
});
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  // Native node:path keeps the host dialect even while process.platform is pinned.
  // Map only synthetic fixture paths back to their POSIX keys; real I/O stays native.
  const fixturePath = path => typeof path === 'string' ? path.replaceAll('\\', '/').replace(/^[a-z]:/i, '') : path;
  return { ...actual, realpath: async path => typeof path === 'string' && fixturePath(path).startsWith('/example/')
    ? fixturePath(path) : actual.realpath(path) };
});
vi.mock('./cosState.js', () => ({ loadState: async () => ({ agents: {} }), withStateLock: createFileWriteQueue(),
  readAgentsStateForSafetyCheck: async () => ({ trusted: f.liveTrusted,
    agents: Object.fromEntries((f.liveAgents || f.agents).map(agent => [agent.id, agent])) }) }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: async () => ({}), resolveReviewLoopOptions: async () => ({
  reviewers: ['codex'], usernames: ['example-reviewer'], optionalReviewers: [], reviewerApplies: false }) }));
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionPolicies: vi.fn(async () => structuredClone(f.agents)) }));
vi.mock('./apps.js', () => ({ getAppById: async () => ({ id: 'example-app', repoPath: '/example/repo' }) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async (args, cwd) => ({ exitCode: 0, stdout: `${cwd}/.git` }) }));
vi.mock('./shell.js', () => ({ listAllSessions: () => [] }));
vi.mock('./cosRunnerClient.js', () => ({ getActiveAgentsFromRunner: async () => f.runner }));
vi.mock('./github.js', () => ({ execGh: async args => {
  f.forgeCalls++;
  if (f.unavailable) throw new Error('synthetic forge transport failure');
  const path = args.at(-1).replace(/^repos\/example\/repo\/?/, '');
  let result;
  if (path === '') result = { full_name: 'example/repo', default_branch: 'main', owner: { login: 'example' } };
  else if (path === 'git/ref/heads/main') result = { object: { type: 'commit', sha: f.developmentHead } };
  else if (path.startsWith('pulls?')) result = [f.prs || [f.pr]];
  else if (/^pulls\/\d+$/.test(path)) result = [f.pr, ...(f.prs || [])].find(pr => pr.number === Number(path.slice(6)));
  else if (path.startsWith('compare/')) {
    if (f.compareUnavailable) throw new Error('synthetic compare transport failure');
    const base = path.slice(8, 48);
    result = { status: f.ancestor && !f.notAncestor.has(base) ? 'ahead' : 'diverged', merge_base_commit: { sha: base } };
  }
  else if (path.startsWith('git/trees/')) result = { truncated: false, tree: f.hasLock
    ? [{ path: 'package-lock.json', type: 'blob', sha: '1'.repeat(40) }] : [] };
  else if (path.startsWith('contents/package.json?ref=')) {
    f.versionReads.push(path);
    if (f.versionUnavailable) throw new Error('synthetic version transport failure');
    result = { encoding: 'base64', sha: '2'.repeat(40), content: Buffer.from(JSON.stringify({ version: f.developmentVersion })).toString('base64') };
  } else if (path.startsWith('contents/package-lock.json?ref=')) {
    f.versionReads.push(path);
    result = { encoding: 'base64', sha: '3'.repeat(40), content: Buffer.from(JSON.stringify({ version: f.lockVersion,
      packages: { '': { version: f.lockRootVersion } } })).toString('base64') };
  }
  else throw new Error(`Unexpected synthetic forge endpoint: ${path}`);
  return JSON.stringify(result);
} }));

import { addTask, getTaskById, updateTask } from './cosTaskStore.js';
import { ensureReleaseSynchronization, verifyReleaseSynchronizationTask, verifyInlineReleaseDelivery, recoverReleaseSynchronizationHandoffs,
  releaseTaskDispatchDisposition, verifyIndependentReleaseDelivery, deliveredReleaseTaskIds, observeReleaseDeliveries } from './releaseSynchronization.js';
import { markAgentDispatching, clearAgentDispatching, setUseRunner } from './agentState.js';
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';
import { RELEASE_SYNC_OBLIGATIONS } from '../lib/releaseSynchronization.js';
import { cosEvents } from './cosEvents.js';
import { PATHS } from '../lib/fileUtils.js';

let restorePlatform;
afterEach(() => restorePlatform?.());
afterAll(cleanupTempDataRoots);
let identity, taskId, publication;
const getReleaseSynchronization = async key => (await readReleaseSynchronizationOutbox()).publications[key];
const syncBranch = 'cos/example/issue-42/example';
beforeEach(async () => {
  await rm(join(PATHS.cos, 'release-synchronization.json'), { force: true });
  f.forgeCalls = 0;
  f.developmentVersion = f.lockVersion = f.lockRootVersion = '2.109.0';
  f.hasLock = true;
  f.versionUnavailable = false;
  f.versionReads = [];
  f.developmentHead = 'e'.repeat(40);
  f.compareUnavailable = false;
  f.liveAgents = null;
  f.liveTrusted = true;
  f.runner = [];
  f.prs = null;
  restorePlatform = pinPlatform('darwin');
  f.failSave = false;
  f.unavailable = false;
  f.ancestor = true;
  f.notAncestor = new Set();
  identity = (await import('node:crypto')).randomBytes(32).toString('hex');
  const source = await addTask({ description: `Release example ${identity}`, app: 'example-app' });
  publication = { identity, status: 'verified', synchronizationHandoffVersion: 1, repository: 'example/repo', tag: `v1.2.3-${identity}`,
    candidateHead: 'a'.repeat(40), candidateBranch: 'codex/release-publisher', promotionPrNumber: 12, promotionMerge: 'b'.repeat(40), publishedAt: '2026-01-01T01:00:00Z' };
  const publisher = { id: `publisher-${identity}`, taskId: source.id, startedAt: '2026-01-01T00:00:00Z', status: 'completed', completedAt: '2026-01-01T01:01:00Z',
    metadata: { workspacePath: '/example/repo', releasePublication: publication, checkoutSeeds: [{ branch: publication.candidateBranch }] } };
  ({ taskId } = await ensureReleaseSynchronization(publisher));
  f.pr = { number: 42, state: 'closed', merged: true, merged_at: '2026-01-01T01:10:00Z', merge_commit_sha: 'd'.repeat(40),
    head: { sha: 'c'.repeat(40), ref: syncBranch, repo: { full_name: 'example/repo' } }, base: { ref: 'main', repo: { full_name: 'example/repo' } } };
  f.agents = [publisher, { id: `sync-${identity}`, taskId, startedAt: '2026-01-01T01:02:00Z', status: 'running',
    metadata: { workspacePath: '/example/sync-checkout', sourceWorkspace: '/example/repo', isWorktree: true, worktreeBranch: syncBranch } }];
});

it('verifies an inline release from its merged back-merge PR, ancestry and version floor while the owner still runs', async () => {
  const source = await addTask({ description: 'Inline release', app: 'inline-app', metadata: { analysisType: 'do-release' } }, 'internal');
  const inlinePublication = { ...publication, identity: '8'.repeat(64), synchronizationHandoffVersion: 2,
    version: '2.109.0', tag: 'v2.109.0', tagTree: 'f'.repeat(40) };
  const publisher = structuredClone(f.agents[0]);
  publisher.id = 'inline-publisher';
  publisher.taskId = source.id;
  publisher.status = 'running';
  delete publisher.completedAt;
  publisher.metadata.releasePublication = inlinePublication;
  const { taskId: inlineTask } = await ensureReleaseSynchronization(publisher);
  expect(inlineTask).toBe(source.id);
  f.agents = [publisher];
  // The inline synchronization branch is derived from the publication identity.
  f.pr.head.ref = `codex/release-sync-${inlinePublication.identity}`;
  f.pr.merged = false;
  f.pr.state = 'open';
  f.pr.merged_at = null;
  expect((await verifyReleaseSynchronizationTask(inlineTask)).status).toBe('running');
  let entry = await getReleaseSynchronization(inlinePublication.identity);
  expect(entry.obligations.synchronizationPr).toMatchObject({ status: 'pending', blocker: 'synchronization-pr-not-merged',
    evidence: { prUrl: 'https://github.com/example/repo/pull/42' } });
  const next = { id: 'next-release', metadata: { app: 'inline-app', analysisType: 'do-release' } };
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  expect(await verifyInlineReleaseDelivery(publisher)).toMatchObject({ verified: false });

  Object.assign(f.pr, { merged: true, state: 'closed', merged_at: '2026-01-01T01:10:00Z' });
  for (const [change, reason] of [
    [{ developmentVersion: '2.108.0' }, 'releaseAncestry:development-version-behind-publication'],
    [{ developmentVersion: '2.109.0-rc.1' }, 'releaseAncestry:development-version-behind-publication'],
    [{ lockRootVersion: '2.108.0' }, 'releaseAncestry:development-lockfile-version-conflict'],
    [{ versionUnavailable: true }, 'releaseAncestry:development-version-unreadable'],
  ]) {
    Object.assign(f, change);
    expect(await verifyInlineReleaseDelivery(publisher)).toMatchObject({ verified: false, reason });
    f.developmentVersion = f.lockVersion = f.lockRootVersion = '2.109.0';
    f.versionUnavailable = false;
  }
  // An unreadable comparison keeps the same-head merge proof, but cannot be
  // replaced by a version read.
  f.versionReads = [];
  f.compareUnavailable = true;
  expect(await verifyInlineReleaseDelivery(publisher)).toMatchObject({ verified: false });
  entry = await getReleaseSynchronization(inlinePublication.identity);
  expect(entry.obligations.synchronizationPr.status).toBe('verified');
  expect(entry.obligations.releaseAncestry).toMatchObject({ status: 'blocked', blocker: 'evidence-unavailable' });
  expect(f.versionReads).toEqual([]);
  f.compareUnavailable = false;
  f.pr.base.ref = 'release';
  expect(await verifyInlineReleaseDelivery(publisher)).toMatchObject({ verified: false, reason: 'synchronization-pr-identity-changed' });
  f.pr.base.ref = 'main';

  // A newer development version is preserved; a project without a published lock keeps its contract.
  f.developmentVersion = f.lockVersion = f.lockRootVersion = '2.110.0';
  f.hasLock = false;
  expect(await verifyInlineReleaseDelivery(publisher)).toEqual({ verified: true });
  expect(f.versionReads).toContain(`contents/package.json?ref=${'e'.repeat(40)}`);
  entry = await getReleaseSynchronization(inlinePublication.identity);
  expect(entry.synchronization).toMatchObject({ status: 'verified', blocker: null });
  expect(Object.keys(entry.obligations)).toEqual(RELEASE_SYNC_OBLIGATIONS);
  expect(entry.obligations.releaseAncestry.evidence).toMatchObject({ developmentVersion: '2.110.0', publishedVersion: '2.109.0', lockBlob: null });
  await expect(verifyIndependentReleaseDelivery(inlinePublication.identity, 42)).rejects.toThrow('historical continuations');
  // Neither a quality snapshot nor checkout retirement holds the next release.
  expect(await releaseTaskDispatchDisposition(next)).toBeNull();
});

it('chooses the merged attempt beside a closed one and refuses two merged candidates', async () => {
  const closed = { ...structuredClone(f.pr), number: 41, merged: false, merged_at: null, merge_commit_sha: null, head: { ...f.pr.head, sha: '7'.repeat(40) } };
  const unrelated = { ...structuredClone(f.pr), number: 40, head: { ...f.pr.head, ref: 'unrelated' } };
  const intoRelease = { ...structuredClone(f.pr), number: 39, base: { ...f.pr.base, ref: 'release' } };
  f.agents[1].status = 'completed';
  f.agents[1].completedAt = '2026-01-01T01:12:00Z';
  f.prs = [closed, unrelated, intoRelease, f.pr];
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
  expect((await getReleaseSynchronization(identity)).obligations.synchronizationPr.evidence).toMatchObject({ number: 42, headSha: f.pr.head.sha });

  const other = { ...structuredClone(f.pr), number: 43 };
  const second = (await import('node:crypto')).randomBytes(32).toString('hex');
  const source = await addTask({ description: `Release example ${second}`, app: 'example-app' });
  const { taskId: secondTask } = await ensureReleaseSynchronization({ ...f.agents[0], id: `publisher-${second}`, taskId: source.id,
    metadata: { ...f.agents[0].metadata, releasePublication: { ...publication, identity: second, tag: `v1.2.4-${second}` } } });
  f.agents.push({ ...f.agents[1], id: `sync-${second}`, taskId: secondTask });
  f.prs = [f.pr, other];
  expect(await verifyReleaseSynchronizationTask(secondTask)).toMatchObject({ status: 'blocked', blocker: 'synchronization-pr-conflict' });
});

it('upgrades a pre-#16017 outbox blocked on removed obligations to the back-merge invariants', async () => {
  f.agents[1].status = 'completed';
  f.agents[1].completedAt = '2026-01-01T01:12:00Z';
  const entry = await getReleaseSynchronization(identity);
  const legacy = ['candidateFixes', 'releaseAncestry', 'synchronizationPr', 'localReview', 'hostedReview', 'requiredCi',
    'mergeAdmission', 'qualitySnapshot', 'processSettlement', 'retirement'];
  entry.obligations = Object.fromEntries(legacy.map(name => [name, { status: 'verified', verifiedAt: '2026-01-01T01:11:00Z',
    evidence: { prUrl: 'https://github.com/example/repo/pull/42', headSha: f.pr.head.sha } }]));
  entry.obligations.qualitySnapshot = { status: 'blocked', blocker: 'development-quality-snapshot-pending' };
  entry.obligations.retirement = { status: 'pending', evidence: { checkouts: [], heldCheckouts: [] } };
  entry.synchronization = { status: 'blocked', attempts: 3, checkedAt: '2026-01-01T01:11:00Z', verifiedAt: null,
    retryAt: '2026-01-01T01:12:00Z', blocker: 'qualitySnapshot:development-quality-snapshot-pending' };
  await saveReleaseSynchronization(entry);
  const next = { id: 'next', metadata: { app: 'example-app', analysisType: 'do-release' } };
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  await recoverReleaseSynchronizationHandoffs(f.agents);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.synchronization).toMatchObject({ status: 'verified', attempts: 4, blocker: null });
  expect(Object.keys(saved.obligations)).toEqual(RELEASE_SYNC_OBLIGATIONS);
  expect(saved.publication).toEqual(publication);
  // The removed quality snapshot no longer serializes the next release.
  expect(await releaseTaskDispatchDisposition(next)).toBeNull();
});

it('recognizes a merged replacement PR without changing the failed historical task', async () => {
  const source = await addTask({ description: 'Historical release with independent repair', app: 'repaired-app' });
  const repairedPublication = { ...publication, identity: (await import('node:crypto')).randomBytes(32).toString('hex'),
    version: '2.109.0', tag: 'v2.109.0', tagTree: 'f'.repeat(40) };
  const publisher = structuredClone(f.agents[0]);
  publisher.taskId = source.id;
  publisher.metadata.releasePublication = repairedPublication;
  const { taskId: oldTask } = await ensureReleaseSynchronization(publisher);
  const continuation = structuredClone(f.agents[1]);
  continuation.taskId = oldTask;
  continuation.status = 'completed';
  continuation.completedAt = '2026-01-01T01:12:00Z';
  f.agents = [publisher, continuation];
  f.pr.head.ref = 'codex/separate-repair';
  expect((await verifyReleaseSynchronizationTask(oldTask)).blocker).toBe('synchronization-pr-pending');
  const before = await getReleaseSynchronization(repairedPublication.identity);
  f.pr.merged = false;
  await expect(verifyIndependentReleaseDelivery(repairedPublication.identity, 42)).rejects.toThrow('delivery-pr-unverified');
  f.pr.merged = true;
  f.ancestor = false;
  await expect(verifyIndependentReleaseDelivery(repairedPublication.identity, 42)).rejects.toThrow('delivery-ancestry-unverified');
  f.ancestor = true;
  f.lockRootVersion = '2.108.0';
  await expect(verifyIndependentReleaseDelivery(repairedPublication.identity, 42)).rejects.toThrow('development-lockfile-version-conflict');
  f.lockRootVersion = '2.109.0';
  continuation.status = 'running';
  await expect(verifyIndependentReleaseDelivery(repairedPublication.identity, 42)).rejects.toThrow('still active');
  expect((await getReleaseSynchronization(repairedPublication.identity)).synchronization).toEqual(before.synchronization);
  continuation.status = 'completed';
  const events = [];
  const onTask = event => events.push(event);
  cosEvents.on('tasks:changed', onTask);
  let proof;
  try { proof = await verifyIndependentReleaseDelivery(repairedPublication.identity, 42); }
  finally { cosEvents.off('tasks:changed', onTask); }
  expect(events.length).toBeGreaterThan(0);
  expect(events.every(event => event.suppressCompletionWake === true && event.suppressDequeue === true)).toBe(true);
  expect(proof).toMatchObject({ status: 'verified', number: 42, base: 'main', publishedVersion: '2.109.0', developmentVersion: '2.109.0' });
  let saved = await getReleaseSynchronization(repairedPublication.identity);
  const { delivery, ...originalVerdict } = saved.synchronization;
  expect(delivery).toEqual(proof);
  expect(originalVerdict).toEqual(before.synchronization);
  expect(saved.obligations).toEqual(before.obligations);
  const next = { id: 'next-release', metadata: { app: 'repaired-app', analysisType: 'do-release' } };
  expect(await releaseTaskDispatchDisposition(next)).toBeNull();
  expect(await releaseTaskDispatchDisposition(saved.task)).toBe('delivered-continuation');
  const blocked = { id: oldTask, status: 'blocked', metadata: { app: 'repaired-app', analysisType: 'release-sync' } };
  expect(await deliveredReleaseTaskIds([blocked])).toEqual(new Set([oldTask]));

  const observations = await observeReleaseDeliveries(next);
  f.agents.push({ id: 'new-continuation', taskId: oldTask, startedAt: '2026-01-01T01:20:00Z', completedAt: '2026-01-01T01:21:00Z',
    status: 'completed', metadata: { useRunner: true } });
  expect(await releaseTaskDispatchDisposition(next, { deliveryObservations: observations })).toBe('wait-for-synchronization');
  f.agents.pop();
  markAgentDispatching('next-dispatch');
  try {
    expect(await releaseTaskDispatchDisposition(next, { deliveryObservations: observations })).toBe('wait-for-synchronization');
    expect(await releaseTaskDispatchDisposition(next, { ignoreAgentId: 'next-dispatch', deliveryObservations: observations })).toBeNull();
  } finally { clearAgentDispatching('next-dispatch'); }

  continuation.status = 'running';
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  expect(await deliveredReleaseTaskIds([blocked])).toEqual(new Set());
  continuation.status = 'completed';
  f.agents.push({ id: 'other-release', taskId: 'another-task', status: 'running',
    metadata: { taskAnalysisType: 'do-release', taskApp: 'repaired-app' } });
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.agents.pop();
  f.agents.push({ id: 'other-runner', taskId: 'other-task', startedAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:01:00Z',
    status: 'completed', metadata: { taskAnalysisType: 'do-release', taskApp: 'repaired-app', useRunner: true } });
  f.runner = [{ id: 'other-runner', liveness: 'pty', processActive: true }];
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.liveAgents = [publisher, continuation];
  setUseRunner(false);
  try { expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization'); }
  finally { setUseRunner(false); f.liveAgents = null; }
  f.runner = [];
  f.agents.pop();
  f.agents.push({ id: 'unrelated-runner', taskId: 'other-task', startedAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:01:00Z',
    status: 'completed', metadata: { taskAnalysisType: 'do-release', taskApp: 'other-app', sourceWorkspace: '/example/other-repo', useRunner: true } });
  f.liveAgents = [publisher, continuation];
  f.runner = null;
  expect(await releaseTaskDispatchDisposition(next)).toBeNull();
  f.agents.pop();
  f.liveAgents = null;
  f.runner = [];
  f.agents.push({ id: 'missing-old-runner', taskId: 'missing-task', startedAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:01:00Z',
    status: 'completed', metadata: { taskAnalysisType: 'do-release', taskApp: 'other-app', sourceWorkspace: '/missing/old-repo', useRunner: true } });
  f.liveAgents = [publisher, continuation];
  expect(await releaseTaskDispatchDisposition(next)).toBeNull();
  f.runner = null;
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.agents.pop();
  f.liveAgents = null;
  f.runner = [];
  continuation.pid = process.pid;
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  delete continuation.pid;
  f.liveTrusted = false;
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.liveTrusted = true;
  f.developmentVersion = '2.108.0';
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.developmentVersion = '2.109.0';
  f.compareUnavailable = true;
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.compareUnavailable = false;
  f.liveAgents = [];
  continuation.metadata.useRunner = true;
  f.runner = null;
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.runner = [{ id: continuation.id, liveness: 'pty', processActive: true }];
  expect(await releaseTaskDispatchDisposition(next)).toBe('wait-for-synchronization');
  f.runner = [];
  expect(await releaseTaskDispatchDisposition(next)).toBeNull();
  delete continuation.metadata.useRunner;
  f.liveAgents = null;
  const callsBeforeReplay = f.forgeCalls;
  await verifyReleaseSynchronizationTask(oldTask);
  expect(f.forgeCalls).toBe(callsBeforeReplay);
  saved = await getReleaseSynchronization(repairedPublication.identity);
  expect(saved.synchronization).toMatchObject({ status: 'blocked', blocker: 'synchronization-pr-pending', delivery: proof });
});

it('persists revision-bound proof and rejoins the same completed task after restart', async () => {
  const events = [];
  const listener = change => events.push(change);
  cosEvents.on('tasks:changed', listener);
  try {
    Object.assign(f.pr, { merged: false, state: 'open', merged_at: null });
    await Promise.all([verifyReleaseSynchronizationTask(taskId), verifyReleaseSynchronizationTask(taskId)]);
    let saved = await getReleaseSynchronization(identity);
    expect(saved.synchronization).toMatchObject({ status: 'running', attempts: 2, blocker: null });
    Object.assign(f.pr, { merged: true, state: 'closed', merged_at: '2026-01-01T01:10:00Z' });
    await updateTask(taskId, { status: 'completed' }, 'internal');
    await verifyReleaseSynchronizationTask(taskId);
    saved = await getReleaseSynchronization(identity);
    expect(saved.synchronization.status).toBe('verified');
    expect(saved.publication).toEqual(publication);
    expect(saved.obligations.synchronizationPr.evidence).toMatchObject({ number: 42, mergeSha: f.pr.merge_commit_sha, developmentHead: f.developmentHead });
    expect((await ensureReleaseSynchronization(f.agents[0])).taskId).toBe(taskId);
    expect(await getTaskById(taskId)).toMatchObject({ status: 'completed' });
    const calls = f.forgeCalls;
    expect(await verifyReleaseSynchronizationTask(taskId)).toEqual(saved.synchronization);
    expect(f.forgeCalls).toBe(calls);
    expect(events.filter(change => change.action === 'release-synchronization')).toHaveLength(3);
  } finally { cosEvents.off('tasks:changed', listener); }
});

it('retains successful proof and backoff on transport failure', async () => {
  f.notAncestor = new Set([publication.promotionMerge]);
  await verifyReleaseSynchronizationTask(taskId);
  let saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.releaseAncestry).toMatchObject({ status: 'blocked', blocker: 'published-ancestry-not-on-development' });
  const mergedAt = saved.obligations.synchronizationPr.verifiedAt;
  expect(mergedAt).toEqual(expect.any(String));
  f.unavailable = true;
  await verifyReleaseSynchronizationTask(taskId);
  saved = await getReleaseSynchronization(identity);
  expect(saved.synchronization).toMatchObject({ status: 'blocked', blocker: 'synchronization-evidence-unavailable' });
  expect(Date.parse(saved.synchronization.retryAt)).toBeGreaterThan(Date.parse(saved.synchronization.checkedAt));
  expect(saved.obligations.synchronizationPr.verifiedAt).toBe(mergedAt);
  f.unavailable = false;
  f.notAncestor = new Set();
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
  expect((await getReleaseSynchronization(identity)).obligations.synchronizationPr.verifiedAt).toBe(mergedAt);
});

it('never waives missing candidate ancestry and refuses conflicting live continuation owners', async () => {
  f.agents.push({ ...f.agents[1], id: 'other-owner' });
  expect(await verifyReleaseSynchronizationTask(taskId)).toMatchObject({ status: 'blocked', blocker: 'continuation-conflicting-live-owners' });
  f.agents.pop();
  f.notAncestor = new Set([publication.candidateHead]);
  await verifyReleaseSynchronizationTask(taskId);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.synchronizationPr.status).toBe('verified');
  expect(saved.obligations.releaseAncestry.blocker).toBe('candidate-head-not-on-development');
  expect(saved.synchronization.status).toBe('blocked');
  expect((await getTaskById(taskId)).metadata.releaseSynchronization.identity).toBe(identity);
});

it('leaves an unstarted continuation pending and respects durable retry times during recovery sweeps', async () => {
  f.agents = [f.agents[0]];
  await verifyReleaseSynchronizationTask(taskId);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.synchronization.status).toBe('pending');
  await recoverReleaseSynchronizationHandoffs(f.agents);
  expect((await getReleaseSynchronization(identity)).synchronization.attempts).toBe(saved.synchronization.attempts);
});

it('does not publish verification or lose original evidence when its durable write fails', async () => {
  Object.assign(f.pr, { merged: false, state: 'open', merged_at: null });
  await verifyReleaseSynchronizationTask(taskId);
  Object.assign(f.pr, { merged: true, state: 'closed', merged_at: '2026-01-01T01:10:00Z' });
  const prior = await getReleaseSynchronization(identity);
  f.failSave = true;
  await expect(verifyReleaseSynchronizationTask(taskId)).rejects.toThrow('synthetic outbox write failure');
  expect(await getReleaseSynchronization(identity)).toEqual(prior);
  f.failSave = false;
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
});
