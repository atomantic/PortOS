import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_FILE, STALE_ROOT_AGE_MS, isOwnerAlive, sweepStaleRunRoots, writeOwnerFile } from './staleRunRoots.js';

let host;
beforeEach(() => { host = mkdtempSync(join(tmpdir(), 'srr-test-')); });
afterEach(() => { rmSync(host, { recursive: true, force: true }); vi.restoreAllMocks(); });

// A complete synthetic snapshot makes the age-policy contract independent of
// native process-list support (Windows deliberately has no such reader).
const read = () => [{ pid: process.pid, ppid: process.ppid }];

const makeRoot = (name, { owner, ageMs = 0 } = {}) => {
  const root = join(host, name);
  mkdirSync(root);
  if (owner) writeFileSync(join(root, OWNER_FILE), owner);
  const t = new Date(Date.now() - ageMs);
  utimesSync(root, t, t);
  return root;
};

describe.each(['pvt-', 'portos-vitest-'])('sweepStaleRunRoots (%s)', (prefix) => {
  it('removes a fresh root immediately when its owner is dead, keeps a live owner however old, and ages out pid-less roots at 6h', () => {
    const dead = makeRoot(prefix + 'dead', { owner: '111 1000' });
    const live = makeRoot(prefix + 'live', { owner: '222 1000', ageMs: STALE_ROOT_AGE_MS * 2 });
    const noPidFresh = makeRoot(prefix + 'nopid-fresh');
    const noPidOld = makeRoot(prefix + 'nopid-old', { ageMs: STALE_ROOT_AGE_MS + 60_000 });
    const garbageOld = makeRoot(prefix + 'garbage', { owner: 'not a pid', ageMs: STALE_ROOT_AGE_MS + 60_000 });
    const other = makeRoot('unrelated-old', { ageMs: STALE_ROOT_AGE_MS * 2 });

    const otherPrefix = makeRoot(prefix === 'pvt-' ? 'portos-vitest-dead' : 'pvt-dead', { owner: '111 1000' });

    sweepStaleRunRoots(host, { prefix, read, probe: ({ pid }) => pid === 222 });

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(noPidFresh)).toBe(true);
    expect(existsSync(noPidOld)).toBe(false);
    expect(existsSync(garbageOld)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(otherPrefix)).toBe(true);
  });

  it('falls back to the age rule when liveness is undeterminable (probe returns null)', () => {
    const fresh = makeRoot(prefix + 'unknown-fresh', { owner: '5 1' });
    const old = makeRoot(prefix + 'unknown-old', { owner: '5 1', ageMs: STALE_ROOT_AGE_MS + 60_000 });
    sweepStaleRunRoots(host, { prefix, read, probe: () => null });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('preserves pid-less old roots when process inspection is unavailable', () => {
    const root = makeRoot(prefix + 'uninspected', { ageMs: STALE_ROOT_AGE_MS * 2 });
    sweepStaleRunRoots(host, { prefix, read: () => null });
    expect(existsSync(root)).toBe(true);
  });

  it('retains an aged live owner whose birth time was unreadable when stamped', () => {
    const root = makeRoot(prefix + 'unreadable-birth');
    writeOwnerFile(root, { exec: () => { throw Error('identity unavailable'); } });
    expect(readFileSync(join(root, OWNER_FILE), 'utf8')).toBe(`${process.pid} unknown\n`);
    const aged = new Date(Date.now() - STALE_ROOT_AGE_MS * 2);
    utimesSync(root, aged, aged);
    // A later successful reader must not interpret missing birth evidence as
    // PID reuse and reclaim the still-live owner.
    sweepStaleRunRoots(host);
    expect(existsSync(root)).toBe(true);
  });

  it('keeps a root owned by this very process (real probe, real owner file)', () => {
    const root = makeRoot(prefix + 'self');
    writeOwnerFile(root);
    sweepStaleRunRoots(host, { prefix });
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

  it('treats a zombie process as dead', () => {
    if (process.platform === 'win32') return;
    const exec = () => 'Z+   Sun Oct 18 02:55:38 2026\n';
    expect(isOwnerAlive({ pid: process.pid, startMs: Date.now() }, { exec })).toBe(false);
  });
});
