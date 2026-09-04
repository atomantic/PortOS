import { describe, expect, it } from 'vitest';
import {
  PERSISTENT_MIND_LIMITS,
  createDefaultPersistentMindState,
  holdPersistentMindWake,
  persistentMindMessageFingerprint,
  persistentMindWakeConsumesAttempt,
  nextPersistentMindWakeAt,
  normalizePersistentMindState,
  persistentMindBackoffMs,
  persistentMindCallRateVerdict,
  persistentMindImageWorkGuard,
  recordPersistentMindCall,
  persistentMindTurnIsStale,
  requeuePersistentMindWake,
  takeNextPersistentMindWake,
} from './persistentMind.js';

const iso = (ms) => new Date(ms).toISOString();

describe('persistent mind state', () => {
  it('defaults to opt-in, stopped, and silent', () => {
    expect(createDefaultPersistentMindState()).toMatchObject({
      enabled: false,
      started: false,
      status: 'disabled',
      queuedMessages: [],
      pendingAttachments: [],
      recentMessageFingerprints: [],
      selfWake: null,
      activeTurn: null,
    });
  });

  it('normalizes a partial legacy shape without treating missing state as enabled', () => {
    const state = normalizePersistentMindState({ started: true, queuedMessages: [{ id: 'm1', text: 'hello' }] });
    expect(state.enabled).toBe(false);
    expect(state.started).toBe(false);
    expect(state.status).toBe('disabled');
    expect(state.queuedMessages).toEqual([{ id: 'm1', text: 'hello', createdAt: iso(0) }]);
  });

  it('classifies unmarked legacy self-wakes as requested without trusting their reason text', () => {
    const state = normalizePersistentMindState({
      enabled: true,
      started: true,
      selfWake: {
        id: 'w1',
        kind: 'self',
        reason: 'maximum quiet period elapsed',
        sourceTurnId: 't1',
        createdAt: iso(1),
        notBefore: iso(2),
      },
    });

    expect(state.selfWake).toMatchObject({ scheduleKind: 'requested' });
    expect(normalizePersistentMindState({
      enabled: true,
      started: true,
      selfWake: { ...state.selfWake, scheduleKind: 'quiet' },
    }).selfWake).toMatchObject({ scheduleKind: 'quiet' });
  });

  it('does not preserve a running status when the durable started flag is false', () => {
    const activeTurn = {
      id: 't1',
      wake: { kind: 'message', message: { id: 'm1', text: 'keep me', createdAt: iso(1) } },
      startedAt: iso(1), heartbeatAt: iso(1), providerId: null, model: null, effort: null,
    };
    const stopped = normalizePersistentMindState({ enabled: true, started: false, status: 'thinking', activeTurn });
    expect(stopped.status).toBe('idle');
    expect(stopped.activeTurn).toBeNull();
    expect(stopped.queuedMessages.map((message) => message.id)).toEqual(['m1']);
    expect(normalizePersistentMindState({ enabled: true, started: true, status: 'disabled' }).status).toBe('idle');
  });

  it('keeps FIFO user messages ahead of a due self-wake', () => {
    const base = {
      ...createDefaultPersistentMindState(), enabled: true, started: true, status: 'waiting',
      queuedMessages: [
        { id: 'm1', text: 'first', createdAt: iso(1) },
        { id: 'm2', text: 'second', createdAt: iso(2) },
      ],
      selfWake: { id: 'w1', kind: 'self', reason: 'idle', sourceTurnId: 't0', createdAt: iso(1), notBefore: iso(2) },
    };
    const first = takeNextPersistentMindWake(base, 10);
    const second = takeNextPersistentMindWake(first.state, 10);
    const third = takeNextPersistentMindWake(second.state, 10);
    expect(first.wake.message.id).toBe('m1');
    expect(second.wake.message.id).toBe('m2');
    expect(third.wake.id).toBe('w1');
  });

  it('does not consume work before the retry or self-wake deadline', () => {
    const state = {
      ...createDefaultPersistentMindState(), enabled: true, started: true,
      queuedMessages: [{ id: 'm1', text: 'wait', createdAt: iso(1) }],
      nextEligibleWakeAt: iso(1_000),
    };
    expect(takeNextPersistentMindWake(state, 500)).toMatchObject({ wake: null, dueAt: 1_000 });
    expect(nextPersistentMindWakeAt(state, 500)).toBe(1_000);
  });

  it('requeues an interrupted message once and never resurrects a completed id', () => {
    const wake = { kind: 'message', message: { id: 'm1', text: 'keep me', createdAt: iso(1) } };
    const once = requeuePersistentMindWake(createDefaultPersistentMindState(), wake);
    const twice = requeuePersistentMindWake(once, wake);
    const completed = requeuePersistentMindWake({ ...once, queuedMessages: [], recentMessageIds: ['m1'] }, wake);
    expect(twice.queuedMessages).toHaveLength(1);
    expect(completed.queuedMessages).toHaveLength(0);
  });

  it('preserves bounded image references for image-only messages through requeue normalization', () => {
    const attachment = {
      attachmentId: 'attachment-1',
      filename: 'mind-attachment-1.png',
      originalName: 'diagram.png',
      mimeType: 'image/png',
      size: 128,
      uploadedAt: iso(1),
      claimedBy: 'message-1',
      expiresAt: null,
    };
    const state = normalizePersistentMindState({
      enabled: true,
      started: true,
      status: 'waiting',
      pendingAttachments: [attachment],
      queuedMessages: [{ id: 'message-1', text: '', images: [attachment], createdAt: iso(1) }],
    });
    expect(state.pendingAttachments).toMatchObject([{ attachmentId: 'attachment-1', claimedBy: 'message-1', expiresAt: null }]);
    expect(state.queuedMessages[0]).toMatchObject({
      id: 'message-1',
      text: '',
      images: [{ attachmentId: 'attachment-1', path: '/api/screenshots/mind-attachment-1.png' }],
    });
    const requeued = requeuePersistentMindWake({ ...state, queuedMessages: [] }, {
      kind: 'message',
      message: state.queuedMessages[0],
    });
    expect(requeued.queuedMessages[0].images).toEqual(state.queuedMessages[0].images);
  });

  it('drops image-only messages whose durable image reference is not safe', () => {
    const state = normalizePersistentMindState({
      queuedMessages: [{
        id: 'message-1',
        text: '',
        images: [{
          attachmentId: 'attachment-1',
          filename: '../outside.png',
          originalName: 'outside.png',
          mimeType: 'image/png',
          size: 128,
          uploadedAt: iso(1),
        }],
      }],
    });
    expect(state.queuedMessages).toEqual([]);
  });

  it('preserves image references when a stopped active turn returns to the queue', () => {
    const image = {
      attachmentId: 'attachment-1',
      filename: 'mind-attachment-1.png',
      originalName: 'diagram.png',
      mimeType: 'image/png',
      size: 128,
      uploadedAt: iso(1),
    };
    const state = normalizePersistentMindState({
      enabled: true,
      started: false,
      status: 'thinking',
      activeTurn: {
        id: 'turn-1',
        wake: {
          kind: 'message',
          message: { id: 'message-1', text: '', images: [image], createdAt: iso(1) },
        },
        startedAt: iso(1),
        heartbeatAt: iso(1),
      },
    });

    expect(state.activeTurn).toBeNull();
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        images: [expect.objectContaining({ attachmentId: 'attachment-1' })],
      }),
    ]);
  });

  it('fails the source-transition guard for raw queued or active image work', () => {
    expect(persistentMindImageWorkGuard({
      queuedMessages: [{ id: 'queued-image', images: [{ attachmentId: 'attachment-1' }] }],
      activeTurn: {
        wake: {
          kind: 'message',
          message: { id: 'active-image', images: [{ attachmentId: 'attachment-2' }] },
        },
      },
    })).toEqual({ safe: false, trusted: true, queuedImageMessages: 1, activeImageMessage: true });
    expect(persistentMindImageWorkGuard({
      queuedMessages: [{ id: 'text-only', text: 'Safe to preserve.' }],
      pendingAttachments: [{ attachmentId: 'completed-asset', claimedBy: 'completed-message' }],
    })).toEqual({ safe: true, trusted: true, queuedImageMessages: 0, activeImageMessage: false });
    expect(persistentMindImageWorkGuard({
      queuedMessages: { corrupted: true },
      activeTurn: null,
    })).toEqual({ safe: false, trusted: false, queuedImageMessages: 0, activeImageMessage: false });
  });

  it('caps exponential backoff and detects stale heartbeats at the boundary', () => {
    expect(persistentMindBackoffMs(1)).toBe(PERSISTENT_MIND_LIMITS.BACKOFF_BASE_MS);
    expect(persistentMindBackoffMs(99)).toBe(PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS);
    const state = {
      ...createDefaultPersistentMindState(), enabled: true, started: true, status: 'thinking',
      activeTurn: {
        id: 't1',
        wake: { kind: 'message', message: { id: 'm1', text: 'hello', createdAt: iso(1) } },
        startedAt: iso(1), heartbeatAt: iso(1), providerId: null, model: null, effort: null,
      },
    };
    expect(persistentMindTurnIsStale(state, 1 + PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS - 1)).toBe(false);
    expect(persistentMindTurnIsStale(state, 1 + PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS)).toBe(true);
  });

  it('caps outbound calls from durable state so a restart cannot reset the budget', () => {
    const CAPS = { maxPerRollingDay: 3, rollingWindowMs: 86_400_000, minGapMs: 1_800_000 };
    const now = Date.parse('2026-08-28T12:00:00.000Z');
    const at = (minutesAgo) => iso(now - minutesAgo * 60_000);

    expect(persistentMindCallRateVerdict(createDefaultPersistentMindState(), now, CAPS))
      .toMatchObject({ ok: true, callsInWindow: 0 });

    // The gap cap is what stops a burst of urgent-feeling wakes from redialing.
    expect(persistentMindCallRateVerdict({ callHistory: [{ at: at(29) }] }, now, CAPS))
      .toMatchObject({ ok: false, reason: 'too-soon' });
    expect(persistentMindCallRateVerdict({ callHistory: [{ at: at(30) }] }, now, CAPS))
      .toMatchObject({ ok: true });

    // Three inside the window is the ceiling; the fourth is rate-capped even
    // though the gap since the last one is fine.
    const three = { callHistory: [{ at: at(600) }, { at: at(300) }, { at: at(60) }] };
    expect(persistentMindCallRateVerdict(three, now, CAPS)).toMatchObject({ ok: false, reason: 'rate-capped', callsInWindow: 3 });
    // The same three calls age out of the rolling window rather than being
    // forgiven by a restart — a day later the budget is available again.
    expect(persistentMindCallRateVerdict(three, now + 86_400_000, CAPS)).toMatchObject({ ok: true, callsInWindow: 0 });

    // A clock rollback (or a hand-edited future timestamp) must fail closed.
    expect(persistentMindCallRateVerdict({ callHistory: [{ at: iso(now + 60_000) }] }, now, CAPS))
      .toMatchObject({ ok: false, reason: 'too-soon' });
  });

  it('keeps the call ledger bounded and free of the dialed handle', () => {
    let state = createDefaultPersistentMindState();
    for (let index = 0; index < PERSISTENT_MIND_LIMITS.MAX_CALL_HISTORY + 5; index += 1) {
      state = recordPersistentMindCall(state, { at: iso(index * 60_000), reason: `call ${index}`, source: 'mind' });
    }
    expect(state.callHistory).toHaveLength(PERSISTENT_MIND_LIMITS.MAX_CALL_HISTORY);
    expect(state.callHistory.at(-1)).toMatchObject({ reason: 'call 24', source: 'mind' });
    // Anything a caller tries to smuggle alongside the record is dropped: the
    // handle is the user's phone number and never belongs in durable state.
    const smuggled = recordPersistentMindCall(createDefaultPersistentMindState(), {
      at: iso(1), reason: 'urgent', source: 'mind',
    });
    expect(Object.keys(smuggled.callHistory[0]).sort()).toEqual(['at', 'reason', 'source']);
    expect(normalizePersistentMindState({ callHistory: [{ reason: 'no timestamp' }, { at: 'not-a-date' }] }).callHistory).toEqual([]);
  });

  it('keeps a message-level temporary thinking session durable and out of the default route', () => {
    const message = { id: 'message-1', text: 'Try the deep model.', thinkingPresetId: 'deep', createdAt: iso(1) };
    const state = normalizePersistentMindState({ enabled: true, started: true, queuedMessages: [message] });
    expect(state.queuedMessages[0].thinkingPresetId).toBe('deep');

    // Hand-edited or downgraded state cannot smuggle in an unusable selection.
    expect(normalizePersistentMindState({
      enabled: true, started: true, queuedMessages: [{ ...message, thinkingPresetId: '../escape' }],
    }).queuedMessages[0].thinkingPresetId).toBeUndefined();

    // The selection is content: the same text on another model is a different
    // request, but a message without one must hash exactly as it always did.
    expect(persistentMindMessageFingerprint(message))
      .not.toBe(persistentMindMessageFingerprint({ ...message, thinkingPresetId: 'fast' }));
    expect(persistentMindMessageFingerprint({ id: 'message-1', text: 'Try the deep model.' }))
      .toBe(persistentMindMessageFingerprint({ id: 'message-1', text: 'Try the deep model.', thinkingPresetId: '' }));
  });

  it('never automatically replays a temporary session whose provider span may already have opened', () => {
    const temporary = { kind: 'message', message: { id: 'paid-1', text: 'Deep pass please.', thinkingPresetId: 'deep', createdAt: iso(1) } };
    const ordinary = { kind: 'message', message: { id: 'plain-1', text: 'Ordinary.', createdAt: iso(1) } };
    expect(persistentMindWakeConsumesAttempt(temporary)).toBe(true);
    expect(persistentMindWakeConsumesAttempt(ordinary)).toBe(false);
    expect(persistentMindWakeConsumesAttempt({ kind: 'self', id: 'wake-1' })).toBe(false);

    const base = { enabled: true, started: true };
    // An ordinary interrupted message still retries on its own.
    expect(requeuePersistentMindWake(base, ordinary).queuedMessages.map((m) => m.id)).toEqual(['plain-1']);

    const held = holdPersistentMindWake(base, temporary);
    expect(held.queuedMessages).toEqual([]);
    expect(held.recentMessageIds).toEqual(['paid-1']);
    expect(held.recentMessageFingerprints).toEqual([
      { id: 'paid-1', fingerprint: persistentMindMessageFingerprint(temporary.message) },
    ]);
    // The recorded fingerprint is the one an idempotent same-id retry computes,
    // so the retry reads as a completed duplicate instead of new paid work.
    expect(held.recentMessageFingerprints[0].fingerprint)
      .not.toBe(persistentMindMessageFingerprint({ ...temporary.message, thinkingPresetId: 'fast' }));
  });

  it('retires, rather than requeues, a temporary session that a restart found mid-turn', () => {
    const message = { id: 'paid-1', text: 'Deep pass please.', thinkingPresetId: 'deep', createdAt: iso(1) };
    const recovered = normalizePersistentMindState({
      enabled: true,
      started: false,
      activeTurn: { id: 'mind-turn-1', wake: { kind: 'message', message }, startedAt: iso(1) },
    });
    expect(recovered.activeTurn).toBeNull();
    expect(recovered.queuedMessages).toEqual([]);
    expect(recovered.recentMessageIds).toEqual(['paid-1']);

    // An ordinary message keeps its free, automatic restart recovery.
    const ordinary = normalizePersistentMindState({
      enabled: true,
      started: false,
      activeTurn: { id: 'mind-turn-2', wake: { kind: 'message', message: { id: 'plain-1', text: 'Ordinary.', createdAt: iso(1) } }, startedAt: iso(1) },
    });
    expect(ordinary.queuedMessages.map((item) => item.id)).toEqual(['plain-1']);
    expect(ordinary.recentMessageIds).toEqual([]);
  });
});
