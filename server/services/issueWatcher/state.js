/** Serialize issue-watcher updates and merge per-PR approval changes onto the current app state. */
import { isDeepStrictEqual } from 'node:util';
import { getAppById, updateApp } from '../apps.js';

let stateWriteTail = Promise.resolve();

export function readState(app) {
  const value = app?.issueWatcherState;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function queueStateWrite(write) {
  const next = stateWriteTail.catch(() => undefined).then(write);
  stateWriteTail = next;
  return next;
}

/**
 * `patch` may be an object, or a FUNCTION of the freshly-read state. The
 * function form exists because a plain object patch is computed from a snapshot
 * taken before the queue was entered, and writing an array field from a stale
 * snapshot replaces whatever another pass wrote in the meantime. A field whose
 * entries are owned by more than one pass must derive its next value from the
 * state this write actually lands on — see `handbackStatePatch`.
 */
export async function persistState(appId, patch) {
  return queueStateWrite(async () => {
    const app = await getAppById(appId);
    if (!app) return null;
    const state = readState(app);
    const resolved = typeof patch === 'function' ? patch(state) : patch;
    return updateApp(appId, { issueWatcherState: { ...state, ...resolved } });
  });
}

export const approvalEntries = (state) => Array.isArray(state.approvedPullRequests) ? state.approvedPullRequests : [];

// A poll or review can settle after another pass replaced even the same PR's
// entry. Apply only the dispositions whose original entry is still current.
export function approvalStatePatch(state, original, changes) {
  if (!changes.size) return {};
  const byNumber = new Map(approvalEntries(state).map((entry) => [entry.number, entry]));
  const before = new Map(original.map((entry) => [entry.number, entry]));
  for (const [number, approval] of changes) {
    if (!isDeepStrictEqual(before.get(number), byNumber.get(number))) continue;
    if (approval) byNumber.set(number, approval);
    else byNumber.delete(number);
  }
  return { approvedPullRequests: [...byNumber.values()] };
}
