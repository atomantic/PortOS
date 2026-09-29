import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_FILE, STALE_ROOT_AGE_MS, isOwnerAlive, sweepStaleRunRoots, writeOwnerFile } from './staleRunRoots.js';

let host;
beforeEach(() => { host = mkdtempSync(join(tmpdir(), 'srr-test-')); });
afterEach(() => { rmSync(host, { recursive: true, force: true }); vi.restoreAllMocks(); });

const makeRoot = (name, { owner, ageMs = 0 } = {}) => {
  const root = join(host, name);
  mkdirSync(root);
  if (owner) writeFileSync(join(root, OWNER_FILE), owner);
  const t = new Date(Date.now() - ageMs);
  utimesSync(root, t, t);
  return root;
};

describe('sweepStaleRunRoots (#9113)', () => {
  it('removes a fresh root immediately when its owner is dead, keeps a live owner however old, and ages out pid-less roots at 6h', () => {
    const dead = makeRoot('pvt-dead', { owner: '111 1000' });
    const live = makeRoot('pvt-live', { owner: '222 1000', ageMs: STALE_ROOT_AGE_MS * 2 });
    const noPidFresh = makeRoot('pvt-nopid-fresh');
    const noPidOld = makeRoot('pvt-nopid-old', { ageMs: STALE_ROOT_AGE_MS + 60_000 });
    const garbageOld = makeRoot('pvt-garbage', { owner: 'not a pid', ageMs: STALE_ROOT_AGE_MS + 60_000 });
    const other = makeRoot('unrelated-old', { ageMs: STALE_ROOT_AGE_MS * 2 });

    sweepStaleRunRoots(host, { probe: ({ pid }) => pid === 222 });

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(noPidFresh)).toBe(true);
    expect(existsSync(noPidOld)).toBe(false);
    expect(existsSync(garbageOld)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('falls back to the age rule when liveness is undeterminable (probe returns null)', () => {
    const fresh = makeRoot('pvt-unknown-fresh', { owner: '5 1' });
    const old = makeRoot('pvt-unknown-old', { owner: '5 1', ageMs: STALE_ROOT_AGE_MS + 60_000 });
    sweepStaleRunRoots(host, { probe: () => null });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('keeps a root owned by this very process (real probe, real owner file)', () => {
    const root = makeRoot('pvt-self');
    writeOwnerFile(root);
    sweepStaleRunRoots(host);
    expect(existsSync(root)).toBe(true);
  });
});

describe('isOwnerAlive', () => {
  it('reports this process alive and a reused pid (mismatched start) dead', () => {
    const startMs = Date.now() - process.uptime() * 1000;
    expect(isOwnerAlive({ pid: process.pid, startMs })).toBe(true);
    if (process.platform !== 'win32') {
      expect(isOwnerAlive({ pid: process.pid, startMs: startMs - 3_600_000 })).toBe(false);
    }
  });

  it('treats ESRCH as dead and EPERM as alive', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); });
    expect(isOwnerAlive({ pid: 999999, startMs: 1 })).toBe(false);
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { code: 'EPERM' }); });
    expect(isOwnerAlive({ pid: 1, startMs: NaN })).toBe(true);
  });

  it('does not throw on win32 and treats a signalable pid as alive', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(isOwnerAlive({ pid: process.pid, startMs: 1 })).toBe(true);
  });
});
