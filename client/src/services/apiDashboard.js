import { request } from './apiCore.js';

export const getDashboardLayouts = () => request('/dashboard/layouts');

// All mutations of dashboard-layouts.json are serialized through a single
// module-level promise tail so concurrent callers (Dashboard auto-window,
// Dashboard manual pick, ⌘K palette pick, LayoutEditor save) hit the server
// in client-issuance order. Without this, HTTP/2 multiplexing can reorder
// requests at the network so an auto-fired PUT lands at the server AFTER a
// later manual PUT — the server's write tail would then queue them in the
// wrong order. The server tail still matters for cross-tab safety; this is
// the per-tab FIFO complement.
let mutationTail = Promise.resolve();
const queueMutation = (fn) => {
  const tail = mutationTail.then(fn, fn); // run even after a prior rejection
  mutationTail = tail.then(() => null, () => null); // keep the chain alive
  return tail;
};

export const setActiveDashboardLayout = (id) =>
  queueMutation(() => request('/dashboard/layouts/active', {
    method: 'PUT',
    body: JSON.stringify({ id }),
  }));

// `activateWindow` is partial-aware: omit to preserve the existing value,
// pass `null` to clear, pass `{ start, end }` to set. Mirrors the merge in
// `server/services/dashboardLayouts.js#saveLayout`.
export const saveDashboardLayout = (id, { name, widgets, grid, activateWindow }) => {
  const body = { name, widgets, grid: grid ?? [] };
  if (activateWindow !== undefined) body.activateWindow = activateWindow;
  return queueMutation(() => request(`/dashboard/layouts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }));
};

export const deleteDashboardLayout = (id) =>
  queueMutation(() => request(`/dashboard/layouts/${encodeURIComponent(id)}`, { method: 'DELETE' }));

// Daily Driver (issue #2666) — per-day first-visit + handled flags gating the
// Daily Driver dashboard card. GET records the visit; the caller owns error UI
// (falls back to hiding the card), so it's silent. POST marks the day handled.
export const getDailyDriverState = (options = {}) => request('/daily-driver', { silent: true, ...options });
export const markDailyDriverHandled = () => request('/daily-driver/handled', { method: 'POST' });
