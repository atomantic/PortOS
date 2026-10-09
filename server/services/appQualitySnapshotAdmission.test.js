import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QUALITY_SNAPSHOT_BRANCH, publishAppQualitySnapshot, __resetQualitySnapshotPublishState } from './appQualitySnapshotFile.js';
import { qualityFileFromWireSnapshot } from './appQualitySnapshotFormat.js';
import { claimMergeAdmission } from './cosMergeAdmission.js';

// The publisher's immediate merge shares the claim flow's REAL admission logic
// over a synthetic runtime store: only the store and the git remote are doubled.
const admissionState = vi.hoisted(() => ({ state: { agents: {}, mergeAdmissions: {} }, saveFails: false }));
vi.mock('./cosState.js', async () => {
  const { createFileWriteQueue } = await import('../lib/fileWriteQueue.js');
  return {
    withStateLock: createFileWriteQueue(),
    loadState: async () => admissionState.state,
    saveState: async state => {
      if (admissionState.saveFails) throw new Error('state write failed');
      admissionState.state = state;
    },
    readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(admissionState.state) }),
  };
});
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: async path => (path === '/repos/unreadable' ? null
    : { host: 'github.com', fullName: path === '/repos/other-app' ? 'example/other' : 'example/app' }),
}));

const app = { id: 'example-id', repoPath: '/repos/example-app' };
const prUrl = 'https://github.com/example/app/pull/42';
const glabUrl = 'https://gitlab.com/example/app/-/merge_requests/7';
const measurements = [{
  measurementId: 'b'.repeat(64), assessedAt: '2026-09-10T10:00:00Z',
  report: { version: 1, category: 'security', score: 82, worstSeverity: 5, coverage: 'broad', confidence: 'high', scannedFiles: 12, totalFiles: 12 },
}];
const snapshot = { schemaVersion: 1, repository: 'a'.repeat(64), measurements };
const missingShow = { exitCode: 1, stdout: '', stderr: 'missing' };

// `onBranch` simulates the stable snapshot branch already carrying the file.
const makeDeps = ({ glab = false, onBranch = false, mergeFails = false, ...overrides } = {}) => ({
  git: {
    isRepo: async () => true,
    getRemote: async () => ({ origin: { fetch: 'git@github.com:example/app.git' } }),
    fetchOrigin: async () => true,
    getDefaultBranch: async () => 'main',
    execGit: vi.fn(async args => (onBranch && args[0] === 'show' && String(args[1]).includes(QUALITY_SNAPSHOT_BRANCH)
      ? { exitCode: 0, stdout: qualityFileFromWireSnapshot(snapshot), stderr: '' }
      : args[0] === 'show' || args[0] === 'rev-parse' ? missingShow : { exitCode: 0, stdout: '', stderr: '' })),
    stageFiles: async () => true,
    unstageFiles: async () => true,
    commit: async () => ({ hash: 'abc1234' }),
    createPR: vi.fn(async () => ({ success: true, url: glab ? glabUrl : prUrl, cli: glab ? 'glab' : 'gh' })),
    mergePR: vi.fn(async () => (mergeFails ? { success: false, error: 'required status checks' } : { success: true })),
    parsePullRequestUrl: () => ({ number: glab ? 7 : 42 }),
  },
  writeFile: vi.fn(async () => true),
  buildQualitySnapshot: async () => snapshot,
  mkdtemp: async () => '/tmp/portos-quality-test',
  rm: async () => {},
  addWorktree: vi.fn(async () => true),
  execGlab: vi.fn(async () => ''),
  queuePendingMerge: vi.fn(async () => true),
  probePrForBranch: vi.fn(async () => (onBranch
    ? { prState: 'OPEN', prUrl: glab ? glabUrl : prUrl, prNumber: glab ? 7 : 42, cli: glab ? 'glab' : 'gh', readable: true }
    : { prState: null, readable: true })),
  ...overrides,
});

const startClaim = async (agentId = 'parent') => {
  admissionState.state.agents[agentId] = {
    id: agentId, taskId: `task-${agentId}`, startedAt: '2026-01-01', status: 'running',
    metadata: { sourceWorkspace: '/repos/example-app', claimPicksOwnBranch: true },
  };
  const lease = await claimMergeAdmission({ agentId, action: 'acquire' });
  expect(lease.admitted).toBe(true);
  return lease;
};

beforeEach(() => {
  __resetQualitySnapshotPublishState();
  admissionState.state = { agents: {}, mergeAdmissions: {} };
  admissionState.saveFails = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// Uniquely pins the #10731 contract: preparation and PR publication stay
// concurrent with a claim, but nothing advances the default branch while the
// claim's lease is live — and the PR remains recoverable afterwards.
it('publishes the PR but defers every merge while a claim holds the repository lease (GitHub)', async () => {
  const lease = await startClaim();
  const deps = makeDeps();
  expect(await publishAppQualitySnapshot(app, deps)).toEqual({
    published: true, hash: 'abc1234', path: '.quality.json', prUrl, prNumber: 42,
    merged: false, queuedMerge: true, deferredMerge: true,
  });
  expect(deps.writeFile).toHaveBeenCalled();
  expect(deps.git.createPR).toHaveBeenCalled();
  expect(deps.git.mergePR).not.toHaveBeenCalled();
  expect(deps.queuePendingMerge).toHaveBeenCalledWith('example-id', expect.objectContaining({ prNumber: 42 }));
  // The claim's own lease is untouched by the deferred publisher.
  expect(await claimMergeAdmission({ agentId: 'parent', action: 'check', token: lease.token }))
    .toMatchObject({ admitted: true });
});

it('defers the stable-branch reuse path without new measurements or merge calls', async () => {
  await startClaim();
  const deps = makeDeps({ onBranch: true });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prNumber: 42, merged: false, queuedMerge: true, deferredMerge: true,
  });
  expect(deps.writeFile).not.toHaveBeenCalled();
  expect(deps.addWorktree).not.toHaveBeenCalled();
  expect(deps.git.mergePR).not.toHaveBeenCalled();
});

it('leaves a GitLab MR open (no immediate or auto-merge) and retries it once the claim releases', async () => {
  const lease = await startClaim();
  const deferred = makeDeps({ glab: true });
  expect(await publishAppQualitySnapshot(app, deferred)).toMatchObject({
    published: true, prNumber: 7, merged: false, queuedMerge: false, deferredMerge: true,
  });
  expect(deferred.execGlab).not.toHaveBeenCalled();
  expect(deferred.queuePendingMerge).not.toHaveBeenCalled();

  await claimMergeAdmission({ agentId: 'parent', action: 'release', token: lease.token, outcome: 'merged' });
  // Same measurements, MR already on the stable branch: the unchanged body must
  // not be skipped as 'no-changes' just because the earlier merge was deferred.
  const retry = makeDeps({ glab: true, onBranch: true });
  expect(await publishAppQualitySnapshot(app, retry)).toMatchObject({ published: true, prNumber: 7, merged: true });
  expect(retry.execGlab).toHaveBeenCalledTimes(1);
  expect(retry.execGlab).toHaveBeenCalledWith(
    ['mr', 'merge', '7', '--yes', '--when-pipeline-succeeds=false'], '/repos/example-app', undefined, { rejectOnError: true },
  );
  expect(retry.writeFile).not.toHaveBeenCalled();
});

it('fails closed without touching another owner when ownership is unreadable or the repository is unknown', async () => {
  // Unreadable ownership: an agent record that is not a plain object.
  admissionState.state.mergeAdmissions['github.com/example/app'] = 'corrupt';
  const unreadable = makeDeps();
  expect(await publishAppQualitySnapshot(app, unreadable)).toMatchObject({ published: true, merged: false, deferredMerge: true });
  expect(unreadable.git.mergePR).not.toHaveBeenCalled();
  expect(admissionState.state.mergeAdmissions['github.com/example/app']).toBe('corrupt');

  admissionState.state.mergeAdmissions = {};
  const unknownRepo = makeDeps();
  expect(await publishAppQualitySnapshot({ ...app, repoPath: '/repos/unreadable' }, unknownRepo))
    .toMatchObject({ published: true, merged: false, deferredMerge: true });
  expect(unknownRepo.git.mergePR).not.toHaveBeenCalled();

  __resetQualitySnapshotPublishState();
  admissionState.saveFails = true;
  const writeFails = makeDeps();
  expect(await publishAppQualitySnapshot(app, writeFails)).toMatchObject({ published: true, merged: false, deferredMerge: true });
  expect(writeFails.git.mergePR).not.toHaveBeenCalled();
  expect(admissionState.state.mergeAdmissions).toEqual({});
});

it('releases its own lease after a merge and after a refused merge, and never blocks another repository', async () => {
  const merged = makeDeps();
  expect(await publishAppQualitySnapshot(app, merged)).toMatchObject({ merged: true, queuedMerge: false });
  expect(merged.git.mergePR).toHaveBeenCalledTimes(1);
  expect(admissionState.state.mergeAdmissions).toEqual({});

  __resetQualitySnapshotPublishState();
  const refused = makeDeps({ mergeFails: true });
  expect(await publishAppQualitySnapshot(app, refused)).toMatchObject({ merged: false, queuedMerge: true });
  expect(refused.queuePendingMerge).toHaveBeenCalledTimes(1);
  expect(admissionState.state.mergeAdmissions).toEqual({});

  // A claim on one repository does not defer a different repository's snapshot.
  await startClaim();
  const other = makeDeps();
  expect(await publishAppQualitySnapshot({ id: 'other-id', repoPath: '/repos/other-app' }, other))
    .toMatchObject({ merged: true });
  expect(other.git.mergePR).toHaveBeenCalledTimes(1);
});
