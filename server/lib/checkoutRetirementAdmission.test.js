import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn as realSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const delayed = vi.hoisted(() => ({ child: null }));
vi.mock('./childProcess.js', () => ({
  spawn: (command, args, options) => args[0] === 'fixture-delayed-mutation' ? delayed.child : realSpawn(command, args, options),
}));
import { execGit } from './execGit.js';
import { checkoutAdmission, withCheckoutPublication, reserveCheckoutRetirement,
  withCheckoutReservation, releaseCheckoutReservation } from './checkoutRetirementAdmission.js';
let repo;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'checkout-admission-'));
  execFileSync('git', ['init', '--quiet', repo]);
});
afterEach(async () => { vi.useRealTimers(); await rm(repo, { recursive: true, force: true }); });
describe('durable checkout admission', () => {
  it('rejects cuts during a writer and writers after a cut, including another instance', async () => {
    await withCheckoutPublication(repo, async () => {
      await expect(reserveCheckoutRetirement(repo, 'test-cut')).rejects.toThrow('checkout-retirement-reserved');
      await withCheckoutPublication(repo, async () => {});
    });
    const cut = await reserveCheckoutRetirement(repo, 'test-cut');
    expect((await checkoutAdmission(repo)).admission.tryPublication()).toBeNull();
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
    expect((await checkoutAdmission(repo)).admission.publications()).toMatchObject([{ uncertain: true }]);
    await expect(reserveCheckoutRetirement(repo, 'later-cut')).rejects.toThrow('checkout-retirement-reserved');
  });
});
