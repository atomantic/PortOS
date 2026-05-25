import { describe, it, expect } from 'vitest';

// Faithful inline model of Dashboard.jsx's active-layout switch+revert state
// machine (selectLayout + serverConfirmedLayoutIdRef + switchGenerationRef).
// The real Dashboard page renders lazy Suspense widgets and a live socket,
// which makes the optimistic-set / async-revert timing hard to assert
// deterministically — so this models just the switch logic. Keep it in sync
// with Dashboard.jsx:
//   - increment switchGenerationRef and capture the generation up front
//   - optimistic setActiveLayoutId(id)
//   - on PUT success: ALWAYS stamp serverConfirmedLayoutIdRef = id (the
//     write-tail serializes PUTs + responses, so the last success to resolve
//     is the server's final active layout — superseded successes still count)
//   - on PUT failure: revert ONLY if still the latest generation (a newer
//     switch — even to the same id — owns the display) AND current === id
function createLayoutSwitcher(serverActiveId) {
  let displayed = serverActiveId;                       // activeLayoutId
  const serverConfirmed = { current: serverActiveId };  // serverConfirmedLayoutIdRef
  const generation = { current: 0 };                    // switchGenerationRef

  // Mirrors: await api.setActiveDashboardLayout(id).then(...).catch(...)
  // `put` is a promise the caller resolves/rejects to stand in for the PUT.
  const selectLayout = (id, put) => {
    const myGen = ++generation.current;
    displayed = id; // optimistic
    return put
      .then(() => {
        // always record the server's acceptance — the write-tail serializes
        // PUTs + responses, so the last success to resolve is the server's
        // final active layout (a superseded success must still be recorded)
        serverConfirmed.current = id;
      })
      .catch(() => {
        // only the latest switch may revert — a newer switch (even to the
        // same id) supersedes this one and owns the displayed state
        if (generation.current !== myGen) return;
        // functional setState — only revert if still showing the failed id
        displayed = displayed === id ? serverConfirmed.current : displayed;
      });
  };

  // Mirrors duplicateLayout: a save step (savePut) precedes the active-layout
  // switch. The generation must bump only AFTER savePut resolves — at the real
  // switch — so a save in flight (or one that rejects) can't prematurely
  // supersede an in-flight selectLayout's failure revert.
  const duplicateLayout = (id, savePut, setActivePut) =>
    savePut.then(() => {
      const myGen = ++generation.current;
      displayed = id;
      return setActivePut
        .then(() => { serverConfirmed.current = id; })
        .catch(() => {
          if (generation.current !== myGen) return;
          displayed = displayed === id ? serverConfirmed.current : displayed;
        });
    });

  return {
    selectLayout,
    duplicateLayout,
    get displayed() { return displayed; },
    get confirmed() { return serverConfirmed.current; },
  };
}

describe('Dashboard active-layout revert', () => {
  it('reverts to the server-confirmed id on a single failed switch', async () => {
    const sw = createLayoutSwitcher('A');
    await sw.selectLayout('B', Promise.reject(new Error('boom')));
    expect(sw.displayed).toBe('A');
    expect(sw.confirmed).toBe('A');
  });

  it('reverts to the server-confirmed id (A) after TWO consecutive failed switches — not the never-committed intermediate id (B)', async () => {
    // The bug: selectLayout used a per-call `previousId` snapshot. The 2nd
    // switch's previousId was 'B' (the 1st switch's optimistic-but-uncommitted
    // value), so a double failure snapped the UI to 'B' — a layout the server
    // never accepted. Tracking the last *server-confirmed* id fixes it.
    const sw = createLayoutSwitcher('A');
    const pB = sw.selectLayout('B', Promise.reject(new Error('boom'))); // displayed -> B
    const pC = sw.selectLayout('C', Promise.reject(new Error('boom'))); // displayed -> C
    await Promise.allSettled([pB, pC]);
    expect(sw.displayed).toBe('A'); // server truth, not the orphaned 'B'
    expect(sw.confirmed).toBe('A');
  });

  it('advances the confirmed baseline on a successful switch, then reverts to it on a later failure', async () => {
    const sw = createLayoutSwitcher('A');
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
    const sw = createLayoutSwitcher('A');
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
    const sw = createLayoutSwitcher('A');
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
    const sw = createLayoutSwitcher('A');
    let failB1;
    const pB1 = sw.selectLayout('B', new Promise((_, reject) => { failB1 = reject; })); // gen 1
    const pB2 = sw.selectLayout('B', Promise.resolve()); // gen 2, re-select same id
    await pB2; // newer switch confirms B
    failB1(new Error('boom')); // older switch's PUT fails late
    await pB1;
    expect(sw.displayed).toBe('B'); // NOT reverted to A
    expect(sw.confirmed).toBe('B');
  });

  it('a duplicate-layout save in flight does not prematurely supersede an in-flight switch failure', async () => {
    // duplicateLayout saves the new layout BEFORE switching to it, so the
    // generation must bump only at that later switch — not at function entry.
    // While the save is in flight, an unrelated selectLayout that fails must
    // still revert (it's still the latest switch until the duplicate commits).
    const sw = createLayoutSwitcher('A');
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
