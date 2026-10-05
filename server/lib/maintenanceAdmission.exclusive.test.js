import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from './maintenanceAdmission.js';

const roots = [];
const gate = options => {
  const root = mkdtempSync(join(tmpdir(), 'exclusive-maintenance-'));
  roots.push(root);
  const admission = createMaintenanceAdmission(root, options);
  const hold = admission.begin({ reason: 'Fixture maintenance', owner: 'Local operator' }).hold;
  return { root, admission, hold };
};
const operation = () => ({ operationId: randomUUID(), requestId: randomUUID(), peerInstanceId: randomUUID(),
  hostInstanceId: randomUUID(), grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1',
  pairBinding: 'a'.repeat(64), intent: { action: 'portos.update' }, receiverVersion: '1.2.3', evidenceDigest: 'b'.repeat(64) });
const expected = claim => ({ id: claim.id, revision: claim.revision, fingerprint: claim.fingerprint });
const reserve = (admission, hold, op = operation()) => admission.claimReady({ id: hold.id, revision: hold.revision,
  operation: op }, admission.observeIdle());
const cancelled = { outcome: 'cancelled', receiptDigest: null };
const terminal = { outcome: 'succeeded', receiptDigest: 'c'.repeat(64) };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('exclusive maintenance ownership through the coordinator', () => {
  it('waits for saving and cleanup, without interrupting admitted work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exclusive-maintenance-'));
    roots.push(root);
    const admission = createMaintenanceAdmission(root);
    const work = admission.admit('media', 'fixture-render');
    const hold = admission.begin({ reason: 'Drain', owner: 'Operator' }).hold;
    expect(() => admission.observeIdle()).toThrow(/cleanup/);
    const cleanup = admission.admit('settlement', 'Saving', { parentId: work.id });
    await work.finish();
    expect(() => admission.observeIdle()).toThrow(/cleanup/);
    await cleanup.finish();
    const claim = reserve(admission, hold);
    expect(admission.status()).toMatchObject({ state: 'draining', hold,
      blockers: [{ kind: 'exclusive-maintenance', resource: claim.operation.operationId }] });
    expect(admission.tryAdmit('agent', 'new')).toBeNull();
  });

  it('refuses forged, copied and foreign-process idle evidence without damaging the hold', () => {
    const { root, admission, hold } = gate();
    const input = { id: hold.id, revision: hold.revision, operation: operation() };
    const proof = admission.observeIdle();
    for (const invalid of [{}, { ...proof }, createMaintenanceAdmission(root).observeIdle()]) {
      expect(() => admission.claimReady(input, invalid)).toThrow(/fresh coordinator/);
      expect(admission.status().state).toBe('ready');
    }
    expect(admission.claimReady(input, proof).phase).toBe('reserved');
  });

  it('bounds observation age and rejects backwards clock changes', () => {
    let time = 1_800_000_000_000;
    const { admission, hold } = gate({ now: () => time });
    const input = { id: hold.id, revision: hold.revision, operation: operation() };
    const expired = admission.observeIdle();
    time += 5001;
    expect(() => admission.claimReady(input, expired)).toThrow(/fresh coordinator/);
    const future = admission.observeIdle();
    time--;
    expect(() => admission.claimReady(input, future)).toThrow(/fresh coordinator/);
    expect(admission.getExclusive()).toBeNull();
  });

  it('invalidates idle evidence after intervening work even when that work subsequently settles', async () => {
    const { admission, hold } = gate();
    const evidence = admission.observeIdle();
    const recovered = admission.recoverOwned('runner', 'observed-survivor');
    await recovered.finish();
    expect(() => admission.claimReady({ id: hold.id, revision: hold.revision, operation: operation() }, evidence)).toThrow(/fresh coordinator/);
    expect(reserve(admission, hold).phase).toBe('reserved');
  });

  it('linearizes competing claims and both orderings of the resume/claim race', () => {
    const first = gate();
    const other = createMaintenanceAdmission(first.root);
    const secondProof = other.observeIdle();
    const claim = reserve(first.admission, first.hold);
    expect(() => other.claimReady({ id: first.hold.id, revision: first.hold.revision, operation: operation() }, secondProof)).toThrow(/exclusive owner/);
    expect(() => other.resume({ id: first.hold.id, revision: first.hold.revision })).toThrow(/exclusive maintenance/);
    first.admission.settleExclusive(expected(claim), cancelled);
    expect(other.resume({ id: first.hold.id, revision: first.hold.revision }).state).toBe('normal');
    const second = gate();
    const evidence = second.admission.observeIdle();
    second.admission.resume({ id: second.hold.id, revision: second.hold.revision });
    expect(() => second.admission.claimReady({ id: second.hold.id, revision: second.hold.revision, operation: operation() }, evidence)).toThrow(/hold changed/);
    expect(second.admission.getExclusive()).toBeNull();
  });

  it('requires execution identity and fixed inputs; planning grants and injected commands cannot reserve', () => {
    const { admission, hold } = gate();
    const op = operation();
    for (const invalid of [{ ...op, scope: 'planning-v1' }, { ...op, grantGeneration: 0 },
      { ...op, intent: { action: 'portos.update', command: 'arbitrary' } }, { ...op, pairBinding: '' },
      { ...op, peerInstanceId: op.hostInstanceId }]) {
      expect(() => reserve(admission, hold, invalid)).toThrow();
      expect(admission.status().state).toBe('ready');
    }
    const claim = reserve(admission, hold, op);
    expect(createMaintenanceAdmission(roots.at(-1)).getExclusive()).toEqual(claim);
    claim.operation.intent.action = 'portos.restart';
    expect(admission.getExclusive().operation.intent).toEqual(op.intent);
    expect(admission.status()).not.toHaveProperty('exclusive');
    expect(JSON.stringify(admission.status())).not.toContain(op.pairBinding);
  });

  it('requires a second fresh idle observation at start and cannot start twice', () => {
    const { admission, hold } = gate();
    const stale = admission.observeIdle();
    const claim = reserve(admission, hold);
    expect(() => admission.transitionExclusive(expected(claim), 'in-flight', stale)).toThrow(/fresh coordinator/);
    const started = admission.transitionExclusive(expected(claim), 'in-flight', admission.observeIdle());
    expect(started.revision).toBe(claim.revision + 1);
    expect(() => admission.transitionExclusive(expected(started), 'in-flight', admission.observeIdle())).toThrow(/launched again/);
    expect(() => admission.settleExclusive(expected(started), cancelled)).toThrow(/never started/);
    expect(() => admission.settleExclusive(expected(started), terminal)).toThrow(/Verified terminal/);
    expect(admission.getExclusive()).toEqual(started);
  });

  it('denies dispatch while a previously unobserved job finishes under a reservation', async () => {
    const { admission, hold } = gate();
    const claim = reserve(admission, hold);
    const evidence = admission.observeIdle();
    const work = admission.recoverOwned('media', 'late-survivor');
    expect(() => admission.transitionExclusive(expected(claim), 'in-flight', evidence)).toThrow(/fresh coordinator/);
    expect(() => admission.observeIdle()).toThrow(/cleanup/);
    await work.finish();
    expect(admission.transitionExclusive(expected(claim), 'in-flight', admission.observeIdle()).phase).toBe('in-flight');
  });

  it('retains reservation ownership on restart and can cancel only before a start record', () => {
    const { root, admission, hold } = gate();
    const claim = reserve(admission, hold);
    const restarted = createMaintenanceAdmission(root);
    expect(restarted.getExclusive()).toEqual(claim);
    expect(() => restarted.resume({ id: hold.id, revision: hold.revision })).toThrow(/exclusive maintenance/);
    const receipt = restarted.settleExclusive(expected(claim), cancelled);
    expect(receipt.outcome).toBe('cancelled');
    expect(restarted.status()).toMatchObject({ state: 'ready', hold });
    expect(restarted.settleExclusive(expected(claim), cancelled)).toEqual(receipt);
    expect(() => reserve(restarted, hold, claim.operation)).toThrow(/already settled/);
  });

  it('never treats restart, timeout or reconnect as completion or permission to relaunch', () => {
    const { root, admission, hold } = gate();
    const reserved = reserve(admission, hold);
    const started = admission.transitionExclusive(expected(reserved), 'in-flight', admission.observeIdle());
    const restarted = createMaintenanceAdmission(root);
    expect(restarted.getExclusive()).toEqual(started);
    const waiting = restarted.transitionExclusive(expected(started), 'awaiting-reconnect');
    const uncertain = restarted.transitionExclusive(expected(waiting), 'uncertain');
    expect(() => restarted.transitionExclusive(expected(uncertain), 'in-flight', restarted.observeIdle())).toThrow(/launched again/);
    expect(() => restarted.resume({ id: hold.id, revision: hold.revision })).toThrow(/exclusive maintenance/);
    expect(() => restarted.settleExclusive(expected(uncertain), terminal)).toThrow(/Verified terminal/);
    expect(restarted.getExclusive().phase).toBe('uncertain');
  });

  it('invalidates reconciliation when observed survivor work changes an in-flight claim', async () => {
    const { admission, hold } = gate({ verifyExclusiveReceipt: () => true });
    const reserved = reserve(admission, hold);
    const started = admission.transitionExclusive(expected(reserved), 'in-flight', admission.observeIdle());
    const survivor = admission.recoverOwned('provider', 'survivor');
    expect(admission.getExclusive()).toMatchObject({ phase: 'uncertain', revision: started.revision + 1 });
    expect(() => admission.settleExclusive(expected(started), terminal)).toThrow(/ownership changed/);
    await survivor.finish();
    expect(admission.getExclusive().phase).toBe('uncertain');
  });

  it('reconciles only exact ownership with receiver-verified terminal persistence; hold stays until resume', () => {
    let verified = false;
    const { root, admission, hold } = gate({ verifyExclusiveReceipt: (claim, receipt) =>
      verified && claim.operation.intent.action === 'portos.update' && receipt.receiptDigest === terminal.receiptDigest });
    const reserved = reserve(admission, hold);
    const started = admission.transitionExclusive(expected(reserved), 'in-flight', admission.observeIdle());
    expect(() => admission.settleExclusive({ ...expected(started), fingerprint: 'f'.repeat(64) }, terminal)).toThrow(/ownership changed/);
    expect(() => admission.settleExclusive(expected(started), terminal)).toThrow(/Verified terminal/);
    verified = true;
    const receipt = admission.settleExclusive(expected(started), terminal);
    const restarted = createMaintenanceAdmission(root);
    expect(restarted.getExclusive()).toBeNull();
    expect(restarted.settleExclusive(expected(started), terminal)).toEqual(receipt);
    expect(() => restarted.settleExclusive(expected(started), { outcome: 'failed', receiptDigest: terminal.receiptDigest })).toThrow(/ownership changed/);
    expect(restarted.status()).toMatchObject({ state: 'ready', hold });
    const next = reserve(restarted, hold);
    expect(() => restarted.settleExclusive(expected(started), terminal)).toThrow(/ownership changed/);
    expect(restarted.getExclusive()).toEqual(next);
  });

  it('refuses asynchronous verification without releasing ownership or losing its rejection', async () => {
    for (const reason of [new Error('fixture verifier failure'), null, undefined]) {
      const { admission, hold } = gate({ verifyExclusiveReceipt: () => Promise.reject(reason) });
      const reserved = reserve(admission, hold);
      const started = admission.transitionExclusive(expected(reserved), 'in-flight', admission.observeIdle());
      expect(() => admission.settleExclusive(expected(started), terminal)).toThrow(/Verified terminal/);
      await Promise.resolve();
      expect(admission.getExclusive()).toEqual(started);
    }
  });

  it('retries a transient synchronous verifier failure without poisoning the transaction lock', () => {
    let fail = true;
    const verifyExclusiveReceipt = () => {
      if (fail) { fail = false; throw new Error('fixture verifier temporarily unavailable'); }
      return true;
    };
    const { root, admission, hold } = gate({ verifyExclusiveReceipt });
    const reserved = reserve(admission, hold);
    const started = admission.transitionExclusive(expected(reserved), 'in-flight', admission.observeIdle());
    expect(() => admission.settleExclusive(expected(started), terminal)).toThrow(/verification is unavailable/);
    expect(admission.getExclusive()).toEqual(started);
    const restarted = createMaintenanceAdmission(root, { verifyExclusiveReceipt });
    expect(restarted.status().state).toBe('draining');
    expect(restarted.settleExclusive(expected(started), terminal).outcome).toBe('succeeded');
    expect(restarted.status()).toMatchObject({ state: 'ready', hold });
  });

  it('preserves exclusive ownership when receipt publication fails', () => {
    let fail = false;
    const io = { ...fs, renameSync: (...args) => {
      if (fail) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
      return fs.renameSync(...args);
    } };
    const { root, admission, hold } = gate({ io, verifyExclusiveReceipt: () => true });
    const reserved = reserve(admission, hold);
    const started = admission.transitionExclusive(expected(reserved), 'in-flight', admission.observeIdle());
    fail = true;
    expect(() => admission.settleExclusive(expected(started), terminal)).toThrow(/needs recovery/);
    expect(admission.status().state).toBe('unavailable');
    expect(JSON.parse(readFileSync(join(admission.directory, 'state.json'), 'utf8')).exclusive).toEqual(started);
    expect(createMaintenanceAdmission(root).status().state).toBe('unavailable');
  });

  it('fails closed on damaged binding/hold records while retaining compatibility with older unclaimed journals', () => {
    const { root, admission, hold } = gate();
    const file = join(admission.directory, 'state.json');
    const old = readFileSync(file, 'utf8');
    expect(createMaintenanceAdmission(root).status().state).toBe('ready');
    reserve(admission, hold);
    const claimed = JSON.parse(readFileSync(file, 'utf8'));
    claimed.exclusive.operation.grantGeneration++;
    writeFileSync(file, JSON.stringify(claimed));
    expect(createMaintenanceAdmission(root).status().state).toBe('unavailable');
    claimed.exclusive.operation.grantGeneration--;
    claimed.exclusive.holdId = randomUUID();
    writeFileSync(file, JSON.stringify(claimed));
    expect(createMaintenanceAdmission(root).status().state).toBe('unavailable');
    writeFileSync(file, old);
    expect(createMaintenanceAdmission(root).status().state).toBe('ready');
  });
});
