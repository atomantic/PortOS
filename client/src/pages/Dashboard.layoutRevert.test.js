// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { createLayoutSwitcher } from '../lib/layoutSwitch.js';

// Drives the real createLayoutSwitcher that Dashboard.jsx uses for its initial
// auto-switch, selectLayout and duplicateLayout. The page renders lazy Suspense
// widgets and a live socket, so the switch logic is tested at its own seam.
// duplicateLayout is modelled exactly as Dashboard calls it: the save resolves
// first, and only then does switchTo (the generation bump) run.
function createHarness(serverActiveId) {
  let displayed = serverActiveId;
  const setDisplayed = (next) => { displayed = typeof next === 'function' ? next(displayed) : next; };
  const switcher = createLayoutSwitcher({ setDisplayed });
  switcher.confirm(serverActiveId);
  return {
    selectLayout: (id, put) => switcher.switchTo(id, put),
    duplicateLayout: (id, savePut, setActivePut) =>
      savePut.then(() => switcher.switchTo(id, setActivePut)),
    get displayed() { return displayed; },
    get confirmed() { return switcher.confirmed; },
  };
}

describe('Dashboard active-layout revert', () => {
  it('reverts to the server-confirmed id on a single failed switch', async () => {
    const sw = createHarness('A');
    await sw.selectLayout('B', Promise.reject(new Error('boom')));
    expect(sw.displayed).toBe('A');
    expect(sw.confirmed).toBe('A');
  });

  it('reverts to the server-confirmed id (A) after TWO consecutive failed switches — not the never-committed intermediate id (B)', async () => {
    // The bug: selectLayout used a per-call `previousId` snapshot. The 2nd
    // switch's previousId was 'B' (the 1st switch's optimistic-but-uncommitted
    // value), so a double failure snapped the UI to 'B' — a layout the server
    // never accepted. Tracking the last *server-confirmed* id fixes it.
    const sw = createHarness('A');
    const pB = sw.selectLayout('B', Promise.reject(new Error('boom'))); // displayed -> B
    const pC = sw.selectLayout('C', Promise.reject(new Error('boom'))); // displayed -> C
    await Promise.allSettled([pB, pC]);
    expect(sw.displayed).toBe('A'); // server truth, not the orphaned 'B'
    expect(sw.confirmed).toBe('A');
  });

  it('advances the confirmed baseline on a successful switch, then reverts to it on a later failure', async () => {
    const sw = createHarness('A');
    await sw.selectLayout('B', Promise.resolve());            // server now active = B
    expect(sw.confirmed).toBe('B');
    await sw.selectLayout('C', Promise.reject(new Error('boom')));
    expect(sw.displayed).toBe('B'); // reverts to the now-confirmed B, not A
    expect(sw.confirmed).toBe('B');
  });

  it('a superseded-but-successful switch still records the server confirmation (B succeeds while C is in flight, then C fails)', async () => {
    // The server accepted B even though C is the newer switch. Because the
    // success path does NOT gate on generation, the confirmed baseline must
    // advance to B — so when C then fails, the display reverts to B, not back
    // to the stale A. (If the success path were generation-gated, B's success
    // would be dropped and C's failure would wrongly revert to A.)
    const sw = createHarness('A');
    let resolveB;
    let failC;
    const pB = sw.selectLayout('B', new Promise((r) => { resolveB = r; }));            // gen 1
    const pC = sw.selectLayout('C', new Promise((_, reject) => { failC = reject; }));  // gen 2
    resolveB(); // B's PUT succeeds even though C is the latest switch
    await pB;
    expect(sw.confirmed).toBe('B'); // superseded success still recorded
    failC(new Error('boom'));
    await pC;
    expect(sw.displayed).toBe('B'); // C's failure reverts to the confirmed B, not A
    expect(sw.confirmed).toBe('B');
  });

  it('a stale failure does not clobber a later in-flight selection', async () => {
    const sw = createHarness('A');
    let failB;
    const pB = sw.selectLayout('B', new Promise((_, reject) => { failB = reject; }));
    const pC = sw.selectLayout('C', Promise.resolve()); // C selected + confirmed first
    await pC;
    failB(new Error('boom')); // B's PUT now fails, but user is on C
    await pB;
    expect(sw.displayed).toBe('C'); // functional-setState guard preserves C
    expect(sw.confirmed).toBe('C');
  });

  it('an earlier failed switch does not revert a newer switch to the SAME id', async () => {
    // Copilot scenario: the user re-selects the layout that is already
    // optimistically displayed while the first PUT is still in flight. The
    // first PUT then fails. `current === id` is still true (same id shown), so
    // the `current === id` guard alone would wrongly revert — but the newer
    // switch (higher generation) owns the display and its PUT may yet succeed.
    const sw = createHarness('A');
    let failB1;
    const pB1 = sw.selectLayout('B', new Promise((_, reject) => { failB1 = reject; })); // gen 1
    let resolveB2;
    const pB2 = sw.selectLayout('B', new Promise((r) => { resolveB2 = r; })); // gen 2, re-select same id, still in flight
    failB1(new Error('boom')); // older switch's PUT fails while the newer one is pending
    await pB1;
    expect(sw.displayed).toBe('B'); // NOT reverted to A (confirmed is still A here)
    resolveB2(); // newer switch confirms B
    await pB2;
    expect(sw.displayed).toBe('B');
    expect(sw.confirmed).toBe('B');
  });

  it('a duplicate-layout save in flight does not prematurely supersede an in-flight switch failure', async () => {
    // duplicateLayout saves the new layout BEFORE switching to it, so the
    // generation must bump only at that later switch — not at function entry.
    // While the save is in flight, an unrelated selectLayout that fails must
    // still revert (it's still the latest switch until the duplicate commits).
    const sw = createHarness('A');
    let failX;
    let resolveSave;
    const pX = sw.selectLayout('X', new Promise((_, reject) => { failX = reject; })); // gen 1, displayed X
    const pDup = sw.duplicateLayout('D', new Promise((r) => { resolveSave = r; }), Promise.resolve()); // save pending — no gen bump yet
    failX(new Error('boom')); // X fails while the duplicate's save is still in flight
    await pX;
    expect(sw.displayed).toBe('A'); // X's failure still reverts (no premature gen bump)
    resolveSave(); // duplicate's save resolves → only now does it switch
    await pDup;
    expect(sw.displayed).toBe('D');
    expect(sw.confirmed).toBe('D');
  });
});
