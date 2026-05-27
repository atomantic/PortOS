// Persistent, dedup-aware one-shot timers for the voice CoS `timer_set` tool.
//
// A bare in-memory `setTimeout` has two edge-case failures (xhigh review,
// 2026-05-25): it's lost silently when the server restarts before the timer
// fires, and an LLM re-issuing the same `timer_set` call inside one reasoning
// loop arms a second identical timer → the user hears the reminder twice.
//
// This module fixes both: pending timers are snapshotted to disk (re-armed at
// boot, firing any that came due while the process was down), and a near-
// identical `(label, fireAt)` request is collapsed onto the existing timer.

import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from '../notifications.js';

const STORE_PATH = join(PATHS.data, 'voice-timers.json');
const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // mirror the tool's 24h cap

// Two `timer_set` calls with the same label whose fire times land within this
// window are treated as one. An LLM re-issuing the tool inside a single
// reasoning loop produces `fireAt` values milliseconds apart, so a few seconds
// of tolerance collapses the duplicate without merging two genuinely distinct
// reminders a user set seconds apart (harmless either way — the worst case is
// one notification instead of two).
const DEDUP_WINDOW_MS = 10_000;

// id -> { id, label, fireAt, createdAt, handle }. Authoritative in-memory
// state; the JSON file is just a snapshot of it, so a read-modify-write race
// between a fire (remove) and a schedule (add) can't drop a timer.
const active = new Map();

// Serialize snapshot writes onto a single tail so a fire and a schedule can't
// clobber each other's atomicWrite. The snapshot is taken synchronously at call
// time; only the write is deferred onto the queue.
const queueWrite = createFileWriteQueue();
function persist() {
  const timers = [...active.values()].map(({ handle, ...rec }) => rec);
  return queueWrite(() =>
    atomicWrite(STORE_PATH, { version: 1, timers }).catch((err) =>
      console.error(`❌ voice-timer persist failed: ${err.message}`)
    )
  );
}

// Raise the reminder. Runs outside the request lifecycle, so the write is
// guarded (per CLAUDE.md) — a thrown notification write can't crash the process.
function notify(timer, { overdue = false } = {}) {
  return addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: `⏰ ${timer.label}`,
    description: overdue
      ? 'Timer you set went off while PortOS was restarting.'
      : 'Timer you set is up.',
    priority: PRIORITY_LEVELS.HIGH,
    metadata: { source: 'voice-timer', timerId: timer.id },
  }).catch((err) => {
    console.error(`❌ voice-timer notification failed: ${err.message}`);
  });
}

// Fire a timer: drop it from state first (so any concurrent persist reflects the
// removal), then notify.
async function fire(timer) {
  active.delete(timer.id);
  await persist();
  await notify(timer);
}

// Arm a Node timer for a still-pending record. Both callers bound `fireAt` to at
// most MAX_DURATION_MS out (scheduleTimer validates the duration; initVoiceTimers
// drops implausible records), so the delay is always within setTimeout's int32
// max — never the silent clamp-to-1ms-and-fire-now that an overflowing delay
// triggers. `unref` so a lone pending timer never keeps the process (or a test
// runner) alive on its own.
function arm(timer) {
  const delay = Math.max(0, timer.fireAt - Date.now());
  timer.handle = setTimeout(() => {
    fire(timer).catch((err) => console.error(`❌ voice-timer fire failed: ${err.message}`));
  }, delay);
  timer.handle.unref?.();
  active.set(timer.id, timer);
}

// Find an already-armed timer that a new (label, fireAt) request duplicates.
function findDuplicate(label, fireAt) {
  for (const t of active.values()) {
    if (t.label === label && Math.abs(t.fireAt - fireAt) <= DEDUP_WINDOW_MS) return t;
  }
  return null;
}

/**
 * Schedule a one-shot timer. Returns `{ id, fireAt, deduped }` — `deduped: true`
 * means an equivalent timer was already armed and this call was a no-op.
 * Returns `null` for an out-of-range duration (callers validate first; this is
 * a defensive guard so a bad value never arms a runaway/zero timer).
 */
export function scheduleTimer({ totalMs, label } = {}) {
  if (!Number.isFinite(totalMs) || totalMs < 1000 || totalMs > MAX_DURATION_MS) return null;
  const fireAt = Date.now() + totalMs;
  const dup = findDuplicate(label, fireAt);
  if (dup) return { id: dup.id, fireAt: dup.fireAt, deduped: true };
  const timer = { id: randomUUID(), label, fireAt, createdAt: Date.now() };
  arm(timer);
  persist();
  return { id: timer.id, fireAt, deduped: false };
}

// Idempotency guard so a double-call (re-init, tests) can't double-arm.
let initialized = false;

/**
 * Re-arm persisted timers at boot. Any that came due while the process was down
 * fire immediately (once); the rest re-arm for their remaining delay. The store
 * is then rewritten with only the still-pending timers.
 */
export async function initVoiceTimers() {
  if (initialized) return { skipped: true };
  initialized = true;
  const stored = await readJSONFile(STORE_PATH, { version: 1, timers: [] });
  const list = Array.isArray(stored?.timers) ? stored.timers : [];
  const now = Date.now();
  let armed = 0;
  let fired = 0;
  const seen = new Set(); // ids already handled this init (dedup a corrupt store)
  for (const rec of list) {
    // The store is an untrusted read boundary (hand-edited / partial write).
    // `Number.isFinite` rejects NaN/Infinity that `typeof === 'number'` lets
    // through; the upper bound rejects a corrupt far-future `fireAt` — the write
    // path caps every timer at MAX_DURATION_MS out, so anything farther can't be
    // a real timer and must not reach arm() (an overflowing setTimeout delay
    // silently clamps to ~0 and fires a phantom reminder).
    if (!rec || !Number.isFinite(rec.fireAt) || typeof rec.label !== 'string') continue;
    if (rec.fireAt - now > MAX_DURATION_MS) continue;
    const timer = {
      id: typeof rec.id === 'string' && rec.id ? rec.id : randomUUID(),
      label: rec.label,
      fireAt: rec.fireAt,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : now,
    };
    // Skip a record already handled, so it can't double-notify:
    //   - `active.has` — a timer_set scheduled post-boot (during init's async
    //     read; routes are up before this fire-and-forget init settles) is live
    //     in memory and authoritative.
    //   - `seen.has` — a duplicate id earlier in a corrupt/hand-edited store.
    //     `active` alone misses this when the records are OVERDUE, since overdue
    //     timers fire-and-drop without being added to `active`.
    if (active.has(timer.id) || seen.has(timer.id)) continue;
    seen.add(timer.id);
    if (timer.fireAt <= now) {
      // Overdue — notify once. Not added to `active`, so the post-loop persist
      // drops it from the store.
      await notify(timer, { overdue: true });
      fired += 1;
    } else {
      arm(timer);
      armed += 1;
    }
  }
  await persist();
  if (armed || fired) console.log(`⏰ voice-timers: re-armed ${armed}, fired ${fired} overdue`);
  return { armed, fired };
}

// Test helper — clear all in-memory timers + handles and reset the init guard.
export function __resetVoiceTimers() {
  for (const t of active.values()) clearTimeout(t.handle);
  active.clear();
  initialized = false;
}
