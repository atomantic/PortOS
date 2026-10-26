import { pinPlatform } from './testHelper.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const delayed = vi.hoisted(() => ({ child: null, failAfterRename: false, hostType: null, rejectDirectoryOpen: false, syntheticModes: false }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, type: () => delayed.hostType || actual.type() };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, openSync: (path, ...args) => {
    if (delayed.rejectDirectoryOpen && actual.existsSync(path) && actual.lstatSync(path).isDirectory()) throw new Error('directory-open-unsupported');
    return actual.openSync(path, ...args);
  } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, lstat: async path => {
    const info = await actual.lstat(path);
    return delayed.syntheticModes ? Object.assign(Object.create(info), { mode: (info.mode & ~0o777) | 0o777 }) : info;
  }, open: async (path, ...args) => {
    if (delayed.rejectDirectoryOpen && (await actual.lstat(path).catch(() => null))?.isDirectory()) throw new Error('directory-open-unsupported');
    return actual.open(path, ...args);
  }, rename: async (...args) => {
    await actual.rename(...args);
    if (delayed.failAfterRename) { delayed.failAfterRename = false; throw new Error('release-result-lost'); }
  } };
});
vi.mock('./windowsGitProcess.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, startGit: (args, options, wire) => args[0] === 'fixture-delayed-mutation'
    ? wire(delayed.child) : actual.startGit(args, options, wire) };
});
import { execGit } from './execGit.js';
import { _checkoutAdmission, withCheckoutPublication, reserveCheckoutRetirement,
  withCheckoutReservation, releaseCheckoutReservation, readCheckoutReservation } from './checkoutRetirementAdmission.js';
let repo;
beforeEach(async () => {
  delayed.hostType = null; delayed.rejectDirectoryOpen = delayed.syntheticModes = false;
  repo = await mkdtemp(join(tmpdir(), 'checkout-admission-'));
  execFileSync('git', ['init', '--quiet', repo]);
});
afterEach(async () => { vi.useRealTimers(); await rm(repo, { recursive: true, force: true }); });
describe('durable checkout admission', () => {
  it('releases on actual Windows capability even if process.platform is emulated', async () => {
    const cut = await reserveCheckoutRetirement(repo, 'windows-cut');
    delayed.hostType = 'Windows_NT'; delayed.rejectDirectoryOpen = delayed.syntheticModes = true;
    const restorePlatform = pinPlatform('darwin');
    try {
      await releaseCheckoutReservation(cut);
      await withCheckoutPublication(repo, async () => {});
      expect((await _checkoutAdmission(repo)).admission.status().cut).toBeNull();
    } finally { restorePlatform(); }
  });
  it('retains the live cut when Darwin directory fsync cannot open its parent', async () => {
    const cut = await reserveCheckoutRetirement(repo, 'darwin-cut');
    delayed.hostType = 'Darwin'; delayed.rejectDirectoryOpen = true;
    await expect(releaseCheckoutReservation(cut)).rejects.toThrow('directory-open-unsupported');
    expect(JSON.parse(await readFile(join(cut.directory, 'cut', 'owner.json'), 'utf8'))).toMatchObject({ id: 'darwin-cut' });
  });
  it('rejects cuts during a writer and writers after a cut, including another instance', async () => {
    await withCheckoutPublication(repo, async () => {
      await expect(reserveCheckoutRetirement(repo, 'test-cut')).rejects.toThrow('checkout-retirement-reserved');
      await withCheckoutPublication(repo, async () => {});
    });
    const cut = await reserveCheckoutRetirement(repo, 'test-cut');
    expect((await _checkoutAdmission(repo)).admission.tryPublication()).toBeNull();
    await expect(withCheckoutPublication(repo, async () => {})).rejects.toThrow('checkout-retirement-reserved');
    await withCheckoutReservation(cut, () => withCheckoutPublication(repo, async () => {}));
    await releaseCheckoutReservation(cut);
    await withCheckoutPublication(repo, async () => {});
  });
  it('does not let an inherited async context bypass a cut after its parent ended', async () => {
    let runLater;
    const ready = new Promise(resolve => { runLater = resolve; });
    let descendant;
    await withCheckoutPublication(repo, async () => { descendant = ready.then(() => withCheckoutPublication(repo, async () => 'unsafe')); });
    const cut = await reserveCheckoutRetirement(repo, 'new-cut');
    const refused = expect(descendant).rejects.toThrow('checkout-retirement-reserved');
    runLater(); await refused;
    await releaseCheckoutReservation(cut);
  });
  it('retains a child permit when admitted fan-out outlives its parent', async () => {
    let finish, entered;
    const waiting = new Promise(resolve => { finish = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    let child;
    await withCheckoutPublication(repo, async () => {
      child = withCheckoutPublication(repo, async () => { entered(); await waiting; });
      await ready;
    });
    await expect(reserveCheckoutRetirement(repo, 'fanout-cut')).rejects.toThrow('checkout-retirement-reserved');
    finish(); await child;
    const cut = await reserveCheckoutRetirement(repo, 'fanout-cut');
    await releaseCheckoutReservation(cut);
  });
  it('retains a cut until admitted child work finishes and revokes its join capability before release', async () => {
    const cut = await reserveCheckoutRetirement(repo, 'child-cut');
    let finish, entered;
    const waiting = new Promise(resolve => { finish = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    let child;
    await withCheckoutReservation(cut, async () => {
      child = withCheckoutPublication(repo, async () => { entered(); await waiting; });
      await ready;
      await expect(releaseCheckoutReservation(cut)).rejects.toThrow('checkout-retirement-reserved');
      await expect(withCheckoutPublication(repo, async () => {})).rejects.toThrow('checkout-retirement-reserved');
    });
    finish(); await child;
    await releaseCheckoutReservation(cut);
  });
  it('retains uncertain mutation evidence after child close and admission recreation', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 12345; child.kill = vi.fn(); delayed.child = child;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const writing = withCheckoutPublication(repo, async () => {
      vi.useFakeTimers();
      const pending = execGit(['fixture-delayed-mutation'], repo, { timeout: 20 });
      started(); return pending;
    });
    let settled = false;
    const rejected = expect(writing.finally(() => { settled = true; })).rejects.toThrow('timed out');
    await ready; await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalled(); expect(settled).toBe(false);
    child.emit('close', null, 'SIGTERM'); await rejected; vi.useRealTimers();
    expect((await _checkoutAdmission(repo)).admission.publications()).toMatchObject([{ uncertain: true }]);
    await expect(reserveCheckoutRetirement(repo, 'later-cut')).rejects.toThrow('checkout-retirement-reserved');
  });
  it('retains the complete cut owner if release crashes after its atomic rename', async () => {
    const cut = await reserveCheckoutRetirement(repo, 'released-cut');
    delayed.failAfterRename = true;
    await expect(releaseCheckoutReservation(cut)).rejects.toThrow('release-result-lost');
    const released = (await readdir(cut.directory)).filter(name => name.startsWith('released-'));
    expect(released).toHaveLength(1);
    expect(JSON.parse(await readFile(join(cut.directory, released[0], 'cut', 'owner.json'), 'utf8'))).toEqual(cut.owner);
    expect((await _checkoutAdmission(repo)).admission.status().cut).toBeNull();
    await withCheckoutPublication(repo, async () => {});
  });
  it.each([false, true])('refuses reentry of a persisted uncertain cut after timeout (Windows capability=%s)', async windows => {
    const cut = await reserveCheckoutRetirement(repo, 'uncertain-cut');
    if (windows) { delayed.hostType = 'Windows_NT'; delayed.rejectDirectoryOpen = true; }
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 12345; child.kill = vi.fn(); delayed.child = child;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const running = withCheckoutReservation(cut, async () => {
      vi.useFakeTimers();
      const pending = execGit(['fixture-delayed-mutation'], repo, { timeout: 20 });
      started(); return pending;
    });
    const rejected = expect(running).rejects.toThrow('timed out');
    await ready; await vi.advanceTimersByTimeAsync(20);
    child.emit('close', null, 'SIGTERM'); await rejected; vi.useRealTimers();
    const recovered = await readCheckoutReservation(repo, 'uncertain-cut');
    const work = vi.fn();
    await expect(withCheckoutReservation(recovered, work)).rejects.toThrow('checkout-retirement-reserved');
    await expect(releaseCheckoutReservation(recovered)).rejects.toThrow('checkout-retirement-reserved');
    expect(work).not.toHaveBeenCalled();
    expect((await _checkoutAdmission(repo)).admission.status().cut).toMatchObject({ uncertain: true });
  });

});
