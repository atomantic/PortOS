// @vitest-environment node

/**
 * Repo-wide guard: a client file that emits `<ns>:subscribe` for a
 * `registerSubscriber` namespace goes through `hooks/useSocketSubscription.js`.
 *
 * The server keeps room membership per server-side socket OBJECT
 * (`registerSubscriber` in `server/services/socket.js`) with NO ref count —
 * `disconnect` clears the whole subscriber Set. A one-shot `socket.emit('<ns>:subscribe')`
 * at mount therefore goes permanently dead the first time the shared client
 * socket reconnects (server restart, PM2 reload, self-update, laptop sleep, a
 * Wi-Fi/Tailscale blip): the server sees a brand new socket belonging to no
 * subscriber set. `useNotifications`, `useErrorNotifications`,
 * `pages/Instances.jsx` and `pages/Loops.jsx` all shipped this bug (#8110) —
 * the bell, error toasts, and the Instances/Loops live streams went silent
 * for the rest of the tab's life after the first reconnect.
 *
 * `useSocketSubscription` centralizes the fix: subscribe once (refcounted
 * across consumers of the same namespace), re-emit on every socket `connect`,
 * and optionally refetch via `onResubscribe`. New namespace subscribers must
 * use it instead of re-implementing the reconnect dance (or forgetting it).
 *
 * A handful of hooks predate this fix and already implement the correct
 * `socket.on('connect', subscribe)` pattern by hand; they sit on the
 * allowlist below with a reason rather than being forced to migrate in the
 * same change (explicitly sanctioned by #8110's acceptance criteria).
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass:
 *   - A subscribe built from a dynamic template string (`` `${ns}:subscribe` ``)
 *     is invisible — that is also `useSocketSubscription`'s own internal form,
 *     so this is by design: the hook itself is exempted by path, not pattern.
 *   - It cannot tell an allowlisted file's *sanctioned* connect-resubscribe
 *     from a second, unguarded emit added to the same file later.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The namespaces `registerSubscriber` wires up in server/services/socket.js.
const SUBSCRIBER_NAMESPACES = ['cos', 'errors', 'notifications', 'agents', 'instances', 'loops', 'beeper'];

const SUBSCRIBE_CALL = new RegExp(
  `emit\\(\\s*['"](?:${SUBSCRIBER_NAMESPACES.join('|')}):subscribe['"]`
);

// The hook itself — the only file allowed to emit these literals unconditionally.
const HOOK_FILE = 'src/hooks/useSocketSubscription.js';

/**
 * Files allowed to emit a namespace subscribe directly, each with the reason
 * it is not the bug class this guard hunts for.
 */
const ALLOWED = {
  // Already implement `subscribe(); socket.on('connect', subscribe);` by hand,
  // predating useSocketSubscription — correct today, migration optional per
  // #8110's acceptance criteria rather than mandatory in the same change.
  'src/hooks/useCosTaskUpdates.js': 're-subscribes cos:* on connect already',
  'src/hooks/useBeeperRealtime.js': 're-subscribes beeper:* on connect already',
  'src/hooks/useMoltworldWs.js': 're-subscribes agents:* on connect already',
  'src/hooks/useOnDemandTaskToast.js': 're-subscribes cos:* on connect already',
  'src/pages/ChiefOfStaff.jsx': 're-subscribes cos:* on connect already (two taskLists modes)',
  // Does not itself re-subscribe on connect, but rides on the shared cos:*
  // namespace that useCosTaskUpdates (always mounted from Layout) keeps alive
  // across reconnects — the server Set has no ref count, so any one consumer
  // re-adding the socket restores every cos:* listener. Out of scope for
  // #8110, which named only notifications/errors/instances/loops as the
  // namespaces that went fully dark (no other consumer covering them).
  'src/hooks/useAgentFeedbackToast.jsx': 'rides on cos:* kept alive by useCosTaskUpdates; not independently broken',
};

const scannedFiles = () => trackedSourceFiles(CLIENT_ROOT);

const emitsSubscribe = (file) => SUBSCRIBE_CALL.test(readFileSync(join(CLIENT_ROOT, file), 'utf8'));

describe('socket namespace subscriptions go through useSocketSubscription', () => {
  it('has no raw <ns>:subscribe emit outside the hook and its allowlist', () => {
    const files = scannedFiles().filter((file) => file !== HOOK_FILE);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise
    // make this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = files.filter((file) => !(file in ALLOWED) && emitsSubscribe(file));

    expect(
      violations,
      'These files emit a raw `<ns>:subscribe` for a registerSubscriber namespace. The '
      + 'server rebuilds an empty per-socket subscriber Set on every reconnect (restart, '
      + 'self-update, sleep, a network blip), so a one-shot emit at mount goes permanently '
      + "dead the first time it fires (#8110).\n"
      + "Fix: `useSocketSubscription(namespace, { onResubscribe })` from "
      + "`client/src/hooks/useSocketSubscription.js` — it refcounts across consumers of the "
      + "same namespace, re-emits subscribe on every connect, and calls `onResubscribe` so "
      + "you can refetch what was missed while disconnected.\n"
      + 'If this file already re-subscribes correctly on `connect` by hand, add it to '
      + `ALLOWED in this file with a one-line reason.\nOffenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Burn-down: an allowlist entry that no longer needs to be there must go, or
  // the list quietly becomes a list of files nobody has looked at in a year.
  it('has no stale allowlist entry', () => {
    const missing = Object.keys(ALLOWED).filter((file) => !existsSync(join(CLIENT_ROOT, file)));
    expect(missing, `Allowlisted files that no longer exist:\n  ${missing.join('\n  ')}`).toEqual([]);

    const noLongerNeeded = Object.keys(ALLOWED).filter((file) => !emitsSubscribe(file));
    expect(
      noLongerNeeded,
      'These files are allowlisted but no longer emit a raw `<ns>:subscribe`. Delete their '
      + `rows from ALLOWED.\n  ${noLongerNeeded.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: a detector that stopped recognizing the banned call would
  // make the scan above vacuously green and let the bug class walk back in.
  it('recognizes a namespace subscribe and nothing that merely looks like one', () => {
    expect(SUBSCRIBE_CALL.test("socket.emit('notifications:subscribe')")).toBe(true);
    expect(SUBSCRIBE_CALL.test('socket.emit("loops:subscribe")')).toBe(true);
    expect(SUBSCRIBE_CALL.test("socket.emit('cos:subscribe', { taskLists: 'full' })")).toBe(true);

    expect(SUBSCRIBE_CALL.test("socket.emit('notifications:unsubscribe')")).toBe(false);
    expect(SUBSCRIBE_CALL.test("socket.emit('loop:output')")).toBe(false);
    expect(SUBSCRIBE_CALL.test("socket.emit(`${namespace}:subscribe`)")).toBe(false);
    expect(SUBSCRIBE_CALL.test("socket.on('notifications:subscribed', handler)")).toBe(false);
  });
});
