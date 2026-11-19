// Optimistic active-dashboard-layout switch with generation-gated revert: `createLayoutSwitcher({ setDisplayed })` returns `switchTo(id, putPromise)`, `confirm(id)` and `confirmed`.
//
// Shared by Dashboard's initial auto-switch, selectLayout and duplicateLayout. Rules:
//  - Every switch bumps a generation and optimistically displays `id`.
//  - SUCCESS always records `id` as the server-confirmed baseline, even when superseded: the
//    server's write tail serializes PUTs and responses, so the last success to resolve is the
//    server's final active layout.
//  - FAILURE reverts to the server-confirmed id only when this is still the latest generation
//    (a newer switch, even to the same id, owns the display) AND the display still shows `id`.
//    Reverting to the confirmed baseline, not a per-call snapshot, avoids landing on an id the
//    server never accepted after back-to-back failures.
// `setDisplayed` must accept a React-style functional updater.

export function createLayoutSwitcher({ setDisplayed, initialConfirmed = null }) {
  let confirmedId = initialConfirmed;
  let generation = 0;

  // `isCancelled` lets an unmounted caller drop both the confirmation and the revert.
  const switchTo = (id, putPromise, { isCancelled = () => false } = {}) => {
    const myGen = ++generation;
    setDisplayed(id);
    return Promise.resolve(putPromise)
      .then(() => {
        if (isCancelled()) return;
        confirmedId = id;
      })
      .catch(() => {
        if (isCancelled()) return;
        if (generation !== myGen) return;
        setDisplayed((current) => (current === id ? confirmedId : current));
      });
  };

  return {
    switchTo,
    // Record a server-decided active id (initial fetch, post-delete) as the revert baseline.
    confirm(id) { confirmedId = id; },
    get confirmed() { return confirmedId; },
  };
}
