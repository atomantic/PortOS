import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('./cosClaimOwnershipState.js', () => ({ withClaimOwnershipLock: work => work() }));
import { _createInitializedCheckoutRecovery } from './initializedCheckoutRecovery.js';

let root, fixture;
const release = { path: '/fixture/checkout', branch: 'claim/42', head: 'a'.repeat(40), locked: false, lockReason: null };
const prUrl = 'https://github.com/example/repo/pull/42';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'initialized-recovery-'));
  const facts = { prUrl, prHead: release.head, defaultHead: 'b'.repeat(40) };
  const snapshot = { fingerprint: 'c'.repeat(64), administrationFingerprint: 'd'.repeat(64), identity: { working: 1, administration: 2, common: 3 } };
  fixture = { cut: null, facts, snapshot, placement: { working: 'original', administration: 'original' }, failPart: null };
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
      return { ok: true, restoreProof: { verified: true } };
    }
    if (input.command === 'move') {
      if (fixture.failPart === input.part && input.direction === 'quarantine') throw new Error('move-refused');
      fixture.placement[input.part] = input.direction === 'quarantine' ? 'quarantined' : 'original';
    }
    return { ok: true, placement: fixture.placement };
  });
  const deps = { root: () => root, fenced: work => work(), admission, native,
    context: async () => ({ repoPath: '/fixture/repo' }),
    ownership: vi.fn(async () => ({ ok: true, policy: null })),
    forge: async () => ({ ...fixture.facts }),
    comparison: async (_ctx, _release, _url, _snapshot, policy, forge) => ({
      forge, policy, comparison: { disposition: fixture.superseded ? 'review-supersession' : 'ancestor' },
    }),
    listWorktrees: async () => fixture.newHolder ? [{ path: '/fixture/new', branch: release.branch }] : [],
    execGit: vi.fn(async () => ({ exitCode: 0, stdout: release.head })),
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
    expect(fixture.deps.native).toHaveBeenLastCalledWith({ command: 'verify', transactionDir: join(root, result.transactionId), mode: 'standalone' });
    expect(fixture.deps.execGit).not.toHaveBeenCalled();
  });
  it('holds if immutable journal history is changed', async () => {
    const result = await fixture.service.retire(await reviewed());
    const first = join(root, result.transactionId, '000000.json');
    const value = JSON.parse(await readFile(first, 'utf8')); value.repoPath = '/different';
    await writeFile(first, JSON.stringify(value));
    await expect(fixture.service.status({ appId: 'app', transactionId: result.transactionId })).rejects.toThrow('retirement-journal-invalid');
  });
});
