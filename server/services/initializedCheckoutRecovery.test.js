vi.mock('../lib/retirementCheckoutObservation.js', () => ({
  readRetirementCheckoutIdentity: vi.fn(async () => null), isCurrentRetirementCheckout: vi.fn(async () => false),
}));
import { readRetirementCheckoutIdentity, isCurrentRetirementCheckout } from '../lib/retirementCheckoutObservation.js';
import { pinPlatform } from '../lib/testHelper.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const persisted = vi.hoisted(() => ({ json: '{}', hostType: null, rejectDirectoryOpen: false, syntheticModes: false, fileSyncs: 0 }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, type: () => persisted.hostType || actual.type() };
});
vi.mock('./taskScheduleStore.js', async importOriginal => ({
  ...(await importOriginal()),
  loadSchedule: async () => JSON.parse(persisted.json),
  updateSchedule: async mutate => {
    const schedule = JSON.parse(persisted.json);
    const { result, changed } = await mutate(schedule);
    if (changed) persisted.json = JSON.stringify(schedule);
    return result;
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, link: async (source, target) => {
    if (fixture?.conflictNextJournal) {
      fixture.conflictNextJournal = false;
      await actual.writeFile(target, 'concurrent-evidence', { flag: 'wx', mode: 0o600 });
    }
    await actual.link(source, target);
    if (fixture?.interruptPhase && JSON.parse(await actual.readFile(target, 'utf8')).phase === fixture.interruptPhase) {
      fixture.interruptPhase = null;
      throw new Error('journal-publication-interrupted');
    }
    if (fixture?.stopAfterJournalPublication) {
      fixture.stopAfterJournalPublication = false;
      throw new Error('journal-publication-interrupted');
    }
  }, lstat: async path => {
    const info = await actual.lstat(path);
    // Model POSIX permission bits even when this Darwin-capability fixture runs
    // on Windows; the unsafe-mode branch below still exercises real refusal.
    if (persisted.hostType === 'Darwin' || persisted.syntheticModes) {
      const mode = persisted.syntheticModes ? 0o777 : info.isDirectory() ? 0o700 : 0o600;
      return Object.assign(Object.create(info), { mode: (info.mode & ~0o777) | mode });
    }
    return info;
  }, open: async (path, ...args) => {
    if (persisted.rejectDirectoryOpen && (await actual.lstat(path).catch(() => null))?.isDirectory()) throw new Error('directory-open-unsupported');
    const isJournalStage = /[\\/]\.\d{6}\.json\.[a-f0-9-]+\.staging$/.test(String(path));
    if (fixture?.failNextJournal && isJournalStage) {
      fixture.failNextJournal = false;
      throw new Error('journal-write-interrupted');
    }
    const handle = await actual.open(path, ...args);
    if (fixture?.partialNextJournal && isJournalStage) {
      fixture.partialNextJournal = false;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async text => { await write(text.slice(0, 1)); throw new Error('partial-journal-write'); };
    }
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => { persisted.fileSyncs++; return originalSync(); };
    return handle;
  } };
});
vi.mock('./cosClaimOwnershipState.js', () => ({ withClaimOwnershipLock: work => work() }));
import { _createInitializedCheckoutRecovery } from './initializedCheckoutRecovery.js';

let root, fixture;
const release = { path: '/fixture/checkout', branch: 'claim/42', head: 'a'.repeat(40), locked: false, lockReason: null };
const prUrl = 'https://github.com/example/repo/pull/42';
beforeEach(async () => {
  readRetirementCheckoutIdentity.mockReset().mockResolvedValue(null);
  isCurrentRetirementCheckout.mockReset().mockResolvedValue(false);
  persisted.hostType = null; persisted.rejectDirectoryOpen = persisted.syntheticModes = false; persisted.fileSyncs = 0;
  root = await mkdtemp(join(tmpdir(), 'initialized-recovery-'));
  const facts = { prUrl, prHead: release.head, mergeCommit: 'c'.repeat(40), defaultHead: 'b'.repeat(40) };
  const snapshot = { fingerprint: 'c'.repeat(64), administrationFingerprint: 'd'.repeat(64), identity: { working: 1, administration: 2, common: 3 } };
  fixture = { cut: null, facts, snapshot, headExists: true, placement: { working: 'original', administration: 'original' }, failPart: null,
    metadataToken: 'f'.repeat(64), finalizationToken: '7'.repeat(64), quarantineToken: '6'.repeat(64) };
  const admission = {
    _checkoutAdmission: async () => ({ directory: join(root, 'admission') }),
    withCheckoutPublication: async (_repo, work) => { if (fixture.cut) throw new Error('checkout-retirement-reserved'); return work(); },
    reserveCheckoutRetirement: vi.fn(async (_repo, id) => {
      if (fixture.cut) throw new Error('checkout-retirement-reserved');
      fixture.cut = { owner: { version: 1, id, generation: id, kind: 'snapshot', pid: process.pid, startedAt: new Date().toISOString() }, directory: '/fixture/admission' }; return fixture.cut;
    }),
    withCheckoutReservation: async (_cut, work) => work(),
    readCheckoutReservation: async () => {
      if (!fixture.cut) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return fixture.cut;
    },
    releaseCheckoutReservation: vi.fn(async () => { fixture.cut = null; }),
  };
  const native = vi.fn(async input => {
    if (input.command === 'lock') return { assertHeld: () => {}, release: async () => {} };
    if (input.command === 'inspect') {
      if (fixture.lockState != null && Boolean(input.expectUnlocked) === fixture.lockState) throw new Error('release-lock-changed');
      if (fixture.inspectRefusal) throw new Error(fixture.inspectRefusal);
      if (fixture.ownershipRefusal && input.requireOwnership) throw new Error(fixture.ownershipRefusal);
      return { ...fixture.snapshot };
    }
    if (input.command === 'verify-original-placement') {
      if (fixture.cancelRefusal) throw new Error(fixture.cancelRefusal);
      return { verified: true, originalsUnmoved: true, archiveVerified: false,
        contentAndMetadataUnverified: true, partialArchivesRetained: true };
    }
    if (input.command === 'verify-unmoved-preservation') {
      if (fixture.cancelRefusal) throw new Error(fixture.cancelRefusal);
      if ((await readdir(input.transactionDir)).includes('manifest.json')) throw new Error('preservation-already-bound');
      return { verified: true, originalsUnmoved: true, archiveVerified: false,
        reviewedFingerprint: input.expected.fingerprint, observedFingerprint: fixture.snapshot.fingerprint };
    }
    if (input.command === 'preserve') {
      if (fixture.failPreserve) throw new Error('archive-no-space');
      await writeFile(join(input.transactionDir, 'manifest.json'), '{}', { mode: 0o600 });
      if (fixture.failProofJournal) fixture.failNextJournal = true;
      return { ok: true, manifestSha256: 'e'.repeat(64), restoreProof: { verified: true } };
    }
    if (input.command === 'review-metadata-recovery') return {
      metadataRecovery: { version: 1, digest: fixture.metadataToken, evidenceFile: 'private-proof.json', evidenceSha256: fixture.metadataToken },
      initialPlacements: { ...fixture.placement }, changeCounts: { residualCompressionRemoved: 3, rootProvenanceAdded: 1 }, changedPaths: 4,
    };
    if (input.command === 'verify-deleted-branch') {
      if (fixture.deletedRefConflict) throw new Error(fixture.deletedRefConflict);
      if (fixture.headExists || !['branch-retired', 'retired'].includes(input.confirmedDeletion?.phase)) throw new Error('retirement-deleted-branch-not-absent');
      return { verified: true, branchAbsent: true, confirmedDeletion: input.confirmedDeletion };
    }
    if (input.command === 'review-quarantine-resumption') {
      if (fixture.failArchive) throw new Error('archive-changed');
      if (fixture.forbiddenMetadata) throw new Error('metadata-delta-not-eligible');
      return { quarantineResumption: { version: 1, evidenceFile: 'quarantine-proof.json',
        evidenceSha256: fixture.quarantineToken, digest: fixture.quarantineToken },
      initialPlacements: Object.fromEntries(Object.entries(fixture.placement).map(([part, value]) => [part, value === 'quarantined' ? 'quarantine' : value])),
      changeCounts: { residualCompressionRemoved: 3, rootProvenanceAdded: 1 }, changedPaths: 4 };
    }
    if (['verify-quarantine-resumption', 'resume-quarantine', 'verify-completed-quarantine', 'verify-retired-quarantine'].includes(input.command)) {
      if (fixture.failArchive) throw new Error('archive-changed');
      if (fixture.forbiddenMetadata) throw new Error('metadata-delta-not-eligible');
      if (input.quarantineResumption?.digest !== fixture.quarantineToken) throw new Error('quarantine-evidence-changed');
      if (input.command === 'resume-quarantine') {
        if (fixture.failResume) throw new Error('resume-interrupted');
        fixture.placement.administration = 'quarantined';
        if (fixture.resumeDelta) { fixture.quarantineToken = '5'.repeat(64); throw new Error('quarantine-evidence-changed'); }
        if (fixture.failResumeResult) fixture.failNextJournal = true;
      }
      if (input.command === 'verify-retired-quarantine'
        && (fixture.headExists || !['branch-retired', 'retired'].includes(input.confirmedDeletion?.phase))) throw new Error('deleted-ref-proof-refused');
      if (input.command !== 'verify-retired-quarantine' && !fixture.headExists) throw new Error('branch-ref-changed');
      return { verified: true, quarantineResumptionAccepted: true, fingerprint: fixture.snapshot.fingerprint,
        placements: Object.fromEntries(Object.entries(fixture.placement).map(([part, value]) => [part, { state: value === 'quarantined' ? 'quarantine' : value }])),
        ...(input.command === 'resume-quarantine' ? { moved: true,
          postMoveObservation: { file: 'administration-quarantine-post-move.json', sha256: fixture.quarantineToken, digest: fixture.quarantineToken } } : {}) };
    }
    if (input.command === 'review-restored-finalization') {
      if (fixture.failArchive) throw new Error('archive-changed');
      return { restoredFinalization: { version: 1, evidenceFile: 'finalization.json',
        evidenceSha256: fixture.finalizationToken, digest: fixture.finalizationToken },
      placements: { ...fixture.placement }, changeCounts: { directoryMtimeChanged: 2, residualCompressionReappeared: 1 }, changedPaths: 3 };
    }
    if (input.command === 'verify-restored-finalization') {
      if (fixture.failFinalization || input.restoredFinalization?.digest !== fixture.finalizationToken) throw new Error('finalization-evidence-changed');
      return { verified: true, alreadyRestored: true, restoredFinalizationAccepted: true,
        placements: Object.fromEntries(Object.entries(fixture.placement).map(([part, state]) => [part, { state }])) };
    }
    if (['verify', 'move', 'status'].includes(input.command) && input.manifestSha256 !== 'e'.repeat(64)) throw new Error('archive-manifest-proof-changed');
    if (fixture.delayedRestoreDrift && input.command === 'verify' && input.mode === 'restore'
      && Object.values(fixture.placement).every(value => value === 'original')) throw new Error('source-content-or-identity-changed:working');
    if (fixture.metadataDrift && ['verify', 'move'].includes(input.command) && input.mode !== 'standalone'
      && input.metadataRecovery?.digest !== fixture.metadataToken) throw new Error('source-content-or-identity-changed:working');
    const alreadyRestored = input.command === 'move' && input.direction === 'restore' && fixture.placement[input.part] === 'original';
    if (input.command === 'move') {
      if (fixture.failPart === input.part && input.direction === 'quarantine') throw new Error('move-refused');
      if (fixture.failRestorePart === input.part && input.direction === 'restore') throw new Error('restore-interrupted');
      fixture.placement[input.part] = input.direction === 'quarantine' ? 'quarantined' : 'original';
    }
    if (fixture.failArchive && input.command === 'verify') throw new Error('archive-changed');
    return { ok: true, placement: fixture.placement, fingerprint: fixture.snapshot.fingerprint,
      ...(input.command === 'verify' && input.mode === 'standalone' ? { verified: true, standalone: true } : {}),
      ...(input.metadataRecovery && !alreadyRestored ? {
        postMoveObservation: { file: `${input.part}-post-move.json`, sha256: fixture.metadataToken, digest: fixture.metadataToken },
      } : {}),
      placements: Object.fromEntries(Object.entries(fixture.placement).map(([part, state]) => [part, { state: state === 'quarantined' ? 'quarantine' : state }])) };
  });
  const deps = { root: () => root, fenced: work => work(), admission, native,
    context: async () => ({ repoPath: '/fixture/repo' }),
    retainReleaseSynchronizationReview: vi.fn(async () => true),
    validateLegacyReleaseRetirement: vi.fn(async () => true),
    prepareLegacyReleaseRetirement: vi.fn(async () => new Map()),
    validateLockedPublisherRetirement: vi.fn(async () => true),
    ownership: vi.fn(async () => ({ ok: true, policy: null })),
    forge: async () => ({ ...fixture.facts }),
    comparison: async (_ctx, _release, _url, _snapshot, policy, forge) => ({
      release: _release, forge, policy, comparison: { disposition: fixture.superseded ? 'review-supersession' : 'integrated', difference: fixture.superseded ? 'review the changed work' : '' },
    }),
    listWorktrees: async () => fixture.newHolder ? [{ path: '/fixture/new', branch: release.branch }] : [],
    execGit: vi.fn(async () => ({ exitCode: fixture.headExists ? 0 : 1, stdout: fixture.headExists ? release.head : '' })),
    deleteRef: vi.fn(async (_repo, _branch, _head, options) => { await options.beforeMutation(); fixture.headExists = false; return true; }),
    recordRetirement: vi.fn(async (_appId, receipt) => ({
      retired: [{ ...receipt, archiveDir: null, retiredAt: '2026-10-24T00:00:00.000Z' }],
    })),
  };
  fixture.deps = deps; fixture.service = _createInitializedCheckoutRecovery(deps);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const reviewed = async () => {
  const response = await fixture.service.review({ appId: 'app', release, prUrl });
  expect(response.ok).toBe(true);
  return { appId: 'app', release, review: { prUrl, digest: response.review.digest, acceptSuperseded: fixture.superseded === true } };
};

describe('initialized checkout removal', () => {
  const cleanGit = () => {
    fixture.deps.execGit.mockImplementation(async (args) => {
      if (args[0] === 'status' && args[1] === '--porcelain') return { exitCode: 0, stdout: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { exitCode: 0, stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { exitCode: 0, stdout: `${release.path}\n` };
      return { exitCode: fixture.headExists ? 0 : 1, stdout: fixture.headExists ? `${release.head}\n` : '' };
    });
    fixture.deps.deleteRef.mockImplementation(async () => { fixture.headExists = false; return true; });
  };
  const nativeCommands = () => fixture.deps.native.mock.calls.map(([input]) => input.command);
  const forgeEvidence = () => ({ source: 'forge-pr', prUrl, prHead: release.head, mergeCommit: 'c'.repeat(40) });

  it('reviews a merged checkout without creating a transaction directory', async () => {
    const response = await fixture.service.review({ appId: 'app', release, prUrl });
    expect(response.ok).toBe(true);
    expect(response.review.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(root)).toEqual([]);
    expect(nativeCommands()).not.toContain('preserve');
    expect(nativeCommands()).not.toContain('move');
    expect(nativeCommands()).not.toContain('lock');
  });

  it('removes an integrated clean checkout without copying it and deletes the branch', async () => {
    cleanGit();
    const result = await fixture.service.retire(await reviewed());
    expect(result).toEqual({ ok: true, branchDeleted: true, validationEvidence: forgeEvidence() });
    expect(await readdir(root)).toEqual([]);
    expect(nativeCommands()).not.toContain('preserve');
    expect(nativeCommands()).not.toContain('move');
    expect(fixture.deps.deleteRef).toHaveBeenCalledWith('/fixture/repo', release.branch, release.head, {});
    expect(fixture.deps.execGit).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', release.path], '/fixture/repo', { ignoreExitCode: true },
    );
    expect(fixture.deps.recordRetirement).toHaveBeenCalledWith('app', {
      path: release.path, branch: release.branch, head: release.head, branchDeleted: true, validationEvidence: forgeEvidence(),
    });
  });

  it('stores the checkout identity read before the tree is removed', async () => {
    cleanGit();
    readRetirementCheckoutIdentity.mockResolvedValue('identity-1');
    const result = await fixture.service.retire(await reviewed());
    expect(result).toEqual({ ok: true, branchDeleted: true, validationEvidence: forgeEvidence() });
    expect(fixture.deps.recordRetirement).toHaveBeenCalledWith('app', {
      path: release.path, branch: release.branch, head: release.head, branchDeleted: true, checkoutIdentity: 'identity-1',
      validationEvidence: forgeEvidence(),
    });
  });

  it('reports the removal unverified when the retirement receipt is not stored', async () => {
    cleanGit();
    fixture.deps.recordRetirement.mockResolvedValue({ retired: [] });
    expect(await fixture.service.retire(await reviewed())).toEqual({
      ok: false, reason: 'retirement-receipt-unverified', branchDeleted: true,
    });
  });

  it('retains a locked release candidate with an initialized submodule', async () => {
    cleanGit();
    fixture.snapshot.modules = [{ path: 'lib/slashdo' }];
    const candidate = { ...release, branch: 'codex/release-agent-test', locked: true,
      lockReason: 'Active release candidate codex/release-agent-test' };
    const preview = await fixture.service.review({ appId: 'app', release: candidate, prUrl });
    expect(preview.ok).toBe(true);
    expect(preview.review.snapshot.modules).toEqual([{ path: 'lib/slashdo' }]);
    const input = { appId: 'app', release: candidate, review: { prUrl, digest: preview.review.digest } };
    expect(await fixture.service.retire(input)).toEqual({ ok: false, reason: 'locked-retirement-evidence-unavailable' });
    expect(fixture.deps.execGit.mock.calls.some(([args]) => args[0] === 'worktree')).toBe(false);
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
  });

  it('journals a reviewed locked publisher before unlocking and records its exact retirement', async () => {
    const path = join(root, 'candidate');
    await mkdir(path);
    const candidate = { ...release, path, locked: true, lockReason: 'fixture held' };
    readRetirementCheckoutIdentity.mockResolvedValue('fixture-identity');
    fixture.snapshot.modules = [{ path: 'lib/slashdo' }];
    fixture.snapshot.lockTransitionFingerprint = 'f'.repeat(64);
    fixture.snapshot.privateGitDir = join(root, 'absent-administration');
    fixture.deps.execGit.mockImplementation(async args => {
      if (args[0] === 'worktree' && args[1] === 'remove') await rm(path, { recursive: true });
      return { exitCode: 0, stdout: '' };
    });
    fixture.deps.deleteRef.mockResolvedValue(true);
    const preview = await fixture.service.review({ appId: 'app', release: candidate, prUrl });
    const result = await fixture.service.retire({ appId: 'app', release: candidate,
      review: { prUrl, digest: preview.review.digest } });
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(fixture.deps.execGit).toHaveBeenCalledWith(['worktree', 'unlock', path], '/fixture/repo', { ignoreExitCode: true });
    const files = (await readdir(join(root, result.transactionId))).filter(name => /^\d{6}\.json$/.test(name)).sort();
    const phases = await Promise.all(files.map(async name => JSON.parse(await readFile(join(root, result.transactionId, name))).phase));
    expect(phases).toEqual(['locked-intent', 'locked-reserved', 'locked-preserved', 'locked-unlock-intent', 'locked-unlocked',
      'locked-removal-intent', 'locked-removed', 'locked-branch-intent', 'locked-branch-retired', 'locked-retired']);
    expect(fixture.cut).toBeNull();
  });

  it.each(['owner', 'content', 'administration', 'generation', 'lock', 'head', 'publisher', 'post-unlock-content'])(
    'refuses changed %s without issuing removal or a receipt', async change => {
      const path = join(root, 'candidate');
      await mkdir(path);
      const candidate = { ...release, path, locked: true, lockReason: 'fixture held' };
      readRetirementCheckoutIdentity.mockResolvedValue('fixture-identity');
      fixture.snapshot.modules = [{ path: 'lib/slashdo' }];
      fixture.snapshot.lockTransitionFingerprint = 'f'.repeat(64);
      fixture.snapshot.privateGitDir = join(root, 'absent-administration');
      fixture.deps.execGit.mockImplementation(async args => {
        if (change === 'post-unlock-content' && args[0] === 'worktree' && args[1] === 'unlock') {
          fixture.snapshot.lockTransitionFingerprint = '9'.repeat(64);
        }
        return { exitCode: 0, stdout: '' };
      });
      const preview = await fixture.service.review({ appId: 'app', release: candidate, prUrl });
      if (change === 'owner') fixture.ownershipRefusal = 'active-owner';
      if (change === 'content') fixture.snapshot.fingerprint = '9'.repeat(64);
      if (change === 'administration') fixture.snapshot.administrationFingerprint = '9'.repeat(64);
      if (change === 'generation') readRetirementCheckoutIdentity.mockResolvedValue('other-identity');
      if (change === 'publisher') fixture.deps.validateLockedPublisherRetirement.mockResolvedValue(false);
      const changed = change === 'lock' ? { ...candidate, lockReason: 'new lock' }
        : change === 'head' ? { ...candidate, head: 'b'.repeat(40) } : candidate;
      const result = await fixture.service.retire({ appId: 'app', release: changed,
        review: { prUrl, digest: preview.review.digest } });
      expect(result.ok).toBe(false);
      expect(fixture.deps.execGit.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
      expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
      if (change === 'post-unlock-content') expect(fixture.cut?.owner.id).toBe(result.transactionId);
    },
  );

  it.each(['locked-unlock-intent', 'locked-unlocked', 'locked-removal-intent', 'locked-removed', 'locked-branch-retired'])(
    'holds the exact transaction after interruption at %s and repeated recovery', async phase => {
      const path = join(root, 'candidate');
      await mkdir(path);
      await writeFile(join(path, 'fixture-bytes'), 'private fixture');
      const candidate = { ...release, path, locked: true, lockReason: 'fixture held' };
      readRetirementCheckoutIdentity.mockResolvedValue('fixture-identity');
      fixture.snapshot.modules = [{ path: 'lib/slashdo' }];
      fixture.snapshot.lockTransitionFingerprint = 'f'.repeat(64);
      fixture.snapshot.privateGitDir = join(root, 'absent-administration');
      fixture.lockState = true;
      fixture.deps.execGit.mockImplementation(async args => {
        if (args[0] === 'worktree' && args[1] === 'unlock') fixture.lockState = false;
        if (args[0] === 'worktree' && args[1] === 'lock') fixture.lockState = true;
        if (args[0] === 'worktree' && args[1] === 'remove') await rm(path, { recursive: true });
        return { exitCode: args[0] === 'show-ref' ? 1 : 0, stdout: '' };
      });
      fixture.deps.deleteRef.mockImplementation(async (_repo, _branch, _head, options) => {
        await options.beforeMutation?.(); return true;
      });
      fixture.deps.getOutcome = async () => ({ retired: [] });
      const preview = await fixture.service.review({ appId: 'app', release: candidate, prUrl });
      fixture.interruptPhase = phase;
      const result = await fixture.service.retire({ appId: 'app', release: candidate,
        review: { prUrl, digest: preview.review.digest } });
      expect(result).toMatchObject({ ok: false, reason: 'journal-publication-interrupted', recoveryRequired: true });
      expect(fixture.cut?.owner.id).toBe(result.transactionId);
      const discovery = await fixture.service.discover();
      const row = discovery.transactions.find(value => value.transactionId === result.transactionId);
      expect(row).toMatchObject({ phase, release: candidate, settled: false });
      const recovery = await fixture.service.recoverAutomatically({ appId: 'app', transactionId: row.transactionId,
        journalDigest: row.journalDigest }, { blocked: async () => null });
      if (['locked-removed', 'locked-branch-retired'].includes(phase)) {
        expect(recovery).toMatchObject({ ok: true, receiptRecorded: true });
        expect(fixture.cut).toBeNull();
      } else {
        expect(recovery).toMatchObject({ ok: true, restored: true });
        expect(fixture.lockState).toBe(true);
        expect(fixture.cut).toBeNull();
        expect(await readFile(join(path, 'fixture-bytes'), 'utf8')).toBe('private fixture');
      }
      expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(['locked-removed', 'locked-branch-retired'].includes(phase) ? 1 : 0);
    },
  );

  it('replays only cut release after a durable exact receipt and is idempotent', async () => {
    const path = join(root, 'candidate');
    await mkdir(path);
    const candidate = { ...release, path, locked: true, lockReason: 'fixture held' };
    readRetirementCheckoutIdentity.mockResolvedValue('fixture-identity');
    fixture.snapshot.modules = [{ path: 'lib/slashdo' }];
    fixture.snapshot.privateGitDir = join(root, 'absent-administration');
    fixture.snapshot.lockTransitionFingerprint = 'f'.repeat(64);
    fixture.deps.execGit.mockImplementation(async args => {
      if (args[0] === 'worktree' && args[1] === 'remove') await rm(path, { recursive: true });
      return { exitCode: args[0] === 'show-ref' ? 1 : 0, stdout: '' };
    });
    fixture.deps.deleteRef.mockResolvedValue(true);
    let outcome;
    fixture.deps.recordRetirement.mockImplementation(async (_app, row) => {
      outcome = { retired: [{ ...row, archiveDir: null }] }; return outcome;
    });
    fixture.deps.getOutcome = async () => outcome;
    const preview = await fixture.service.review({ appId: 'app', release: candidate, prUrl });
    fixture.interruptPhase = 'locked-retired';
    const result = await fixture.service.retire({ appId: 'app', release: candidate,
      review: { prUrl, digest: preview.review.digest } });
    expect(result).toMatchObject({ ok: false, reason: 'journal-publication-interrupted' });
    const row = (await fixture.service.discover()).transactions.find(value => value.transactionId === result.transactionId);
    const input = { appId: 'app', transactionId: row.transactionId, journalDigest: row.journalDigest };
    const recovery = await fixture.service.recoverAutomatically(input, { blocked: async () => null });
    expect(recovery.ok, JSON.stringify(recovery)).toBe(true);
    expect(recovery.receiptRecorded).toBe(true);
    expect(await fixture.service.recoverAutomatically(input, { blocked: async () => null })).toMatchObject({ ok: true, alreadyComplete: true });
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(1);
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
  });

  it('does not remove an initialized checkout before release synchronization retains its review', async () => {
    cleanGit();
    fixture.deps.retainReleaseSynchronizationReview.mockResolvedValue(false);
    expect(await fixture.service.retire(await reviewed())).toEqual({ ok: false, reason: 'release-sync-local-review-unretained' });
    expect(fixture.deps.execGit).not.toHaveBeenCalled();
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
  });

  it('leaves a review-superseded checkout in place', async () => {
    fixture.superseded = true;
    cleanGit();
    expect(await fixture.service.retire(await reviewed())).toEqual({ ok: false, reason: 'not-merged-on-recheck' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.deps.execGit).not.toHaveBeenCalled();
    expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('writes nothing when ownership is refused during review', async () => {
    fixture.ownershipRefusal = 'active-owner';
    expect(await fixture.service.review({ appId: 'app', release, prUrl })).toEqual({ ok: false, reason: 'active-owner' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('writes nothing when the accepted review digest no longer matches', async () => {
    cleanGit();
    const input = await reviewed();
    input.review.digest = '0'.repeat(64);
    expect(await fixture.service.retire(input)).toEqual({ ok: false, reason: 'retirement-review-changed' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.deps.execGit).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps a dirty checkout and does not delete its branch', async () => {
    fixture.deps.execGit.mockImplementation(async (args) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: ' M dirty.js\n' };
      return { exitCode: 0, stdout: '' };
    });
    fixture.deps.deleteRef.mockImplementation(async () => true);
    expect(await fixture.service.retire(await reviewed())).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.deps.execGit).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', release.path], expect.anything(), expect.anything(),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('does not delete the branch when status cannot be read', async () => {
    fixture.deps.execGit.mockImplementation(async () => ({ exitCode: 1, stdout: '' }));
    fixture.deps.deleteRef.mockImplementation(async () => true);
    expect(await fixture.service.retire(await reviewed())).toEqual({ ok: false, reason: 'worktree-status-unavailable' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('preserves the original directory when Git refuses removal even if its toplevel matches', async () => {
    const sentinel = join(root, 'original.txt');
    await writeFile(sentinel, 'original checkout bytes');
    fixture.deps.execGit.mockImplementation(async args => ({
      exitCode: args[0] === 'worktree' ? 1 : 0,
      stdout: args[0] === 'rev-parse' ? root : '',
    }));
    const currentRelease = { ...release, path: root };
    const prepared = await fixture.service.review({ appId: 'app', release: currentRelease, prUrl });
    expect(await fixture.service.retire({ appId: 'app', release: currentRelease,
      review: { prUrl, digest: prepared.review.digest } })).toEqual({ ok: false, reason: 'checkout-not-removed' });
    expect(await readFile(sentinel, 'utf8')).toBe('original checkout bytes');
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
  });

  it('does not remove a different toplevel when worktree removal fails', async () => {
    fixture.deps.execGit.mockImplementation(async (args) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '' };
      if (args[0] === 'worktree') return { exitCode: 1, stdout: '' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: '/somewhere/else\n' };
      return { exitCode: 0, stdout: '' };
    });
    fixture.deps.deleteRef.mockImplementation(async () => true);
    expect(await fixture.service.retire(await reviewed())).toEqual({ ok: false, reason: 'checkout-not-removed' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps the real native backend unavailable on unsupported platforms', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      const { native: _native, ...deps } = fixture.deps;
      const service = _createInitializedCheckoutRecovery(deps);
      expect(await service.review({ appId: 'app', release, prUrl })).toEqual({ ok: false, reason: 'retirement-platform-unsupported' });
      expect(await readdir(root)).toEqual([]);
    } finally { restorePlatform(); }
  });
});
