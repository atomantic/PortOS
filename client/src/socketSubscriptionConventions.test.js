// @vitest-environment node

/**
 * Rule: Client files emitting `<ns>:subscribe` for a `registerSubscriber` namespace must use `hooks/useSocketSubscription.js` (except allowlisted legacy hooks).
 * Fix: Replace one-shot `socket.emit('<ns>:subscribe')` with `useSocketSubscription`.
 * What this guard cannot see:
 *   - Dynamic template strings (`` `${ns}:subscribe` ``) are invisible.
 *   - Cannot distinguish an allowlisted file's sanctioned connect-resubscribe from a second unguarded emit added later.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The namespaces `registerSubscriber` wires up in server/services/socket.js.
const SUBSCRIBER_NAMESPACES = ['cos', 'errors', 'notifications', 'agents', 'instances', 'loops', 'beeper', 'command'];

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
  'src/hooks/useMoltworldWs.js': 're-subscribes agents:* on connect already',
};

// The namespaces every consumer must reach through the hook — no allowlist
// row may name one of these. A cos:* row quietly re-admitted the bug class
// this guard exists for (#12033: a Layout toast hook that never re-subscribed
// on reconnect, carried by whichever sibling happened to).
const NO_ALLOWLIST_NAMESPACES = ['cos'];

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

  it('never allowlists a cos:* subscriber', () => {
    const rows = Object.entries(ALLOWED).filter(([file]) => {
      const source = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      return NO_ALLOWLIST_NAMESPACES.some((ns) => new RegExp(`emit\\(\\s*['"]${ns}:subscribe['"]`).test(source));
    });
    expect(rows.map(([file]) => file), 'cos:* subscribers go through useSocketSubscription (#12033)').toEqual([]);
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
