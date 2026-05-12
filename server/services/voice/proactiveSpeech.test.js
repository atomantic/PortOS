import { describe, it, expect, vi } from 'vitest';

// Stub config + tts + timezone before importing the module — the pure-function
// branches need no mocks but speakProactive integration does.
vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: { proactive: { enabled: true, quietHours: { enabled: false, start: '22:00', end: '07:00' } } },
  })),
}));
vi.mock('./tts.js', () => ({
  synthesize: vi.fn(async () => ({ wav: Buffer.alloc(64), latencyMs: 12 })),
}));
vi.mock('../../lib/timezone.js', () => ({
  getUserTimezone: vi.fn(async () => 'UTC'),
  getLocalParts: vi.fn(() => ({ hour: 14, minute: 0 })),
}));

const {
  parseHHMM,
  isWithinQuietHours,
  shouldSpeak,
  speakProactive,
} = await import('./proactiveSpeech.js');

describe('parseHHMM', () => {
  it.each([
    ['00:00', 0],
    ['07:00', 420],
    ['22:00', 1320],
    ['23:59', 23 * 60 + 59],
    ['9:30', 9 * 60 + 30],
  ])('parses %s → %s', (s, expected) => {
    expect(parseHHMM(s)).toBe(expected);
  });

  it.each(['', '24:00', '12:60', 'abc', null, undefined, '12'])('rejects %s', (s) => {
    expect(parseHHMM(s)).toBeNull();
  });
});

describe('isWithinQuietHours — same-day window', () => {
  const win = { start: '09:00', end: '17:00' };

  it('inside window', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 10 * 60 })).toBe(true);
  });

  it('exactly at start (inclusive)', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 9 * 60 })).toBe(true);
  });

  it('exactly at end (exclusive)', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 17 * 60 })).toBe(false);
  });

  it('before window', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 8 * 60 })).toBe(false);
  });

  it('after window', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 18 * 60 })).toBe(false);
  });
});

describe('isWithinQuietHours — overnight wrap', () => {
  const win = { start: '22:00', end: '07:00' };

  it('late-evening inside', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 23 * 60 })).toBe(true);
  });

  it('early-morning inside', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 5 * 60 })).toBe(true);
  });

  it('midday outside', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 14 * 60 })).toBe(false);
  });

  it('exactly at end (exclusive)', () => {
    expect(isWithinQuietHours({ ...win, nowMinutes: 7 * 60 })).toBe(false);
  });
});

describe('isWithinQuietHours — malformed/empty', () => {
  it('start==end is empty window', () => {
    expect(isWithinQuietHours({ start: '08:00', end: '08:00', nowMinutes: 8 * 60 })).toBe(false);
  });

  it('malformed start returns false', () => {
    expect(isWithinQuietHours({ start: 'abc', end: '07:00', nowMinutes: 5 * 60 })).toBe(false);
  });
});

describe('shouldSpeak — decision matrix', () => {
  it('blocks when voice disabled', () => {
    expect(shouldSpeak({ enabled: false }, 0).ok).toBe(false);
  });

  it('blocks when proactive disabled', () => {
    expect(shouldSpeak({ enabled: true, llm: { proactive: { enabled: false } } }, 0).ok).toBe(false);
  });

  it('allows when proactive enabled and quiet hours off', () => {
    const cfg = { enabled: true, llm: { proactive: { enabled: true, quietHours: { enabled: false, start: '22:00', end: '07:00' } } } };
    expect(shouldSpeak(cfg, 14 * 60)).toEqual({ ok: true });
  });

  it('blocks during quiet hours when enabled', () => {
    const cfg = { enabled: true, llm: { proactive: { enabled: true, quietHours: { enabled: true, start: '22:00', end: '07:00' } } } };
    const d = shouldSpeak(cfg, 23 * 60);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('quiet-hours');
  });

  it('allows during awake hours when quiet hours enabled', () => {
    const cfg = { enabled: true, llm: { proactive: { enabled: true, quietHours: { enabled: true, start: '22:00', end: '07:00' } } } };
    expect(shouldSpeak(cfg, 14 * 60).ok).toBe(true);
  });
});

describe('speakProactive', () => {
  const makeIo = () => {
    const emit = vi.fn();
    return { io: { emit }, emit };
  };

  it('returns no-io when io missing', async () => {
    const r = await speakProactive({ io: null, text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-io');
  });

  it('returns empty when text blank', async () => {
    const { io } = makeIo();
    const r = await speakProactive({ io, text: '   ' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
  });

  it('emits voice:speak with audio when allowed', async () => {
    const { io, emit } = makeIo();
    const r = await speakProactive({ io, text: 'Heads up — meeting in five.' });
    expect(r.ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe('voice:speak');
    expect(payload.sentence).toBe('Heads up — meeting in five.');
    expect(payload.wav).toBeInstanceOf(Buffer);
    expect(payload.priority).toBe('normal');
    expect(payload.source).toBe('cos');
  });

  it('suppresses when proactive disabled', async () => {
    const { getVoiceConfig } = await import('./config.js');
    getVoiceConfig.mockResolvedValueOnce({
      enabled: true,
      llm: { proactive: { enabled: false } },
    });
    const { io, emit } = makeIo();
    const r = await speakProactive({ io, text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('proactive-disabled');
    expect(emit).not.toHaveBeenCalled();
  });

  it('suppresses during quiet hours', async () => {
    const { getVoiceConfig } = await import('./config.js');
    const { getLocalParts } = await import('../../lib/timezone.js');
    getVoiceConfig.mockResolvedValueOnce({
      enabled: true,
      llm: { proactive: { enabled: true, quietHours: { enabled: true, start: '22:00', end: '07:00' } } },
    });
    getLocalParts.mockReturnValueOnce({ hour: 23, minute: 30 });
    const { io, emit } = makeIo();
    const r = await speakProactive({ io, text: 'late night ping' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('quiet-hours');
    expect(emit).not.toHaveBeenCalled();
  });
});
