import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerExecutionAuthority } from './peerExecutionAuthority.js';
import { peerExecutionBindingSchema } from '../services/peerExecutionLedger.js';

let directory;
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), 'peer-execution-authority-test-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const make = options => createPeerExecutionAuthority(directory, options);

describe('non-rewound execution authority', () => {
  it('has no authority until the empty ledger initializes it', () => {
    expect(make().read()).toBeNull();
    expect(() => make().requireReady(randomUUID())).toThrow(/stale/);
    const initialized = make().initialize();
    expect(make().requireReady(initialized.epoch)).toEqual(initialized);
  });
  it('invalidates old evidence before capture, remains fenced after restart, and settles only its exact recovery', () => {
    const authority = make();
    const first = authority.initialize();
    const id = randomUUID();
    const pending = authority.beginRestore(id);
    expect(pending.epoch).not.toBe(first.epoch);
    expect(() => make().requireReady(first.epoch)).toThrow();
    expect(() => make().requireReady(pending.epoch)).toThrow();
    expect(() => authority.recordSnapshot(randomUUID(), 'a'.repeat(64), 0)).toThrow();
    authority.recordSnapshot(id, 'a'.repeat(64), 0);
    expect(() => authority.completeRestore(randomUUID())).toThrow();
    const completed = make().completeRestore(id);
    expect(completed.settledRecoveryId).toBe(id);
    expect(make().requireReady(pending.epoch).phase).toBe('ready');
    expect(() => make().requireReady(first.epoch)).toThrow();
  });
  it('does not rotate or recapture an already-owned recovery on retry', () => {
    const authority = make(); authority.initialize();
    const id = randomUUID();
    const first = authority.beginRestore(id);
    expect(authority.beginRestore(id)).toEqual(first);
    const captured = authority.recordSnapshot(id, 'b'.repeat(64), 3);
    expect(authority.beginRestore(id)).toEqual(captured);
    expect(() => authority.beginRestore(randomUUID())).toThrow(/Another/);
  });
  it.each(['{not json', JSON.stringify({ version: 99 })])('never resets unreadable/future authority: %s', contents => {
    fs.writeFileSync(join(directory, 'peer-execution-authority.json'), contents);
    expect(() => make().initialize()).toThrow(/unreadable/);
    expect(fs.readFileSync(join(directory, 'peer-execution-authority.json'), 'utf8')).toBe(contents);
    expect(fs.existsSync(join(directory, '.peer-execution-authority-lock'))).toBe(false);
  });
  it('refuses an interrupted writer instead of stealing its lock', () => {
    const authority = make(); authority.initialize();
    fs.mkdirSync(join(directory, '.peer-execution-authority-lock'));
    expect(() => make().read()).toThrow(/reconciliation/);
    expect(() => make().initialize()).toThrow(/being changed/);
  });
  it('keeps publication failure fenced in this process and after restart', () => {
    const original = make().initialize();
    const io = { ...fs, renameSync: () => { throw new Error('fixture disk failure'); } };
    const authority = make({ io });
    expect(() => authority.beginRestore(randomUUID())).toThrow('fixture disk failure');
    expect(() => authority.requireReady(original.epoch)).toThrow();
    expect(() => make().requireReady(original.epoch)).toThrow();
  });
  it('publishes a regular exact-owner adoption intent without symbolic-link privileges', () => {
    const id = randomUUID();
    const io = { ...fs, symlinkSync: () => { throw new Error('fixture Windows symlink privilege unavailable'); },
      renameSync: () => { throw new Error('fixture first publication interruption'); } };
    expect(() => make({ io }).beginEmptyAdoption(id)).toThrow(/publication interruption/);
    const lock = join(directory, '.peer-execution-authority-lock');
    expect(fs.lstatSync(lock).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual({ version: 1, kind: 'empty-adoption', id });
    expect(() => make().recoverEmptyAdoption(randomUUID())).toThrow(/matching/);
    // This internal primitive is called only after a PG-locked empty-table proof.
    expect(make().recoverEmptyAdoption(id)).toBeNull();
    expect(make({ io: { ...fs, symlinkSync: io.symlinkSync } }).beginEmptyAdoption(id))
      .toMatchObject({ phase: 'capturing', emptyAdoptionId: id });
  });
  it('rejects planning scope, injected input, oversized values and equal identities before persistence', () => {
    const input = { hostInstanceId: randomUUID(), peerInstanceId: randomUUID(), requestId: randomUUID(),
      grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1', pairBinding: 'a'.repeat(64),
      intent: { action: 'portos.restart' }, receiverVersion: '1.0.0', evidenceDigest: 'b'.repeat(64), executionEpoch: randomUUID() };
    expect(peerExecutionBindingSchema.parse(input)).toEqual(input);
    for (const changed of [{ scope: 'planning-v1' }, { intent: { action: 'portos.restart', command: 'fixture-injection' } },
      { receiverVersion: 'v'.repeat(101) }, { peerInstanceId: input.hostInstanceId }, { grantGeneration: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(peerExecutionBindingSchema.safeParse({ ...input, ...changed }).success).toBe(false);
    }
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
