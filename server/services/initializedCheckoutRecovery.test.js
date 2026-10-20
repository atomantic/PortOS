import { pinPlatform } from '../lib/testHelper.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const persisted = vi.hoisted(() => ({ json: '{}', hostType: null, rejectDirectoryOpen: false, syntheticModes: false, fileSyncs: 0 }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, type: () => persisted.hostType || actual.type() };
});
vi.mock('./taskScheduleStore.js', () => ({
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
  persisted.hostType = null; persisted.rejectDirectoryOpen = persisted.syntheticModes = false; persisted.fileSyncs = 0;
  root = await mkdtemp(join(tmpdir(), 'initialized-recovery-'));
  const facts = { prUrl, prHead: release.head, defaultHead: 'b'.repeat(40) };
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
    if (input.command === 'inspect') return { ...fixture.snapshot };
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
      ...(input.metadataRecovery && !alreadyRestored ? {
        postMoveObservation: { file: `${input.part}-post-move.json`, sha256: fixture.metadataToken, digest: fixture.metadataToken },
      } : {}),
      placements: Object.fromEntries(Object.entries(fixture.placement).map(([part, state]) => [part, { state: state === 'quarantined' ? 'quarantine' : state }])) };
  });
  const deps = { root: () => root, fenced: work => work(), admission, native,
    context: async () => ({ repoPath: '/fixture/repo' }),
    ownership: vi.fn(async () => ({ ok: true, policy: null })),
    forge: async () => ({ ...fixture.facts }),
    comparison: async (_ctx, _release, _url, _snapshot, policy, forge) => ({
      release: _release, forge, policy, comparison: { disposition: fixture.superseded ? 'review-supersession' : 'integrated', difference: fixture.superseded ? 'review the changed work' : '' },
    }),
    listWorktrees: async () => fixture.newHolder ? [{ path: '/fixture/new', branch: release.branch }] : [],
    execGit: vi.fn(async () => ({ exitCode: fixture.headExists ? 0 : 1, stdout: fixture.headExists ? release.head : '' })),
    deleteRef: vi.fn(async (_repo, _branch, _head, options) => { await options.beforeMutation(); fixture.headExists = false; return true; }),
    recordRetirement: vi.fn(async () => {}),
  };
  fixture.deps = deps; fixture.service = _createInitializedCheckoutRecovery(deps);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const reviewed = async () => {
  const response = await fixture.service.review({ appId: 'app', release, prUrl });
  expect(response.ok).toBe(true);
  return { appId: 'app', release, review: { prUrl, digest: response.review.digest, acceptSuperseded: fixture.superseded === true } };
};

describe('initialized checkout transaction', () => {
  it('uses actual Windows filesystem capabilities for mocked workflows without suppressing file fsync', async () => {
    persisted.hostType = 'Windows_NT'; persisted.syntheticModes = true; persisted.rejectDirectoryOpen = true;
    const restorePlatform = pinPlatform('darwin');
    try {
      const result = await fixture.service.retire(await reviewed());
      expect(result).toMatchObject({ ok: true, originalsQuarantined: true });
      expect((await fixture.service.status({ appId: 'app', transactionId: result.transactionId })).phase).toBe('quarantined');
      expect(persisted.fileSyncs).toBeGreaterThan(0);
    } finally { restorePlatform(); }
  });
  it('does not suppress directory sync failure or POSIX mode checks on Darwin', async () => {
    persisted.hostType = 'Darwin'; persisted.rejectDirectoryOpen = true;
    expect(await fixture.service.retire(await reviewed())).toMatchObject({ ok: false, reason: 'directory-open-unsupported' });
    expect(fixture.deps.native.mock.calls.some(([input]) => input.command === 'move')).toBe(false);
    persisted.rejectDirectoryOpen = false; persisted.syntheticModes = true;
    expect(await fixture.service.retire(await reviewed())).toMatchObject({ ok: false, reason: 'retirement-journal-directory-unsafe' });
  });
  it('keeps the real native backend unavailable on unsupported platforms', async () => {
    const restorePlatform = pinPlatform('win32');
    try {
      const { native: _native, ...deps } = fixture.deps;
      const service = _createInitializedCheckoutRecovery(deps);
      expect(await service.review({ appId: 'app', release, prUrl })).toMatchObject({ ok: false, reason: 'retirement-platform-unsupported' });
      expect(await readdir(root)).toEqual([]);
    } finally { restorePlatform(); }
  });
  it('quarantines both original directories only after preservation, retaining the rollback ref', async () => {
    const result = await fixture.service.retire(await reviewed());
    expect(result).toMatchObject({ ok: true, originalsQuarantined: true, branchDeleted: false, branchRetainedReason: 'quarantined-checkout-rollback-ref' });
    expect(fixture.placement).toEqual({ working: 'quarantined', administration: 'quarantined' });
    expect(fixture.cut).toBeNull();
    expect(fixture.deps.execGit).not.toHaveBeenCalled();
    const commands = fixture.deps.native.mock.calls.map(([input]) => input.command);
    expect(commands.indexOf('preserve')).toBeLessThan(commands.indexOf('move'));
    const status = await fixture.service.status({ appId: 'app', transactionId: result.transactionId });
    expect(status.phase).toBe('quarantined');
    expect(status.journalDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['working', 'administration'])('retains a durable cut on %s move interruption and restores explicitly after restart', async part => {
    fixture.failPart = part;
    const result = await fixture.service.retire(await reviewed());
    expect(result).toMatchObject({ ok: false, recoveryRequired: true, reason: 'move-refused' });
    expect(fixture.cut).not.toBeNull();
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status({ appId: 'app', transactionId: result.transactionId });
    const restored = await restarted.restore({ appId: 'app', transactionId: result.transactionId, journalDigest: status.journalDigest });
    expect(restored).toMatchObject({ ok: true, restored: true, archivesRetained: true });
    expect(fixture.placement).toEqual({ working: 'original', administration: 'original' });
    expect(fixture.cut).toBeNull();
  });
  it('can cancel a failed preservation without deleting its partial evidence', async () => {
    fixture.failPreserve = true;
    const result = await fixture.service.retire(await reviewed());
    expect(result.reason).toBe('archive-no-space');
    const status = await fixture.service.status({ appId: 'app', transactionId: result.transactionId });
    expect(status.placement).toEqual({ preserved: false });
    expect(await fixture.service.restore({ appId: 'app', transactionId: result.transactionId, journalDigest: status.journalDigest })).toMatchObject({ ok: true });
    expect((await readdir(join(root, result.transactionId))).length).toBeGreaterThan(0);
  });
  const interruptedMetadata = async () => {
    fixture.failPart = 'administration';
    const retired = await fixture.service.retire(await reviewed());
    fixture.metadataDrift = true;
    const status = await fixture.service.status({ appId: 'app', transactionId: retired.transactionId });
    return { appId: 'app', transactionId: retired.transactionId, journalDigest: status.journalDigest };
  };
  it('restores originals only through a separately approved metadata proof and preserves the immutable baseline', async () => {
    const input = await interruptedMetadata();
    expect(await fixture.service.restore(input)).toMatchObject({ ok: false, reason: 'source-content-or-identity-changed:working' });
    const prepared = await fixture.service.reviewMetadataRestore(input);
    expect(prepared).toMatchObject({ ok: true, review: { mode: 'restore-metadata-only', changeCounts: { residualCompressionRemoved: 3 } } });
    const restored = await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } });
    expect(restored).toMatchObject({ ok: true, restored: true, phase: 'restored-with-metadata-transitions', archivesRetained: true });
    expect(fixture.placement).toEqual({ working: 'original', administration: 'original' });
    expect(fixture.cut).toBeNull();
    expect(fixture.headExists).toBe(true);
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    const dir = join(root, input.transactionId);
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe('{}');
    const journals = (await readdir(dir)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    const last = JSON.parse(await readFile(join(dir, journals.at(-1)), 'utf8'));
    expect(last.metadataRestoreReview.metadataRecovery.digest).toBe(fixture.metadataToken);
    expect(last.metadataRestoreObservations).toHaveLength(2);
  });
  it('refuses changed metadata approval or a missing existing reservation before restoring', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.metadataToken = '9'.repeat(64);
    const before = fixture.deps.native.mock.calls.filter(([v]) => v.command === 'move').length;
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'metadata-recovery-review-changed' });
    expect(fixture.deps.native.mock.calls.filter(([v]) => v.command === 'move')).toHaveLength(before);
    fixture.cut = null;
    expect(await fixture.service.reviewMetadataRestore(input)).toMatchObject({ ok: false, recoveryRequired: true });
    expect(fixture.deps.admission.reserveCheckoutRetirement).toHaveBeenCalledTimes(1);
  });
  it('requires a new journal-bound review after a metadata restore interruption', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.failRestorePart = 'working';
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'restore-interrupted' });
    expect(fixture.cut).not.toBeNull();
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    expect(await restarted.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-journal-changed' });
    const status = await restarted.status(input);
    const fresh = { ...input, journalDigest: status.journalDigest };
    const second = await restarted.reviewMetadataRestore(fresh);
    fixture.failRestorePart = null;
    expect(await restarted.restoreMetadata({ ...fresh, review: { digest: second.review.digest } }))
      .toMatchObject({ ok: true, restored: true });
    expect(fixture.cut).toBeNull();
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('rechecks current ownership before each metadata restoration move', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.deps.ownership.mockResolvedValueOnce({ ok: true, policy: null })
      .mockResolvedValue({ ok: false, reason: 'active-owner' });
    const before = fixture.deps.native.mock.calls.filter(([v]) => v.command === 'move').length;
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'active-owner' });
    expect(fixture.deps.native.mock.calls.filter(([v]) => v.command === 'move')).toHaveLength(before);
    expect(fixture.cut).not.toBeNull();
  });
  it('retains the reservation when allowed policy changes during final restoration verification', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.deps.ownership.mockResolvedValueOnce({ ok: true, policy: null })
      .mockResolvedValueOnce({ ok: true, policy: null })
      .mockResolvedValueOnce({ ok: true, policy: null })
      .mockResolvedValue({ ok: true, policy: { reason: null, policies: [] } });
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-evidence-changed' });
    expect(fixture.placement).toEqual({ working: 'original', administration: 'original' });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    const status = await fixture.service.status(input);
    expect(status.phase).toBe('metadata-restored-working');
    const fresh = { ...input, journalDigest: status.journalDigest };
    const second = await fixture.service.reviewMetadataRestore(fresh);
    expect(await fixture.service.restoreMetadata({ ...fresh, review: { digest: second.review.digest } }))
      .toMatchObject({ ok: false, reason: 'metadata-recovery-already-restored-use-finalization' });
    expect((await fixture.service.status(input)).journalDigest).toBe(fresh.journalDigest);
    const finalization = await fixture.service.reviewRestoredFinalization(fresh);
    expect(await fixture.service.finalizeRestored({ ...fresh, review: { digest: finalization.review.digest } }))
      .toMatchObject({ ok: true, restored: true });
    expect(fixture.cut).toBeNull();
  });
  it('preserves a partial staged journal without blocking fresh metadata recovery', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.partialNextJournal = true;
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'partial-journal-write' });
    expect(fixture.cut).not.toBeNull();
    const directory = join(root, input.transactionId);
    const partial = (await readdir(directory)).filter(name => name.endsWith('.staging'));
    const fragments = (await Promise.all(partial.map(async name => [name, await readFile(join(directory, name), 'utf8')])))
      .filter(([, text]) => text === '{');
    expect(fragments).toHaveLength(1);
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(status.journalDigest).toBe(input.journalDigest);
    const fresh = await restarted.reviewMetadataRestore(input);
    expect(await restarted.restoreMetadata({ ...input, review: { digest: fresh.review.digest } }))
      .toMatchObject({ ok: true, restored: true });
    expect(await readFile(join(directory, fragments[0][0]), 'utf8')).toBe('{');
    expect(fixture.cut).toBeNull();
  });
  it('never replaces a conflicting canonical journal during metadata recovery', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.conflictNextJournal = true;
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, recoveryRequired: true });
    const directory = join(root, input.transactionId);
    const names = (await readdir(directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    expect(await readFile(join(directory, names.at(-1)), 'utf8')).toBe('concurrent-evidence');
    expect(fixture.placement.working).toBe('quarantined');
    expect(fixture.cut).not.toBeNull();
  });
  it('resumes from a complete journal published just before interruption', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.stopAfterJournalPublication = true;
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'journal-publication-interrupted' });
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(status.phase).toBe('metadata-restore-approved');
    expect(fixture.cut).not.toBeNull();
    expect(await restarted.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-journal-changed' });
    const freshInput = { ...input, journalDigest: status.journalDigest };
    const fresh = await restarted.reviewMetadataRestore(freshInput);
    expect(await restarted.restoreMetadata({ ...freshInput, review: { digest: fresh.review.digest } }))
      .toMatchObject({ ok: true, restored: true });
    expect(fixture.cut).toBeNull();
  });
  const resumedQuarantine = async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    expect(prepared.ok).toBe(true);
    const result = await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } });
    expect(result).toMatchObject({ ok: true, phase: 'quarantined-with-metadata-transitions', branchDeleted: false });
    const status = await fixture.service.status(input);
    return { ...input, journalDigest: status.journalDigest };
  };
  it('retains large quarantine comparisons once and rejects changed patch bytes after approval', async () => {
    const input = await interruptedMetadata();
    let patch = 'private patch "\n界'.repeat(80_000);
    const comparison = fixture.deps.comparison;
    fixture.deps.comparison = async (...args) => {
      const evidence = await comparison(...args);
      return { ...evidence, comparison: { ...evidence.comparison, localPatch: patch } };
    };
    const service = _createInitializedCheckoutRecovery(fixture.deps);
    const prepared = await service.reviewQuarantineResumption(input);
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.localPatch).toBe(patch);
    expect(prepared.review).not.toHaveProperty('safetyEvidence');
    const safety = await fixture.deps.comparison(null, release, prUrl, fixture.snapshot, null, fixture.facts);
    expect(prepared.review.safetyEvidenceDigest).toBe(createHash('sha256').update(JSON.stringify(safety)).digest('hex'));
    expect(JSON.stringify(prepared).split(JSON.stringify(patch).slice(1, -1))).toHaveLength(2);
    const unsigned = { ...prepared.review }; delete unsigned.digest;
    expect(createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')).toBe(prepared.review.digest);
    // Drift after the fresh approval recheck must also be caught by the
    // between-moves safety read, before administration leaves its original path.
    const native = fixture.deps.native.getMockImplementation();
    fixture.deps.native.mockImplementation(async request => {
      const result = await native(request);
      if (request.command === 'verify-quarantine-resumption') patch += 'changed';
      return result;
    });
    expect(await service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-evidence-changed' });
    expect(fixture.placement).toEqual({ working: 'quarantined', administration: 'original' });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.deps.native.mock.calls.some(([row]) => row.command === 'resume-quarantine')).toBe(false);
  });
  it('keeps previously journalled full safety evidence verifiable for a fresh branch review', async () => {
    const input = await resumedQuarantine();
    const directory = join(root, input.transactionId);
    const names = (await readdir(directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    const previous = JSON.parse(await readFile(join(directory, names.at(-1)), 'utf8'));
    // Model an immutable journal produced by the preceding release, including
    // its duplicated safety evidence. The new code must not rewrite this row.
    const accepted = { ...previous.quarantineResumptionReview };
    const safetyEvidence = await fixture.deps.comparison(null, release, prUrl, fixture.snapshot, null, fixture.facts);
    delete accepted.digest;
    delete accepted.safetyEvidenceDigest;
    accepted.safetyEvidence = safetyEvidence;
    const legacy = { ...previous, sequence: previous.sequence + 1,
      previous: createHash('sha256').update(JSON.stringify(previous)).digest('hex'),
      quarantineResumptionReview: { digest: createHash('sha256').update(JSON.stringify(accepted)).digest('hex'), ...accepted } };
    const saved = JSON.stringify(legacy);
    const name = join(directory, `${String(legacy.sequence).padStart(6, '0')}.json`);
    await writeFile(name, saved, { mode: 0o600, flag: 'wx' });
    const response = await _createInitializedCheckoutRecovery(fixture.deps).reviewBranch({
      ...input, journalDigest: createHash('sha256').update(saved).digest('hex'),
    });
    expect(response).toMatchObject({ ok: true, review: { quarantineResumptionReview: legacy.quarantineResumptionReview } });
    expect(await readFile(name, 'utf8')).toBe(saved);
  });
  it('resumes only administration quarantine under a fresh purpose-bound review, then requires a separate branch approval', async () => {
    const input = await interruptedMetadata();
    const moves = fixture.deps.native.mock.calls.filter(([row]) => row.command === 'move').length;
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    expect(prepared).toMatchObject({ ok: true, review: { mode: 'resume-initialized-quarantine', initialPlacements: { working: 'quarantine', administration: 'original' } } });
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: true, originalsQuarantined: true, branchDeleted: false });
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'move')).toHaveLength(moves);
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'resume-quarantine')).toHaveLength(1);
    expect(fixture.cut).toBeNull();
    expect(fixture.headExists).toBe(true);
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(await fixture.service.status(input)).toMatchObject({ quarantineResumptionComplete: true });
    const status = await fixture.service.status(input);
    const branchInput = { ...input, journalDigest: status.journalDigest };
    const branch = await fixture.service.reviewBranch(branchInput);
    expect(branch).toMatchObject({ ok: true, review: { quarantineResumptionReview: { digest: prepared.review.digest } } });
    expect(await fixture.service.retireBranch({ ...branchInput, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(await fixture.service.retireBranch({ ...branchInput, review: { digest: branch.review.digest } })).toMatchObject({ ok: true, branchDeleted: true });
    expect(fixture.deps.native).toHaveBeenCalledWith(expect.objectContaining({ command: 'verify-completed-quarantine' }));
  });
  it.each(['delta', 'owner', 'ref', 'holder', 'cut', 'archive', 'metadata', 'forge', 'default'])('retains quarantine and its cut when reviewed %s evidence changes', async change => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    if (change === 'delta') fixture.quarantineToken = '4'.repeat(64);
    if (change === 'owner') fixture.deps.ownership.mockResolvedValue({ ok: false, reason: 'active-owner' });
    if (change === 'ref') fixture.headExists = false;
    if (change === 'holder') fixture.newHolder = true;
    if (change === 'cut') fixture.cut.owner.id = 'foreign';
    if (change === 'archive') fixture.failArchive = true;
    if (change === 'metadata') fixture.forbiddenMetadata = true;
    if (change === 'forge') fixture.facts.prHead = '9'.repeat(40);
    if (change === 'default') fixture.facts.defaultHead = '8'.repeat(40);
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } })).toMatchObject({ ok: false, recoveryRequired: true });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.placement).toEqual({ working: 'quarantined', administration: 'original' });
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'resume-quarantine')).toHaveLength(0);
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('requires fresh explicit supersession acceptance for quarantine resumption', async () => {
    const input = await interruptedMetadata();
    fixture.superseded = true;
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-supersession-not-accepted' });
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest, acceptSuperseded: true } }))
      .toMatchObject({ ok: true });
  });
  it('does not accept restoration evidence or restoration phases for quarantine resumption', async () => {
    const input = await interruptedMetadata();
    const restoration = await fixture.service.reviewMetadataRestore(input);
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: restoration.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    fixture.failRestorePart = 'working';
    await fixture.service.restoreMetadata({ ...input, review: { digest: restoration.review.digest } });
    const status = await fixture.service.status(input);
    expect(await fixture.service.reviewQuarantineResumption({ ...input, journalDigest: status.journalDigest }))
      .toMatchObject({ ok: false, reason: 'quarantine-resumption-phase-not-ready' });
  });
  it.each(['move', 'result', 'delta'])('requires a new review after quarantine %s interruption and never repeats a completed rename', async failure => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    fixture.failResume = failure === 'move';
    fixture.failResumeResult = failure === 'result';
    fixture.resumeDelta = failure === 'delta';
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } })).toMatchObject({ ok: false });
    const status = await fixture.service.status(input);
    const retry = { ...input, journalDigest: status.journalDigest };
    expect(await fixture.service.resumeQuarantine({ ...retry, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    fixture.failResume = fixture.failResumeResult = fixture.resumeDelta = false;
    const fresh = await fixture.service.reviewQuarantineResumption(retry);
    const calls = fixture.deps.native.mock.calls.filter(([row]) => row.command === 'resume-quarantine').length;
    expect(await fixture.service.resumeQuarantine({ ...retry, review: { digest: fresh.review.digest } })).toMatchObject({ ok: true });
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'resume-quarantine')).toHaveLength(calls + (failure === 'move' ? 1 : 0));
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('never moves after interrupted publication of a resumption approval and requires a new digest', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    fixture.stopAfterJournalPublication = true;
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'journal-publication-interrupted' });
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'resume-quarantine')).toHaveLength(0);
    const status = await fixture.service.status(input);
    expect(status.phase).toBe('quarantine-resumption-approved');
    expect(await fixture.service.resumeQuarantine({ ...input, journalDigest: status.journalDigest, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(fixture.cut).not.toBeNull();
  });
  it('requires a fresh terminal quarantine review for interrupted cut release and never recreates a released cut', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    fixture.deps.admission.releaseCheckoutReservation.mockRejectedValueOnce(new Error('release-ack-lost'));
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } })).toMatchObject({ ok: false });
    const status = await fixture.service.status(input);
    expect(status.phase).toBe('quarantined-with-metadata-transitions');
    const retry = { ...input, journalDigest: status.journalDigest };
    expect(await fixture.service.resumeQuarantine({ ...retry, review: { digest: prepared.review.digest } })).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    const next = await fixture.service.reviewQuarantineResumption(retry);
    const calls = fixture.deps.native.mock.calls.filter(([row]) => row.command === 'resume-quarantine').length;
    expect(await fixture.service.resumeQuarantine({ ...retry, review: { digest: next.review.digest } })).toMatchObject({ ok: true });
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'resume-quarantine')).toHaveLength(calls);
    const finished = await fixture.service.status(input);
    expect(await fixture.service.reviewQuarantineResumption({ ...input, journalDigest: finished.journalDigest })).toMatchObject({ ok: false });
    expect(fixture.deps.admission.reserveCheckoutRetirement).toHaveBeenCalledTimes(1);
  });
  it('rechecks forge and ownership after native quarantine verification before releasing the cut', async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewQuarantineResumption(input);
    const original = fixture.deps.native.getMockImplementation();
    fixture.deps.native.mockImplementation(async value => {
      const result = await original(value);
      if (value.command === 'verify-completed-quarantine') fixture.facts.defaultHead = '8'.repeat(40);
      return result;
    });
    expect(await fixture.service.resumeQuarantine({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-evidence-changed' });
    expect(fixture.cut).not.toBeNull();
  });
  it('verifies full transitioned sources on confirmed-deletion receipt replay without Git writes', async () => {
    const input = await resumedQuarantine();
    const prepared = await fixture.service.reviewBranch(input);
    fixture.deps.recordRetirement.mockRejectedValueOnce(new Error('receipt-interrupted'));
    expect(await fixture.service.retireBranch({ ...input, review: { digest: prepared.review.digest } })).toMatchObject({ ok: false });
    const status = await fixture.service.status(input);
    expect(status).toMatchObject({ phase: 'branch-retired', branchDeleted: true });
    const retry = { ...input, journalDigest: status.journalDigest };
    fixture.forbiddenMetadata = true;
    expect(await fixture.service.retireBranch(retry)).toMatchObject({ ok: false, reason: 'metadata-delta-not-eligible' });
    expect(fixture.cut).not.toBeNull();
    fixture.forbiddenMetadata = false;
    expect(await fixture.service.retireBranch(retry)).toMatchObject({ ok: true, receiptRecorded: true });
    expect(fixture.deps.native).toHaveBeenCalledWith(expect.objectContaining({ command: 'verify-retired-quarantine',
      confirmedDeletion: { journalDigest: status.journalDigest, branch: release.branch, head: release.head, phase: 'branch-retired' } }));
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
  });
  it.each(['source', 'archive', 'ref', 'holder', 'cut'])('refuses changed %s during a completed quarantine receipt replay', async change => {
    const input = await resumedQuarantine();
    const prepared = await fixture.service.reviewBranch(input);
    fixture.deps.recordRetirement.mockRejectedValueOnce(new Error('receipt-interrupted'));
    await fixture.service.retireBranch({ ...input, review: { digest: prepared.review.digest } });
    const status = await fixture.service.status(input);
    if (change === 'source') fixture.quarantineToken = '3'.repeat(64);
    if (change === 'archive') fixture.failArchive = true;
    if (change === 'ref') fixture.headExists = true;
    if (change === 'holder') fixture.newHolder = true;
    if (change === 'cut') fixture.cut.owner.id = 'another-owner';
    expect(await fixture.service.retireBranch({ ...input, journalDigest: status.journalDigest })).toMatchObject({ ok: false });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('reverifies retired quarantine after uncertain release without deleting again, cutReleased=%s', async released => {
    const input = await resumedQuarantine();
    const prepared = await fixture.service.reviewBranch(input);
    fixture.deps.admission.releaseCheckoutReservation.mockImplementationOnce(async () => {
      if (released) fixture.cut = null;
      throw new Error('release-ack-lost');
    });
    expect(await fixture.service.retireBranch({ ...input, review: { digest: prepared.review.digest } })).toMatchObject({ ok: false });
    const status = await fixture.service.status(input);
    expect(status).toMatchObject({ phase: 'retired', branchDeleted: true });
    const before = fixture.deps.native.mock.calls.length;
    expect(await fixture.service.retireBranch({ ...input, journalDigest: status.journalDigest })).toMatchObject({ ok: true, receiptRecorded: true });
    expect(fixture.deps.native.mock.calls.slice(before).map(([row]) => row.command)).toEqual(['lock', 'verify-retired-quarantine', 'verify-deleted-branch']);
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(1);
    expect(fixture.cut).toBeNull();
  });
  it('never promotes absent-ref quarantine deletion intent to success', async () => {
    const input = await resumedQuarantine();
    const prepared = await fixture.service.reviewBranch(input);
    fixture.deps.deleteRef.mockImplementationOnce(async (_repo, _branch, _head, options) => { await options.beforeMutation(); fixture.headExists = false; throw new Error('receiver-outcome-lost'); });
    await fixture.service.retireBranch({ ...input, review: { digest: prepared.review.digest } });
    const status = await fixture.service.status(input);
    expect(status.phase).toBe('branch-retirement-intent');
    expect(await fixture.service.retireBranch({ ...input, journalDigest: status.journalDigest }))
      .toMatchObject({ ok: false, reason: 'retirement-branch-deletion-uncertain' });
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'verify-retired-quarantine')).toHaveLength(0);
    expect(fixture.cut).not.toBeNull();
  });
  const restoredWithDelayedDrift = async () => {
    const input = await interruptedMetadata();
    const prepared = await fixture.service.reviewMetadataRestore(input);
    fixture.delayedRestoreDrift = true;
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'source-content-or-identity-changed:working' });
    const status = await fixture.service.status(input);
    expect(status.phase).toBe('metadata-restored-working');
    expect(fixture.placement).toEqual({ working: 'original', administration: 'original' });
    return { ...input, journalDigest: status.journalDigest };
  };
  it('preserves completed move evidence when a redundant metadata restore should use finalization', async () => {
    const input = await restoredWithDelayedDrift();
    const previousFinalization = await fixture.service.reviewRestoredFinalization(input);
    const redundant = await fixture.service.reviewMetadataRestore(input);
    expect(redundant).toMatchObject({ ok: true, review: { initialPlacements: { working: 'original', administration: 'original' } } });
    const directory = join(root, input.transactionId);
    const names = (await readdir(directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    const last = join(directory, names.at(-1));
    const previousBytes = await readFile(last, 'utf8');
    const moves = fixture.deps.native.mock.calls.filter(([row]) => row.command === 'move').length;
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: redundant.review.digest } }))
      .toMatchObject({ ok: false, reason: 'metadata-recovery-already-restored-use-finalization' });
    expect((await fixture.service.status(input)).journalDigest).toBe(input.journalDigest);
    expect(await readFile(last, 'utf8')).toBe(previousBytes);
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'move')).toHaveLength(moves);
    expect(await fixture.service.finalizeRestored({ ...input, review: { digest: previousFinalization.review.digest } }))
      .toMatchObject({ ok: true, restored: true });
  });
  it('finalizes a retried restore using only its current observations while retaining earlier immutable evidence', async () => {
    const original = fixture.deps.native.getMockImplementation();
    fixture.deps.native.mockImplementation(async input => {
      const result = await original(input);
      if (input.command === 'move' && input.direction === 'quarantine' && input.part === 'administration') {
        fixture.metadataDrift = true;
      }
      return result;
    });
    const retired = await fixture.service.retire(await reviewed());
    expect(retired).toMatchObject({ ok: false, reason: 'source-content-or-identity-changed:working' });
    expect(fixture.placement).toEqual({ working: 'quarantined', administration: 'quarantined' });
    const status = await fixture.service.status({ appId: 'app', transactionId: retired.transactionId });
    const input = { appId: 'app', transactionId: retired.transactionId, journalDigest: status.journalDigest };
    const firstReview = await fixture.service.reviewMetadataRestore(input);
    fixture.failRestorePart = 'working';
    expect(await fixture.service.restoreMetadata({ ...input, review: { digest: firstReview.review.digest } }))
      .toMatchObject({ ok: false, reason: 'restore-interrupted' });
    expect(fixture.placement).toEqual({ working: 'quarantined', administration: 'original' });
    const directory = join(root, input.transactionId);
    const names = (await readdir(directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    const previousFile = join(directory, names.at(-1));
    const previousBytes = await readFile(previousFile, 'utf8');
    expect(JSON.parse(previousBytes).metadataRestoreObservations)
      .toEqual([{ part: 'administration', proof: expect.objectContaining({ file: 'administration-post-move.json' }) }]);
    const retryStatus = await fixture.service.status(input);
    const retry = { ...input, journalDigest: retryStatus.journalDigest };
    const nextReview = await fixture.service.reviewMetadataRestore(retry);
    fixture.failRestorePart = null;
    fixture.delayedRestoreDrift = true;
    expect(await fixture.service.restoreMetadata({ ...retry, review: { digest: nextReview.review.digest } }))
      .toMatchObject({ ok: false, reason: 'source-content-or-identity-changed:working' });
    const finalStatus = await fixture.service.status(input);
    const finalInput = { ...input, journalDigest: finalStatus.journalDigest };
    const finalReview = await fixture.service.reviewRestoredFinalization(finalInput);
    expect(finalReview).toMatchObject({ ok: true, review: { postMoveObservations: [
      { part: 'administration' }, { part: 'working', proof: { file: 'working-post-move.json' } },
    ] } });
    expect(finalReview.review.postMoveObservations).toHaveLength(2);
    expect(await fixture.service.finalizeRestored({ ...finalInput, review: { digest: finalReview.review.digest } }))
      .toMatchObject({ ok: true, restored: true });
    expect(await readFile(previousFile, 'utf8')).toBe(previousBytes);
    expect(fixture.cut).toBeNull();
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('finalizes already-restored originals only with a new review bound to the actual no-op and move evidence', async () => {
    const input = await restoredWithDelayedDrift();
    const before = fixture.deps.native.mock.calls.filter(([row]) => row.command === 'move').length;
    const prepared = await fixture.service.reviewRestoredFinalization(input);
    expect(prepared).toMatchObject({ ok: true, review: { mode: 'finalize-already-restored',
      postMoveObservations: [{ part: 'administration' }, { part: 'working', proof: { digest: fixture.metadataToken } }] } });
    const result = await fixture.service.finalizeRestored({ ...input, review: { digest: prepared.review.digest } });
    expect(result).toMatchObject({ ok: true, alreadyRestored: true, phase: 'restored-with-reviewed-finalization', archivesRetained: true });
    expect(fixture.cut).toBeNull();
    expect(fixture.headExists).toBe(true);
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.deps.native.mock.calls.filter(([row]) => row.command === 'move')).toHaveLength(before);
    expect(fixture.deps.native).toHaveBeenCalledWith(expect.objectContaining({
      command: 'verify-restored-finalization', postMoveObservations: [null, expect.objectContaining({ file: 'working-post-move.json' })],
    }));
    expect(await readFile(join(root, input.transactionId, 'manifest.json'), 'utf8')).toBe('{}');
    expect(await fixture.service.status(input)).toMatchObject({ restoredFinalizationComplete: true });
  });
  it.each(['delta', 'owner', 'ref', 'holder', 'cut', 'archive'])('retains the cut when finalization %s evidence changes', async change => {
    const input = await restoredWithDelayedDrift();
    const prepared = await fixture.service.reviewRestoredFinalization(input);
    if (change === 'delta') fixture.finalizationToken = '8'.repeat(64);
    if (change === 'owner') fixture.deps.ownership.mockResolvedValue({ ok: false, reason: 'active-owner' });
    if (change === 'ref') fixture.headExists = false;
    if (change === 'holder') fixture.newHolder = true;
    if (change === 'cut') fixture.cut.owner.id = 'different-owner';
    if (change === 'archive') fixture.failArchive = true;
    const releases = fixture.deps.admission.releaseCheckoutReservation.mock.calls.length;
    expect(await fixture.service.finalizeRestored({ ...input, review: { digest: prepared.review.digest } })).toMatchObject({ ok: false, recoveryRequired: true });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.deps.admission.releaseCheckoutReservation).toHaveBeenCalledTimes(releases);
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('requires a new finalization approval after a durable approved phase is interrupted', async () => {
    const input = await restoredWithDelayedDrift();
    const prepared = await fixture.service.reviewRestoredFinalization(input);
    fixture.failFinalization = true;
    expect(await fixture.service.finalizeRestored({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'finalization-evidence-changed' });
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(status.phase).toBe('restored-finalization-approved');
    expect(await restarted.finalizeRestored({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'retirement-journal-changed' });
    const fresh = { ...input, journalDigest: status.journalDigest };
    expect(await restarted.finalizeRestored({ ...fresh, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'restored-finalization-review-changed' });
    fixture.failFinalization = false;
    const next = await restarted.reviewRestoredFinalization(fresh);
    expect(await restarted.finalizeRestored({ ...fresh, review: { digest: next.review.digest } })).toMatchObject({ ok: true });
  });
  it.each([false, true])('replays only final proof and release after uncertain release, cutAlreadyReleased=%s', async released => {
    const input = await restoredWithDelayedDrift();
    const prepared = await fixture.service.reviewRestoredFinalization(input);
    fixture.deps.admission.releaseCheckoutReservation.mockImplementationOnce(async () => {
      if (released) fixture.cut = null;
      throw new Error('release-acknowledgement-lost');
    });
    expect(await fixture.service.finalizeRestored({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'release-acknowledgement-lost' });
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(status.phase).toBe('restored-with-reviewed-finalization');
    const commands = fixture.deps.native.mock.calls.length;
    expect(await restarted.finalizeRestored({ ...input, journalDigest: status.journalDigest, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: true, alreadyRestored: true });
    expect(fixture.deps.native.mock.calls.slice(commands).map(([row]) => row.command)).toEqual(['lock', 'verify-restored-finalization']);
    expect(fixture.cut).toBeNull();
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('rechecks ownership after final native verification and retains the reservation on a new owner', async () => {
    const input = await restoredWithDelayedDrift();
    const prepared = await fixture.service.reviewRestoredFinalization(input);
    const original = fixture.deps.native.getMockImplementation();
    fixture.deps.native.mockImplementation(async value => {
      const result = await original(value);
      if (value.command === 'verify-restored-finalization') fixture.deps.ownership.mockResolvedValue({ ok: false, reason: 'active-owner' });
      return result;
    });
    expect(await fixture.service.finalizeRestored({ ...input, review: { digest: prepared.review.digest } }))
      .toMatchObject({ ok: false, reason: 'active-owner' });
    expect(fixture.cut).not.toBeNull();
  });
  it('exposes only source-verified cancellation after durable preservation loses its proof journal', async () => {
    fixture.failProofJournal = true;
    const result = await fixture.service.retire(await reviewed());
    expect(result).toMatchObject({ ok: false, reason: 'journal-write-interrupted', recoveryRequired: true });
    const directory = join(root, result.transactionId);
    expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe('{}');
    expect(fixture.cut).not.toBeNull();
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status({ appId: 'app', transactionId: result.transactionId });
    expect(status).toMatchObject({ phase: 'reserved', placement: { preserved: false, unverifiedArchive: true },
      recoveryRequired: true, recoveryAction: 'restore', reason: 'preservation-proof-unbound' });
    expect(status.journalDigest).toMatch(/^[a-f0-9]{64}$/);
    const input = { appId: 'app', transactionId: result.transactionId, journalDigest: status.journalDigest };
    await expect(restarted.verifyArchive(input)).rejects.toThrow('archive-manifest-proof-changed');
    const oldSnapshot = fixture.snapshot;
    fixture.snapshot = { ...oldSnapshot, fingerprint: 'f'.repeat(64) };
    expect(await restarted.restore(input)).toMatchObject({ ok: false, reason: 'retirement-source-changed' });
    expect(fixture.cut).not.toBeNull();
    fixture.snapshot = oldSnapshot;
    fixture.deps.admission.releaseCheckoutReservation.mockRejectedValueOnce(new Error('release-interrupted'));
    expect(await restarted.restore(input)).toMatchObject({ ok: false, reason: 'release-interrupted' });
    expect(fixture.cut).not.toBeNull();
    const afterReleaseFailure = _createInitializedCheckoutRecovery(fixture.deps);
    const cancelled = await afterReleaseFailure.status(input);
    expect(cancelled).toMatchObject({ phase: 'restored', placement: { preserved: false, unverifiedArchive: true } });
    expect(await afterReleaseFailure.restore({ ...input, journalDigest: cancelled.journalDigest }))
      .toMatchObject({ ok: true, restored: true, archivesRetained: true });
    expect(fixture.cut).toBeNull();
    expect(fixture.placement).toEqual({ working: 'original', administration: 'original' });
    expect(fixture.deps.native.mock.calls.some(([call]) => call.command === 'move' || call.command === 'status')).toBe(false);
    expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe('{}');
    const completed = await restarted.status({ appId: 'app', transactionId: result.transactionId });
    expect(completed).toMatchObject({ phase: 'restored', placement: { preserved: false, unverifiedArchive: true } });
    expect(completed.recoveryRequired).toBeUndefined();
    expect(fixture.deps.native.mock.calls.some(([call]) => call.command === 'status')).toBe(false);
  });
  it('requires a fresh accepted review and an explicit supersession decision', async () => {
    const input = await reviewed();
    fixture.facts.defaultHead = 'e'.repeat(40);
    expect(await fixture.service.retire(input)).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(fixture.deps.admission.reserveCheckoutRetirement).not.toHaveBeenCalled();
    fixture.superseded = true;
    const superseded = await reviewed(); superseded.review.acceptSuperseded = false;
    expect(await fixture.service.retire(superseded)).toMatchObject({ ok: false, reason: 'retirement-supersession-not-accepted' });
  });
  it('rechecks ownership after preservation before any move', async () => {
    const input = await reviewed();
    fixture.deps.ownership.mockImplementation(async () => ({ ok: !fixture.deps.native.mock.calls.some(([v]) => v.command === 'preserve'), policy: null, reason: 'active-owner' }));
    expect(await fixture.service.retire(input)).toMatchObject({ ok: false, reason: 'active-owner', recoveryRequired: true });
    expect(fixture.deps.native.mock.calls.some(([v]) => v.command === 'move')).toBe(false);
    expect(fixture.cut).not.toBeNull();
  });
  it('refuses stale recovery digest, a new holder, or changed rollback ref without moving originals', async () => {
    const result = await fixture.service.retire(await reviewed());
    const status = await fixture.service.status({ appId: 'app', transactionId: result.transactionId });
    const input = { appId: 'app', transactionId: result.transactionId, journalDigest: status.journalDigest };
    expect(await fixture.service.restore({ ...input, journalDigest: 'f'.repeat(64) })).toMatchObject({ ok: false, reason: 'retirement-journal-changed' });
    fixture.newHolder = true;
    expect(await fixture.service.restore(input)).toMatchObject({ ok: false, reason: 'branch-has-new-holder' });
    fixture.newHolder = false;
    fixture.deps.execGit.mockResolvedValue({ exitCode: 1, stdout: '' });
    expect(await fixture.service.restore(input)).toMatchObject({ ok: false, reason: 'branch-ref-changed' });
    expect(fixture.placement).toEqual({ working: 'quarantined', administration: 'quarantined' });
  });
  it('verifies standalone recovery independently after the live branch is unavailable', async () => {
    const result = await fixture.service.retire(await reviewed());
    const status = await fixture.service.status({ appId: 'app', transactionId: result.transactionId });
    fixture.deps.execGit.mockResolvedValue({ exitCode: 1, stdout: '' });
    const input = { appId: 'app', transactionId: result.transactionId, journalDigest: status.journalDigest };
    expect(await fixture.service.verifyArchive(input)).toMatchObject({ ok: true, verified: true });
    expect(fixture.deps.native).toHaveBeenLastCalledWith({ command: 'verify', manifestSha256: 'e'.repeat(64), transactionDir: join(root, result.transactionId), mode: 'standalone' });
    expect(fixture.deps.execGit).not.toHaveBeenCalled();
  });
  const quarantinedReview = async () => {
    const result = await fixture.service.retire(await reviewed());
    const status = await fixture.service.status({ appId: 'app', transactionId: result.transactionId });
    const bound = { appId: 'app', transactionId: result.transactionId, journalDigest: status.journalDigest };
    const response = await fixture.service.reviewBranch(bound);
    expect(response.ok).toBe(true);
    return { ...bound, review: { prUrl, digest: response.review.digest, acceptSuperseded: fixture.superseded === true } };
  };
  it('finishes a quarantined branch with a new exact review and records the source checkout receipt', async () => {
    const input = await quarantinedReview();
    const result = await fixture.service.retireBranch(input);
    expect(result).toMatchObject({ ok: true, branchDeleted: true, receiptRecorded: true });
    expect(fixture.deps.deleteRef).toHaveBeenCalledWith('/fixture/repo', release.branch, release.head, { beforeMutation: expect.any(Function) });
    expect(fixture.deps.recordRetirement).toHaveBeenCalledWith('app', { path: release.path, branch: release.branch,
      head: release.head, branchDeleted: true, archiveDir: join(root, input.transactionId) });
    expect(fixture.cut).toBeNull();
    expect((await fixture.service.status(input)).phase).toBe('retired');
  });
  it('invalidates branch finalization when the default advances or a holder appears', async () => {
    const input = await quarantinedReview();
    fixture.facts.defaultHead = 'e'.repeat(40);
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    fixture.newHolder = true;
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'branch-has-new-holder' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('requires explicit fresh supersession acceptance and complete archive proof for branch finalization', async () => {
    fixture.superseded = true;
    const input = await quarantinedReview(); input.review.acceptSuperseded = false;
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'retirement-supersession-not-accepted' });
    fixture.failArchive = true;
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'archive-changed' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('retains the delete intent and reports uncertainty after deletion without a journal outcome', async () => {
    const input = await quarantinedReview();
    fixture.deps.deleteRef.mockImplementation(async (_repo, _branch, _head, options) => { await options.beforeMutation(); fixture.headExists = false; throw new Error('receiver-result-lost'); });
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'receiver-result-lost', recoveryRequired: true });
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(status).toMatchObject({ phase: 'branch-retirement-intent', branchDeletion: 'uncertain', branchRef: 'absent', recoveryRequired: true });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
    expect(await restarted.retireBranch({ ...input, journalDigest: status.journalDigest }))
      .toMatchObject({ ok: false, reason: 'retirement-branch-deletion-uncertain' });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.execGit.mock.calls.some(([args]) => args[0] === 'update-ref')).toBe(false);
  });
  it('preserves the completed deletion obligation when recording the schedule receipt fails', async () => {
    const input = await quarantinedReview();
    fixture.deps.recordRetirement.mockRejectedValue(new Error('receipt-disk-full'));
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'receipt-disk-full' });
    expect(await fixture.service.status(input)).toMatchObject({ phase: 'branch-retired', branchDeleted: true, receiptPending: true, recoveryRequired: true });
    expect(fixture.cut).not.toBeNull();
  });
  it('replays a conclusively completed deletion receipt after restart without another Git mutation', async () => {
    const input = await quarantinedReview();
    fixture.deps.recordRetirement.mockRejectedValueOnce(new Error('receipt-disk-full'));
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false });
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(await restarted.retireBranch({ ...input, journalDigest: status.journalDigest }))
      .toMatchObject({ ok: true, branchDeleted: true, receiptRecorded: true });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(2);
    expect(fixture.cut).toBeNull();
  });
  it('releases the retained cut after receipt completion and is idempotent once released', async () => {
    const input = await quarantinedReview();
    fixture.deps.admission.releaseCheckoutReservation.mockRejectedValueOnce(new Error('cut-release-interrupted'));
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'cut-release-interrupted' });
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(status.phase).toBe('retired');
    expect(fixture.cut).not.toBeNull();
    const replay = { ...input, journalDigest: status.journalDigest };
    expect(await restarted.retireBranch(replay)).toMatchObject({ ok: true });
    expect(fixture.cut).toBeNull();
    expect(await restarted.retireBranch(replay)).toMatchObject({ ok: true });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(1);
  });
  it.each(['headExists', 'newHolder', 'failArchive'])('retains receipt recovery on fresh %s conflict', async conflict => {
    const input = await quarantinedReview();
    fixture.deps.recordRetirement.mockRejectedValueOnce(new Error('receipt-disk-full'));
    await fixture.service.retireBranch(input);
    const status = await fixture.service.status(input);
    fixture[conflict] = true;
    expect(await fixture.service.retireBranch({ ...input, journalDigest: status.journalDigest }))
      .toMatchObject({ ok: false, recoveryRequired: true });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(1);
  });
  it.each(['deleted-branch-loose-path-occupied', 'deleted-branch-parent-unsafe', 'deleted-branch-packed-refs-invalid'])('preserves legacy receipt recovery when native ref absence refuses: %s', async conflict => {
    const input = await quarantinedReview();
    fixture.deps.recordRetirement.mockRejectedValueOnce(new Error('receipt-interrupted'));
    await fixture.service.retireBranch(input);
    const status = await fixture.service.status(input);
    expect(status).toMatchObject({ phase: 'branch-retired', branchDeleted: true });
    fixture.deletedRefConflict = conflict;
    const result = await fixture.service.retireBranch({ ...input, journalDigest: status.journalDigest });
    expect(result).toMatchObject({ ok: false, reason: conflict });
    expect(fixture.cut).not.toBeNull();
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(1);
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect((await fixture.service.status(input)).journalDigest).toBe(status.journalDigest);
    expect(fixture.deps.native).toHaveBeenCalledWith(expect.objectContaining({ command: 'verify-deleted-branch',
      confirmedDeletion: { journalDigest: status.journalDigest, branch: release.branch, head: release.head, phase: 'branch-retired' } }));
  });
  it('does not duplicate receipts or refresh their timestamps when the sink succeeded before journal failure', async () => {
    const input = await quarantinedReview();
    const { recordHeldCheckoutRetirement, recordBranchReconcileOutcome } = await import('./taskSchedule.js');
    persisted.json = JSON.stringify({ executions: { 'task:branch-reconcile': { perApp: { app: {
      branchReconcileOutcome: { remaining: [release], retired: Array.from({ length: 20 }, (_, index) => ({
        path: `/other/${index}`, archiveDir: `/archives/${index}`, retiredAt: '2020-01-01T00:00:00.000Z',
      })) },
    } } } } });
    fixture.deps.recordRetirement.mockImplementationOnce(async (...args) => {
      await recordHeldCheckoutRetirement(...args);
      fixture.failNextJournal = true;
    }).mockImplementation(recordHeldCheckoutRetirement);
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'journal-write-interrupted' });
    // Evict the original from the 20-row display ring before replay.
    for (let index = 0; index < 20; index++) await recordHeldCheckoutRetirement('app', {
      path: `/later/${index}`, branch: `later/${index}`, head: 'f'.repeat(40),
      branchDeleted: true, archiveDir: `/later-archives/${index}`,
    });
    const newer = { ...release, reason: 'retirement-review-pending' };
    await recordBranchReconcileOutcome('app', { status: 'actionable', remaining: [newer] });
    const saved = JSON.parse(persisted.json);
    const outcome = saved.executions['task:branch-reconcile'].perApp.app.branchReconcileOutcome;
    const originalReceipts = structuredClone(outcome.retired);
    const originalIdentities = structuredClone(outcome.retirementReceiptIdentities);
    expect(originalReceipts.some(receipt => receipt.path === release.path)).toBe(false);
    const currentInventory = structuredClone(outcome.remaining);
    const currentObligations = structuredClone(outcome.retirementObligations);
    expect(currentObligations).toHaveLength(1);
    expect(Number.isFinite(Date.parse(currentObligations[0].createdAt))).toBe(true);
    const restarted = _createInitializedCheckoutRecovery(fixture.deps);
    const status = await restarted.status(input);
    expect(await restarted.retireBranch({ ...input, journalDigest: status.journalDigest })).toMatchObject({ ok: true });
    const replayed = JSON.parse(persisted.json).executions['task:branch-reconcile'].perApp.app.branchReconcileOutcome;
    expect(replayed.retired).toEqual(originalReceipts);
    expect(replayed.retirementReceiptIdentities).toEqual(originalIdentities);
    expect(replayed.remaining).toEqual(currentInventory);
    expect(replayed.retirementObligations).toEqual(currentObligations);
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.cut).toBeNull();
  });
  it('keeps a recreated checkout generation pending on old receipt replay and accepts its own new archive', async () => {
    const { recordHeldCheckoutRetirement, recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./taskSchedule.js');
    persisted.json = JSON.stringify({ executions: {} });
    const pending = { ...release, reason: 'retirement-review-pending' };
    const first = await recordBranchReconcileOutcome('app', { status: 'actionable', remaining: [pending] });
    const firstCreated = first.retirementObligations[0].createdAt;
    const receipt = { ...release, branchDeleted: true, archiveDir: '/archive/original' };
    const retired = await recordHeldCheckoutRetirement('app', receipt);
    expect(retired.retirementObligations).toEqual([]);
    expect(retired.remaining).toEqual([]);
    const originalTimestamp = retired.retired[0].retiredAt;
    const recreated = await recordBranchReconcileOutcome('app', { status: 'actionable', remaining: [pending] });
    const generation = recreated.retirementObligations[0].createdAt;
    expect(Date.parse(generation)).toBeGreaterThan(Date.parse(originalTimestamp));
    expect(Date.parse(generation)).toBeGreaterThanOrEqual(Date.parse(firstCreated));
    await recordHeldCheckoutRetirement('app', receipt);
    expect(await getBranchReconcileOutcome('app')).toEqual(recreated);
    // The fresh archive is a different retirement identity, with evidence later
    // than this server-created generation. The old archive remains untouched.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(generation) + 1);
      const completed = await recordHeldCheckoutRetirement('app', { ...receipt, archiveDir: '/archive/new-generation' });
      expect(completed.retirementObligations).toEqual([]);
      expect(completed.remaining).toEqual([]);
      expect(completed.retired.find(row => row.archiveDir === receipt.archiveDir).retiredAt).toBe(originalTimestamp);
      expect(Object.keys(completed.retirementReceiptIdentities)).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it.each(['quarantined', 'branch-retired'])('rechecks the journal after executor acquisition in %s', async phase => {
    let input = await quarantinedReview();
    if (phase === 'branch-retired') {
      fixture.deps.recordRetirement.mockRejectedValueOnce(new Error('receipt-pending'));
      await fixture.service.retireBranch(input);
      input = { ...input, journalDigest: (await fixture.service.status(input)).journalDigest };
    }
    const directory = join(root, input.transactionId);
    const invoke = fixture.deps.native.getMockImplementation();
    fixture.deps.native.mockImplementation(async request => {
      if (request.command === 'lock') {
        const files = (await readdir(directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
        const previous = JSON.parse(await readFile(join(directory, files.at(-1)), 'utf8'));
        const next = { ...previous, sequence: previous.sequence + 1,
          previous: createHash('sha256').update(JSON.stringify(previous)).digest('hex') };
        await writeFile(join(directory, `${String(next.sequence).padStart(6, '0')}.json`), JSON.stringify(next), { mode: 0o600 });
      }
      return invoke(request);
    });
    const deletes = fixture.deps.deleteRef.mock.calls.length;
    const receipts = fixture.deps.recordRetirement.mock.calls.length;
    expect(await fixture.service.retireBranch(input)).toMatchObject({ ok: false, reason: 'retirement-journal-changed' });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(deletes);
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(receipts);
  });
  it('holds if immutable journal history is changed', async () => {
    const result = await fixture.service.retire(await reviewed());
    const first = join(root, result.transactionId, '000000.json');
    const value = JSON.parse(await readFile(first, 'utf8')); value.repoPath = '/different';
    await writeFile(first, JSON.stringify(value));
    await expect(fixture.service.status({ appId: 'app', transactionId: result.transactionId })).rejects.toThrow('retirement-journal-invalid');
  });
});

// These exercise persisted journal discovery through the actual service
// continuation, not a synthetic phase-to-command mapping.
describe('automatic initialized retirement continuation', () => {
  const automaticInput = async () => {
    const result = await fixture.service.discover();
    expect(result.ok).toBe(true);
    expect(result.transactions).toHaveLength(1);
    const row = result.transactions[0];
    expect(row.reason).toBeUndefined();
    return { appId: row.appId, transactionId: row.transactionId, journalDigest: row.journalDigest };
  };
  const permitted = { blocked: async () => null };
  const interrupted = async () => {
    fixture.failPart = 'administration';
    expect(await fixture.service.retire(await reviewed())).toMatchObject({ ok: false, recoveryRequired: true });
    fixture.failPart = null;
    fixture.service = _createInitializedCheckoutRecovery(fixture.deps);
    return automaticInput();
  };
  it('discovers after restart and finishes archive-backed quarantine plus a separate fresh branch retirement', async () => {
    const input = await interrupted();
    const originalReservation = structuredClone(fixture.cut);
    await expect(fixture.deps.admission.withCheckoutPublication('/fixture/repo', () => {}))
      .rejects.toThrow('checkout-retirement-reserved');
    const before = fixture.deps.native.mock.calls.length;
    expect(await fixture.service.recoverAutomatically(input, permitted))
      .toMatchObject({ ok: true, branchDeleted: true, receiptRecorded: true });
    expect(fixture.deps.admission.releaseCheckoutReservation.mock.calls[0][0]).toEqual(originalReservation);
    expect(fixture.placement).toEqual({ working: 'quarantined', administration: 'quarantined' });
    expect(fixture.deps.native.mock.calls.slice(before).some(([arg]) => ['inspect', 'preserve', 'move'].includes(arg.command))).toBe(false);
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.recordRetirement).toHaveBeenCalledTimes(1);
    expect(fixture.cut).toBeNull();
  });
  it('finishes the plain quarantined journal left before releasing its exact reservation', async () => {
    fixture.deps.admission.releaseCheckoutReservation.mockRejectedValueOnce(new Error('release-interrupted'));
    const result = await fixture.service.retire(await reviewed());
    expect(result).toMatchObject({ ok: false, reason: 'release-interrupted' });
    expect((await fixture.service.status({ appId: 'app', transactionId: result.transactionId })).phase).toBe('quarantined');
    const moves = fixture.deps.native.mock.calls.filter(([arg]) => arg.command === 'move').length;
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: true, receiptRecorded: true });
    expect(fixture.deps.native.mock.calls.filter(([arg]) => arg.command === 'move')).toHaveLength(moves);
    expect(fixture.deps.native.mock.calls.some(([arg]) => arg.command === 'resume-quarantine')).toBe(false);
  });
  it.each(['superseded', 'different-pr-head', 'unknown-metadata', 'active-owner', 'new-holder', 'archive-changed', 'executor-busy', 'reservation-changed'])(
    'retains the original reservation and all sources when fresh evidence is %s', async cause => {
      const input = await interrupted();
      if (cause === 'superseded') fixture.superseded = true;
      if (cause === 'different-pr-head') fixture.facts.prHead = '9'.repeat(40);
      if (cause === 'unknown-metadata') fixture.forbiddenMetadata = true;
      if (cause === 'active-owner') fixture.deps.ownership.mockResolvedValue({ ok: false, reason: 'active-owner' });
      if (cause === 'new-holder') fixture.newHolder = true;
      if (cause === 'archive-changed') fixture.failArchive = true;
      if (cause === 'executor-busy') fixture.deps.native.mockImplementationOnce(async () => { throw new Error('retirement-executor-busy'); });
      if (cause === 'reservation-changed') fixture.cut.owner.id = 'other-transaction';
      expect(await fixture.service.recoverAutomatically(input, permitted)).toMatchObject({ ok: false });
      expect(fixture.cut).not.toBeNull();
      expect(fixture.placement.administration).toBe('original');
      expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
      expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
    });
  it.each(['pause', 'default', 'owner'])('rechecks %s after preparing a review and before the remaining move', async changed => {
    const input = await interrupted();
    let gates = 0;
    const blocked = async () => {
      if (++gates !== 2) return null;
      if (changed === 'pause') return 'daemon-paused';
      if (changed === 'default') fixture.facts.defaultHead = '8'.repeat(40);
      if (changed === 'owner') fixture.deps.ownership.mockResolvedValue({ ok: false, reason: 'active-owner' });
      return null;
    };
    expect(await fixture.service.recoverAutomatically(input, { blocked })).toMatchObject({ ok: false });
    expect(fixture.placement.administration).toBe('original');
    expect(fixture.cut).not.toBeNull();
  });
  it.each(['remaining-rename', 'branch-delete'])('honors a pause arriving inside the second native review before %s', async stage => {
    const input = stage === 'remaining-rename' ? await interrupted() : await (async () => {
      await fixture.service.retire(await reviewed()); return automaticInput();
    })();
    let paused = false, checks = 0;
    const native = fixture.deps.native.getMockImplementation();
    fixture.deps.native.mockImplementation(async request => {
      const result = await native(request);
      if (stage === 'remaining-rename' && request.command === 'verify-quarantine-resumption') paused = true;
      if (stage === 'branch-delete' && request.command === 'verify' && request.mode === 'restore' && ++checks === 3) paused = true;
      return result;
    });
    expect(await fixture.service.recoverAutomatically(input, { blocked: async () => paused ? 'daemon-paused' : null }))
      .toMatchObject({ ok: false, reason: 'daemon-paused' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    expect(fixture.cut).not.toBeNull();
    if (stage === 'remaining-rename') expect(fixture.placement.administration).toBe('original');
  });
  it('restarts a durably prepared branch retirement under the exact original cut without creating another reservation', async () => {
    await fixture.service.retire(await reviewed());
    fixture.deps.deleteRef.mockRejectedValueOnce(new Error('branch-archive-interrupted'));
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: false, reason: 'branch-archive-interrupted' });
    const input = await automaticInput();
    expect((await fixture.service.status(input)).phase).toBe('branch-retirement-prepared');
    const reservation = structuredClone(fixture.cut);
    const reservations = fixture.deps.admission.reserveCheckoutRetirement.mock.calls.length;
    fixture.service = _createInitializedCheckoutRecovery(fixture.deps);
    expect(await fixture.service.recoverAutomatically(input, permitted)).toMatchObject({ ok: true, receiptRecorded: true });
    expect(fixture.deps.admission.reserveCheckoutRetirement).toHaveBeenCalledTimes(reservations);
    expect(fixture.deps.admission.releaseCheckoutReservation.mock.calls.at(-1)[0]).toEqual(reservation);
  });
  it.each(['owner', 'archive', 'forge', 'reservation'])('holds prepared retirement after fresh %s evidence changes', async changed => {
    await fixture.service.retire(await reviewed());
    fixture.deps.deleteRef.mockRejectedValueOnce(new Error('branch-archive-interrupted'));
    await fixture.service.recoverAutomatically(await automaticInput(), permitted);
    const input = await automaticInput();
    if (changed === 'owner') fixture.deps.ownership.mockResolvedValue({ ok: false, reason: 'active-owner' });
    if (changed === 'archive') fixture.failArchive = true;
    if (changed === 'forge') fixture.facts.prHead = '9'.repeat(40);
    if (changed === 'reservation') fixture.cut.owner.id = 'foreign';
    expect(await fixture.service.recoverAutomatically(input, permitted)).toMatchObject({ ok: false });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.cut).not.toBeNull(); expect(fixture.headExists).toBe(true);
  });
  it('rechecks pause after durable intent publication and retains uncertainty without calling the receiver', async () => {
    await fixture.service.retire(await reviewed());
    let received = false;
    fixture.deps.deleteRef.mockImplementation(async (_repo, _branch, _head, options) => {
      await options.beforeMutation(); received = true; fixture.headExists = false; return true;
    });
    const input = await automaticInput();
    const blocked = async () => {
      const status = await fixture.service.status(input);
      return status.phase === 'branch-retirement-intent' ? 'daemon-paused' : null;
    };
    expect(await fixture.service.recoverAutomatically(input, { blocked })).toMatchObject({ ok: false, reason: 'daemon-paused' });
    expect(received).toBe(false); expect(fixture.headExists).toBe(true); expect(fixture.cut).not.toBeNull();
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted))
      .toMatchObject({ ok: false, reason: 'retirement-branch-deletion-uncertain' });
  });
  it.each(['restored', 'restored-with-metadata-transitions', 'restored-with-reviewed-finalization'])(
    'treats completed %s with released reservation as settled, never as new retirement intent', async phase => {
      const input = await interrupted();
      if (phase === 'restored') {
        expect(await fixture.service.restore(input)).toMatchObject({ ok: true });
      } else {
        const review = await fixture.service.reviewMetadataRestore(input);
        fixture.delayedRestoreDrift = phase === 'restored-with-reviewed-finalization';
        expect(await fixture.service.restoreMetadata({ ...input, review: { digest: review.review.digest } }))
          .toMatchObject({ ok: !fixture.delayedRestoreDrift });
        if (phase === 'restored-with-reviewed-finalization') {
          const current = await automaticInput();
          const final = await fixture.service.reviewRestoredFinalization(current);
          expect(await fixture.service.finalizeRestored({ ...current, review: { digest: final.review.digest } })).toMatchObject({ ok: true });
        }
      }
      const discovered = await fixture.service.discover();
      expect(discovered.transactions[0]).toMatchObject({ phase, settled: true });
      const commands = fixture.deps.native.mock.calls.length;
      expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: true, alreadyComplete: true, phase });
      expect(fixture.deps.native).toHaveBeenCalledTimes(commands);
      expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    });
  it('skips completed historical journals beside a fresh foreign cut without starving its exact owner', async () => {
    for (let i = 0; i < 3; i++) {
      const retired = await fixture.service.retire(await reviewed());
      const target = { appId: 'app', transactionId: retired.transactionId };
      const current = await fixture.service.status(target);
      expect(await fixture.service.restore({ ...target, journalDigest: current.journalDigest })).toMatchObject({ ok: true });
    }
    fixture.failPart = 'administration';
    const pending = await fixture.service.retire(await reviewed());
    fixture.failPart = null;
    const originalCut = fixture.cut;
    const owner = originalCut.owner;
    await mkdir(join(root, 'admission/cut'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'admission/cut/owner.json'), JSON.stringify(owner), { mode: 0o600 });
    fixture.deps.admission.readCheckoutReservation = async (_repo, id) => {
      if (id !== pending.transactionId) throw Object.assign(new Error('checkout-retirement-reserved'), { code: 'CHECKOUT_RETIREMENT_RESERVED' });
      return { ...originalCut, owner };
    };
    // Discovery proves terminal history is unrelated to the fresh owner. Its
    // sweep slot must go to that owner, not any of the three completed rows.
    const discovered = await fixture.service.discover();
    expect(discovered.transactions.filter(row => row.settled)).toHaveLength(3);
    const { _createInitializedRecoverySweep } = await import('./initializedCheckoutRecoverySweep.js');
    const recover = vi.fn(async () => ({ ok: false, reason: 'fixture-current-owner-hold' }));
    await _createInitializedRecoverySweep({ discover: () => fixture.service.discover(), recover })(async () => null);
    expect(recover.mock.calls.map(([input]) => input.transactionId)).toEqual([pending.transactionId]);
    expect(fixture.cut).toBe(originalCut);
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
    // Unknown or same-owner metadata is never treated as proof of release.
    await writeFile(join(root, 'admission/cut/owner.json'), '{}', { mode: 0o600 });
    expect((await fixture.service.discover()).transactions.some(row => row.settled)).toBe(false);
  });
  it('replays a durably confirmed receipt without another deletion, but retains uncertain deletion', async () => {
    await fixture.service.retire(await reviewed());
    fixture.deps.recordRetirement.mockRejectedValueOnce(new Error('receipt-disk-full'));
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: false });
    fixture.superseded = true; // Receipt replay does not delete superseded work.
    fixture.service = _createInitializedCheckoutRecovery(fixture.deps);
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: true, receiptRecorded: true });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.cut).toBeNull();
    const calls = fixture.deps.native.mock.calls.length;
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: true, alreadyComplete: true });
    expect(fixture.deps.native).toHaveBeenCalledTimes(calls);
  });
  it('never interprets an absent ref as a completed deletion without the committed result', async () => {
    await fixture.service.retire(await reviewed());
    fixture.deps.deleteRef.mockImplementation(async (_repo, _branch, _head, options) => { await options.beforeMutation(); fixture.headExists = false; throw new Error('receiver-result-lost'); });
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: false });
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted))
      .toMatchObject({ ok: false, reason: 'retirement-branch-deletion-uncertain' });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
    expect(fixture.deps.recordRetirement).not.toHaveBeenCalled();
  });
  it('reports unsupported pre-move phases and corrupt journals without creating a fresh transaction', async () => {
    fixture.failPreserve = true;
    await fixture.service.retire(await reviewed());
    const input = await automaticInput();
    expect(await fixture.service.recoverAutomatically(input, permitted)).toMatchObject({ ok: false, reason: 'preservation-proof-unbound' });
    const first = join(root, input.transactionId, '000000.json');
    await writeFile(first, '{', { mode: 0o600 });
    const found = await fixture.service.discover();
    expect(found.transactions[0]).toMatchObject({ transactionId: input.transactionId, reason: expect.any(String) });
    expect(fixture.deps.native.mock.calls.some(([arg]) => arg.command === 'move')).toBe(false);
    expect(fixture.cut).not.toBeNull();
  });
  it('does not call a terminal receipt settled when its owner file disappeared but the cut still exists', async () => {
    await fixture.service.retire(await reviewed());
    expect(await fixture.service.recoverAutomatically(await automaticInput(), permitted)).toMatchObject({ ok: true });
    const input = await automaticInput();
    await mkdir(join(root, 'admission/cut'), { recursive: true, mode: 0o700 });
    const found = await fixture.service.discover();
    expect(found.transactions.find(row => row.transactionId === input.transactionId).settled).toBe(false);
    expect(await fixture.service.recoverAutomatically(input, permitted))
      .toMatchObject({ ok: false, reason: 'retirement-reservation-owner-missing' });
    expect(fixture.deps.deleteRef).toHaveBeenCalledTimes(1);
  });
  it('holds an oversized journal before reading or dispatching its contents', async () => {
    const input = await interrupted();
    const file = await open(join(root, input.transactionId, '000000.json'), 'r+');
    try { await file.truncate(16 * 1024 * 1024 + 1); } finally { await file.close(); }
    const found = await fixture.service.discover();
    expect(found.transactions[0]).toMatchObject({ transactionId: input.transactionId, reason: 'retirement-journal-budget-exceeded' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
  it('refuses stale discovery digests and requires an explicit running gate', async () => {
    const input = await interrupted();
    expect(await fixture.service.recoverAutomatically(input)).toMatchObject({ ok: false, reason: 'automatic-retirement-gate-required' });
    expect(await fixture.service.recoverAutomatically({ ...input, journalDigest: '0'.repeat(64) }, permitted))
      .toMatchObject({ ok: false, reason: 'retirement-journal-changed' });
    expect(fixture.deps.deleteRef).not.toHaveBeenCalled();
  });
});
