import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit, assertGitWorkSettled } from '../lib/execGit.js';
import { ownTestBodies, lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { withCheckoutPublication, reserveCheckoutRetirement, releaseCheckoutReservation } from '../lib/checkoutRetirementAdmission.js';

const fixture = vi.hoisted(() => ({ state: null, disk: null, queue: null, unreadable: false,
  processHold: null, processGate: null, nativeProof: false, pr: null, repo: null, saves: 0, forgeReads: 0, forgeHook: null }));
vi.mock('../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: lazyTempDataRoot('candidate-recovery-data-') }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: () => [] }));
vi.mock('./shell.js', () => ({ listAllSessions: () => [] }));
vi.mock('./cosRunnerClient.js', () => ({ getActiveAgentsFromRunner: async () => [] }));
vi.mock('./cosState.js', () => ({
  loadState: async () => structuredClone(fixture.state),
  readAgentsStateForSafetyCheck: async () => ({ trusted: !fixture.unreadable, agents: fixture.state.agents }),
  withStateLock: work => fixture.queue(work),
  saveState: async state => { fixture.saves++; fixture.disk = structuredClone(state); fixture.state = structuredClone(state); },
}));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async () => ({ id: 'release-task', metadata: { resumedFromAgentId: 'agent-original' } }) }));
// The supervised native receipt is tested by windowsAgentProcess.test.js.
// Git, filesystem identity and durable retirement admission remain real here.
vi.mock('./releaseCandidateSettlement.js', async original => {
  const actual = await original();
  return { readReleaseCandidateSettlement: async agent => {
    if (fixture.nativeProof) return actual.readReleaseCandidateSettlement(agent);
    await fixture.processGate?.();
    if (fixture.processHold) throw new Error(fixture.processHold);
    return { owner: { agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt }, active: 0, settledAt: agent.completedAt };
  } };
});
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ isGithub: true, host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async cwd => ({ cwd, env: {} }) }));
vi.mock('./github.js', () => ({ execGh: async args => {
  fixture.forgeReads++;
  await fixture.forgeHook?.();
  const query = args.at(-1);
  if (query.includes('/pulls?')) return JSON.stringify(fixture.pr ? [fixture.pr] : []);
  if (query.endsWith('/pulls/12')) return JSON.stringify(fixture.pr);
    if (query.endsWith('/git/ref/heads/release')) return JSON.stringify({ ref: 'refs/heads/release', object: { type: 'commit', sha: fixture.releaseBase } });
  if (query.includes('/git/commits/')) return JSON.stringify(fixture.promotion);
  throw new Error('Unexpected synthetic forge query');
} }));

import { updateReleaseCandidateOwnership } from './cosClaimOwnership.js';
import { recoverReleaseCandidate } from './releaseCandidateRecovery.js';
import { captureCheckoutSeeds, captureCompletedCheckouts } from './completedCheckoutEvidence.js';
import { isInlineReleaseOwner } from '../lib/releaseSynchronization.js';
import { readClaimOwnershipAgents, withClaimOwnershipLock, reserveCheckoutRetirementFence } from './cosClaimOwnershipState.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';

const bodies = ownTestBodies(it);
const test = bodies.it;
const branch = 'codex/release-agent-original';
const git = async (args, cwd = fixture.repo) => (await execGit(args, cwd)).stdout.trim();
let scratch, checkout, cutoff, head, reviewPath, original;
const recover = () => recoverReleaseCandidate('agent-successor', 'agent-original');

beforeEach(async () => {
  fixture.queue = createFileWriteQueue();
  fixture.unreadable = false;
  fixture.nativeProof = false;
  fixture.processHold = fixture.processGate = fixture.pr = fixture.forgeHook = null;
  fixture.saves = fixture.forgeReads = 0;
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'candidate-recovery-')));
  fixture.repo = join(scratch, 'repo'); checkout = join(scratch, 'candidate');
  await materializeGitRepo(fixture.repo);
  await git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await writeFile(join(fixture.repo, 'package.json'), '{"version":"1.2.3"}\n');
  await git(['add', 'package.json']); await git(['commit', '-m', 'prepared fixture']);
  cutoff = await git(['rev-parse', 'HEAD']);
  fixture.releaseBase = cutoff;
  const startedAt = new Date(Date.now() - 10_000).toISOString();
  fixture.state = { agents: { 'agent-original': { id: 'agent-original', taskId: 'release-task', startedAt, status: 'running',
    metadata: { taskAnalysisType: 'do-release', isWorktree: false, workspacePath: fixture.repo, instanceId: 'example-instance' } } } };
  expect(await updateReleaseCandidateOwnership('agent-original', 'reserve')).toEqual({ reserved: true, branch });
  await git(['worktree', 'add', '-b', branch, checkout, cutoff]);
  expect(await updateReleaseCandidateOwnership('agent-original', 'capture')).toEqual({ captured: true, branch });
  await git(['worktree', 'lock', checkout]);
  await git(['commit', '--allow-empty', '-m', `chore: pin release candidate\n\nRelease-Cut: ${cutoff}\nRelease-Base: ${cutoff}\nRelease-Previous-Tag: v1.2.2\nRelease-Previous-Commit: ${cutoff}`], checkout);
  head = await git(['rev-parse', 'HEAD'], checkout);
  reviewPath = await git(['rev-parse', '--path-format=absolute', '--git-path', 'portos-local-review-lifecycle'], checkout);
  await writeFile(reviewPath, JSON.stringify({ version: 2, branch, origin: 'https://github.com/example/repo.git',
    base: 'release', status: 'partial', completedHead: head, reviewedHead: cutoff, inspectionProvenance: 'recorded', prUrl: '' }));
  await writeFile(join(checkout, 'retained.txt'), 'Uncommitted work survives recovery.');
  const source = fixture.state.agents['agent-original'];
  const rows = await captureCompletedCheckouts(source, { success: true, strict: true });
  source.metadata.completedCheckouts = rows;
  source.metadata.checkoutCapture = { status: 'captured', targets: rows, unknown: false };
  source.status = 'completed'; source.completedAt = new Date().toISOString();
  source.result = { success: false, resumed: true, resumedTaskId: 'release-task' };
  fixture.state.agents['agent-successor'] = { id: 'agent-successor', taskId: 'release-task', status: 'running',
    startedAt: new Date().toISOString(), metadata: { taskAnalysisType: 'do-release', isWorktree: false,
      workspacePath: fixture.repo, instanceId: 'example-instance', resumedFromAgentId: 'agent-original' } };
  original = structuredClone(source);
  fixture.disk = structuredClone(fixture.state);
});

afterEach(async () => {
  await bodies.drain();
  assertGitWorkSettled(scratch);
  await rm(scratch, { recursive: true, force: true });
});
afterAll(cleanupTempDataRoots);

test('does not treat an unreserved service lifecycle as proof that Git created no candidate', async () => {
  const source = fixture.state.agents['agent-original'];
  delete source.metadata.releaseCandidate;
  delete source.metadata.checkoutSeeds;
  delete source.metadata.completedCheckouts;
  delete source.metadata.checkoutCapture;
  source.metadata.releaseCandidateLifecycle = { version: 1, agentId: source.id, taskId: source.taskId,
    startedAt: source.startedAt, stage: 'registered' };
  expect(await git(['rev-parse', '--verify', `refs/heads/${branch}`])).toBe(head);
  expect(await updateReleaseCandidateOwnership('agent-successor', 'reserve'))
    .toEqual({ reserved: false, reason: 'candidate-recovery-required' });
  expect(fixture.state.agents['agent-successor'].metadata.releaseCandidate).toBeUndefined();
});

test('transfers the seeded generation once across interruption/restart, retaining original receipts and private review bytes', async () => {
  const review = await readFile(reviewPath, 'utf8');
  const first = await recover();
  expect(first).toMatchObject({ recovered: true, branch, transfer: { source: { agentId: 'agent-original' },
    candidate: { cutoff, releaseBase: cutoff, version: '1.2.3' }, review: { legacyPublished: false } } });
  const current = fixture.state.agents['agent-original'];
  expect({ ...current, metadata: { ...current.metadata, releaseCandidateSuccessor: undefined } })
    .toEqual({ ...original, metadata: { ...original.metadata, releaseCandidateSuccessor: undefined } });
  const seed = fixture.state.agents['agent-successor'].metadata.checkoutSeeds[0];
  expect(seed.agentId).toBe('agent-successor');
  expect(seed.incarnation).toEqual(original.metadata.checkoutSeeds[0].incarnation);
  expect(seed.seededAt >= fixture.state.agents['agent-successor'].startedAt).toBe(true);
  fixture.state = structuredClone(fixture.disk);
  const saves = fixture.saves;
  expect(await recover()).toEqual(first);
  expect(fixture.saves).toBe(saves);
  expect(await readClaimOwnershipAgents()).toHaveLength(2);
  expect(claimCheckoutOwnerReason({ agents: await readClaimOwnershipAgents(), branchName: branch,
    holderPath: checkout, sourceWorkspace: fixture.repo })).toBe('claim-owner-active');
  expect(await updateReleaseCandidateOwnership('agent-successor', 'reserve')).toMatchObject({ reserved: false, reason: 'candidate-recovery-required' });
  expect(await readFile(reviewPath, 'utf8')).toBe(review);
  expect(await readFile(join(checkout, 'retained.txt'), 'utf8')).toBe('Uncommitted work survives recovery.');
});

test('retains legacy unknown inspection and current unavailable inspection without upgrading either receipt', async () => {
  for (const receipt of [
    { version: 1, reviewedHead: head },
    { version: 2, completedHead: head, reviewedHead: null, inspectionProvenance: 'unavailable' },
  ]) {
    const bytes = JSON.stringify({ branch, origin: 'https://github.com/example/repo.git', base: 'release',
      status: 'partial', prUrl: '', ...receipt });
    await writeFile(reviewPath, bytes);
    expect(await recover()).toMatchObject({ recovered: true });
    expect(await readFile(reviewPath, 'utf8')).toBe(bytes);
  }
});

test('refuses a v2 inspection outside its completion ancestry without changing private evidence', async () => {
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  // Both commits are in the candidate history, but inspection cannot postdate
  // the phase completion it purports to describe.
  const bytes = JSON.stringify({ ...review, completedHead: cutoff, reviewedHead: head });
  await writeFile(reviewPath, bytes);
  expect(await recover()).toMatchObject({ recovered: false, reason: 'candidate-reviewed-head-conflict' });
  expect(await readFile(reviewPath, 'utf8')).toBe(bytes);
  expect(fixture.state.agents['agent-original'].metadata.releaseCandidateSuccessor).toBeUndefined();
});

test('accepts only an independently captured contemporaneous unseeded generation and does not backfill its seed', async () => {
  delete fixture.state.agents['agent-original'].metadata.checkoutSeeds;
  delete fixture.state.agents['agent-original'].metadata.releaseCandidate;
  expect(await recover()).toMatchObject({ recovered: true, transfer: { lineage: { kind: 'contemporaneous-receipt' } } });
  expect(fixture.state.agents['agent-original'].metadata.checkoutSeeds).toBeUndefined();
  expect(fixture.state.agents['agent-original'].metadata.completedCheckouts).toEqual(original.metadata.completedCheckouts);
});

test('recovers an already-merged promotion at its original head without republishing or resetting the published review lifecycle', async () => {
  fixture.pr = { number: 12, html_url: 'https://github.com/example/repo/pull/12', state: 'closed', merged: true,
    merge_commit_sha: 'a'.repeat(40), head: { ref: branch, sha: head, repo: { full_name: 'example/repo' } },
    base: { ref: 'release', sha: cutoff, repo: { full_name: 'example/repo' } } };
  fixture.promotion = { tree: { sha: await git(['rev-parse', `${head}^{tree}`]) }, parents: [{ sha: cutoff }, { sha: head }] };
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  review.prUrl = fixture.pr.html_url;
  await writeFile(reviewPath, JSON.stringify(review));
  expect(await recover()).toMatchObject({ recovered: true, transfer: { publication: { number: 12, head, merged: true } } });
  expect(JSON.parse(await readFile(reviewPath, 'utf8'))).toEqual(review);
  expect(fixture.state.agents['agent-successor'].metadata.releasePublication).toBeUndefined();
});

for (const mode of ['resume', 'retry']) test(`recovers both checkouts of an interrupted inline release on the same task (${mode})`, async () => {
  fixture.pr = { number: 12, html_url: 'https://github.com/example/repo/pull/12', state: 'closed', merged: true,
    merge_commit_sha: 'a'.repeat(40), head: { ref: branch, sha: head, repo: { full_name: 'example/repo' } },
    base: { ref: 'release', sha: cutoff, repo: { full_name: 'example/repo' } } };
  fixture.promotion = { tree: { sha: await git(['rev-parse', `${head}^{tree}`]) }, parents: [{ sha: cutoff }, { sha: head }] };
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  review.prUrl = fixture.pr.html_url;
  await writeFile(reviewPath, JSON.stringify(review));
  const source = fixture.state.agents['agent-original'], identity = 'b'.repeat(64);
  const syncBranch = `codex/release-sync-${identity}`, syncPath = join(scratch, 'synchronization');
  await git(['worktree', 'add', '-b', syncBranch, syncPath, head]);
  source.status = 'running';
  source.metadata.releasePublication = { status: 'verified', synchronizationHandoffVersion: 2, identity,
    candidateBranch: branch, candidateHead: head, promotionPrNumber: 12, promotionMerge: 'a'.repeat(40) };
  source.metadata.releaseSynchronizationCheckout = { version: 1, identity, branch: syncBranch,
    startedAt: source.startedAt, reservedAt: source.startedAt };
  source.metadata.checkoutSeeds = await captureCheckoutSeeds(source, { allowUncreated: false });
  const rows = await captureCompletedCheckouts(source, { success: true, strict: true });
  source.metadata.completedCheckouts = rows;
  source.metadata.checkoutCapture = { status: 'captured', targets: rows, unknown: false };
  source.status = 'completed'; source.completedAt = new Date().toISOString();
  if (mode === 'retry') source.result = { success: false, deliveryRecoveryOwned: true,
    taskOutcome: { status: 'incomplete', reason: 'Interrupted after publication' } };
  fixture.state.agents['agent-successor'].startedAt = new Date().toISOString();
  const result = await recover();
  expect(result).toMatchObject({ recovered: true, branch, synchronization: { branch: syncBranch, path: syncPath } });
  const successor = fixture.state.agents['agent-successor'];
  expect(successor.metadata.checkoutSeeds.map(seed => seed.branch)).toEqual([branch, syncBranch]);
  expect(successor.metadata.releasePublication).toEqual(source.metadata.releasePublication);
  expect(isInlineReleaseOwner({ version: 2, owner: { agentId: source.id, taskId: source.taskId, startedAt: source.startedAt } }, successor)).toBe(true);
  expect(await recover()).toEqual(result);
});

for (const [name, reason, change] of [
  ['active original', 'candidate-successor-lineage-unverified', source => { source.status = 'running'; }],
  ['missing terminal head receipt', 'candidate-terminal-receipt-unverified', source => { delete source.metadata.checkoutCapture; }],
  ['unseeded without contemporaneous proof', 'candidate-contemporaneous-lineage-missing', source => { delete source.metadata.checkoutSeeds; delete source.metadata.completedCheckouts; }],
  ['unseeded conflicting generation', 'candidate-generation-changed', source => { delete source.metadata.checkoutSeeds; source.metadata.completedCheckouts[0].incarnation.pointer.ino = '999999'; }],
  ['unsettled detached processes', 'candidate-processes-active', () => { fixture.processHold = 'candidate-processes-active'; }],
  ['absent PID without whole-tree proof', 'candidate-process-proof-unavailable', source => { source.pid = 999999; fixture.processHold = 'candidate-process-proof-unavailable'; }],
  ['unreadable registry', 'ownership-unreadable', () => { fixture.unreadable = true; }],
  ['prepared version changed', 'candidate-prepared-version-conflict', async () => { await writeFile(join(checkout, 'package.json'), '{"version":"1.2.4"}'); }],
  ['release target moved', 'candidate-release-base-changed', () => { fixture.releaseBase = 'f'.repeat(40); }],
  ['unknown review receipt version', 'candidate-review-identity-conflict', async () => {
    const receipt = JSON.parse(await readFile(reviewPath, 'utf8'));
    await writeFile(reviewPath, JSON.stringify({ ...receipt, version: 3 }));
  }],
  ['ambiguous release owner', 'candidate-owner-ambiguous', () => {
    fixture.state.agents['agent-other'] = { ...structuredClone(fixture.state.agents['agent-successor']), id: 'agent-other',
      metadata: { ...fixture.state.agents['agent-successor'].metadata, resumedFromAgentId: undefined } };
  }],
]) test(`holds ${name} without transferring, deleting or recutting`, async () => {
  await change(fixture.state.agents['agent-original']);
  const source = structuredClone(fixture.state.agents['agent-original']);
  expect(await recover()).toMatchObject({ recovered: false, reason });
  expect(fixture.state.agents['agent-original']).toEqual(source);
  expect(fixture.state.agents['agent-successor'].metadata.checkoutSeeds).toBeUndefined();
  expect(await git(['rev-parse', 'HEAD'], checkout)).toBe(head);
  expect(await readFile(join(checkout, 'retained.txt'), 'utf8')).toContain('survives');
});

describe.skipIf(process.platform === 'win32')('POSIX recovery proof', () => {
  test('holds at the service boundary despite terminal registry state and an absent parent PID', async () => {
    fixture.nativeProof = true;
    fixture.state.agents['agent-original'].pid = 999999;
    expect(await recover()).toMatchObject({ recovered: false, reason: 'candidate-process-proof-unavailable' });
    expect(fixture.state.agents['agent-successor'].metadata.releaseCandidateRecovery).toMatchObject({ status: 'held', nextStep: expect.stringContaining('Preserve') });
  });
});

describe.skipIf(process.platform !== 'win32')('native Windows release recovery', () => {
  test('transfers through the service after the registered supervisor proves process-tree settlement', async () => {
    const { reserveWindowsAgentProcess, prepareWindowsAgentLaunch, watchWindowsAgentProcess } = await import('../lib/windowsAgentProcess.js');
    const { spawn } = await import('../lib/childProcess.js');
    const source = fixture.state.agents['agent-original'];
    source.status = 'running';
    await reserveWindowsAgentProcess(source);
    const launch = prepareWindowsAgentLaunch(source.id, process.execPath, ['-e', 'process.stdout.write("settled")'], { cwd: checkout, env: process.env });
    const child = watchWindowsAgentProcess(spawn(launch.command, launch.args, { cwd: checkout, stdio: 'pipe' }), launch);
    const closed = once(child, 'close');
    try {
      expect((await closed)[0]).toBe(0);
      source.status = 'completed'; source.completedAt = new Date().toISOString();
      fixture.state.agents['agent-successor'].startedAt = new Date().toISOString();
      fixture.nativeProof = true;
      expect(await recover()).toMatchObject({ recovered: true, transfer: { settlement: { active: 0, owner: { agentId: source.id } } } });
    } finally { child.kill(); await closed; }
  }, 30000);
});

test('rejects a reused Git pointer and a changed head even when the branch name is unchanged', async () => {
  const pointer = join(checkout, '.git');
  const bytes = await readFile(pointer);
  await rename(pointer, join(scratch, 'old-pointer'));
  await writeFile(pointer, bytes);
  expect(await recover()).toMatchObject({ recovered: false, reason: 'candidate-terminal-receipt-unverified' });
  await rm(pointer); await rename(join(scratch, 'old-pointer'), pointer);
  await git(['commit', '--allow-empty', '-m', 'unrecorded later work'], checkout);
  expect(await recover()).toMatchObject({ recovered: false, reason: 'candidate-terminal-receipt-unverified' });
});

test('shares the cleanup fence and durable retirement cut, and drains a pending transfer before retirement', async () => {
  const release = await withClaimOwnershipLock(() => reserveCheckoutRetirementFence({ repoPath: fixture.repo, path: checkout, branch }));
  expect(await recover()).toMatchObject({ recovered: false, reason: 'checkout-retirement-reserved' });
  await withClaimOwnershipLock(release);
  const cut = await reserveCheckoutRetirement(fixture.repo, 'synthetic-retirement');
  expect(await recover()).toMatchObject({ recovered: false, reason: 'checkout-retirement-reserved' });
  await releaseCheckoutReservation(cut);
  let resume, entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  fixture.processGate = async () => { entered(); await gate; };
  const pending = recover();
  await waiting;
  await expect(reserveCheckoutRetirement(fixture.repo, 'competing-retirement')).rejects.toMatchObject({ code: 'CHECKOUT_RETIREMENT_RESERVED' });
  resume();
  expect(await pending).toMatchObject({ recovered: true });
  await withCheckoutPublication(fixture.repo, async () => {
    expect(claimCheckoutOwnerReason({ agents: await readClaimOwnershipAgents(), branchName: branch,
      holderPath: checkout, sourceWorkspace: fixture.repo })).toBe('claim-owner-active');
  });
});

test('serializes same-successor retries and refuses review drift during verification', async () => {
  let resume, entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  fixture.processGate = async () => { entered(); await gate; };
  const first = recover();
  await waiting;
  const second = recover();
  resume();
  const results = await Promise.all([first, second]);
  fixture.processGate = null;
  expect(results[0]).toMatchObject({ recovered: true });
  expect(results[1]).toEqual(results[0]);
  // A later retry preserves the completed transfer when private evidence drifts.
  const saved = structuredClone(fixture.disk);
  fixture.forgeReads = 0;
  fixture.forgeHook = async () => {
    if (fixture.forgeReads === 3) await writeFile(reviewPath, JSON.stringify({ ...JSON.parse(await readFile(reviewPath, 'utf8')), status: 'clean' }));
  };
  expect(await recover()).toMatchObject({ recovered: false, reason: 'candidate-evidence-changed' });
  expect(fixture.state).toEqual(saved);
});

test('refuses competing active successors and cannot replace an already recorded successor', async () => {
  const competitor = { ...structuredClone(fixture.state.agents['agent-successor']), id: 'agent-competitor' };
  fixture.state.agents[competitor.id] = competitor;
  expect(await recover()).toMatchObject({ recovered: false, reason: 'candidate-owner-ambiguous' });
  expect(await recoverReleaseCandidate(competitor.id, 'agent-original')).toMatchObject({ recovered: false, reason: 'candidate-owner-ambiguous' });
  expect(fixture.state.agents['agent-original'].metadata.releaseCandidateSuccessor).toBeUndefined();
  // The competitor ends without acquiring the checkout. Only then can the
  // documented successor acquire it; a subsequent competing request cannot.
  fixture.state.agents[competitor.id].status = 'completed';
  expect(await recover()).toMatchObject({ recovered: true });
  fixture.state.agents[competitor.id].status = 'running';
  expect(await recoverReleaseCandidate(competitor.id, 'agent-original')).toMatchObject({ recovered: false, reason: 'candidate-successor-conflict' });
});
