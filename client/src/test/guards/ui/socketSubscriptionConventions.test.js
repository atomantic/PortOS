/**
 * Rule: Client files emitting `<ns>:subscribe` for a `registerSubscriber` namespace must use `hooks/useSocketSubscription.js`.
 * Fix: Replace one-shot `socket.emit('<ns>:subscribe')` with `useSocketSubscription`.
 * What this guard cannot see: dynamic template strings (`` `${ns}:subscribe` ``).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

// The namespaces `registerSubscriber` wires up in server/services/socket.js.
const SUBSCRIBER_NAMESPACES = ['cos', 'errors', 'notifications', 'agents', 'instances', 'loops', 'beeper', 'command'];

const SUBSCRIBE_CALL = new RegExp(
  `emit\\(\\s*['"](?:${SUBSCRIBER_NAMESPACES.join('|')}):subscribe['"]`
);

// The hook itself — the only file allowed to emit these literals unconditionally.
const HOOK_FILE = 'src/hooks/useSocketSubscription.js';

const scannedFiles = () => trackedSourceFiles(CLIENT_ROOT);

const emitsSubscribe = (file) => SUBSCRIBE_CALL.test(readText(join(CLIENT_ROOT, file)));

describe('socket namespace subscriptions go through useSocketSubscription', () => {
  it('has no raw <ns>:subscribe emit outside the hook', () => {
    const files = scannedFiles().filter((file) => file !== HOOK_FILE);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise
    // make this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = files.filter((file) => emitsSubscribe(file));

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
      + `Offenders:\n  ${violations.join('\n  ')}`,
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
