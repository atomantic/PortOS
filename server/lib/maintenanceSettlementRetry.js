// A short journal conflict must not turn finished work into a permanent blocker.
const pending = new WeakMap();
const RETRY_MS = 30000;

export function settleAdmissionEventually(permit, label) {
  if (!permit) return Promise.resolve(true);
  if (pending.has(permit)) return pending.get(permit);
  const attempt = async () => {
    let done = false;
    try { done = await permit.finish(); } catch { /* retry after the journal recovers */ }
    if (!done && permit.isCurrent) {
      try { done = !permit.isCurrent(); } catch { /* retry an unavailable journal */ }
    }
    if (done) { pending.delete(permit); return true; }
    console.warn(`⚠️ ${label} admission settlement is waiting; it will retry.`);
    const timer = setTimeout(() => { void attempt(); }, RETRY_MS);
    timer.unref?.();
    return false;
  };
  const first = attempt();
  pending.set(permit, first);
  return first;
}
