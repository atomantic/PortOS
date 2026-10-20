import { pinPlatform } from '../lib/testHelper.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    metadataToken: 'f'.repeat(64), finalizationToken: '7'.repeat(64) };
  const admission = {
    withCheckoutPublication: async (_repo, work) => { if (fixture.cut) throw new Error('checkout-retirement-reserved'); return work(); },
    reserveCheckoutRetirement: vi.fn(async (_repo, id) => {
      if (fixture.cut) throw new Error('checkout-retirement-reserved');
      fixture.cut = { owner: { id }, directory: '/fixture/admission' }; return fixture.cut;
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
      forge, policy, comparison: { disposition: fixture.superseded ? 'review-supersession' : 'ancestor' },
    }),
    listWorktrees: async () => fixture.newHolder ? [{ path: '/fixture/new', branch: release.branch }] : [],
    execGit: vi.fn(async () => ({ exitCode: fixture.headExists ? 0 : 1, stdout: fixture.headExists ? release.head : '' })),
    deleteRef: vi.fn(async () => { fixture.headExists = false; return true; }),
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
    expect(fixture.deps.deleteRef).toHaveBeenCalledWith('/fixture/repo', release.branch, release.head);
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
    fixture.deps.deleteRef.mockImplementation(async () => { fixture.headExists = false; throw new Error('receiver-result-lost'); });
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
