import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', () => ({ getVoiceConfig: vi.fn() }));
// getToday is ASYNC in production (it reads the configured timezone). Mocking it
// sync made this suite pass against an unawaited call whose pending Promise
// appendJournal's isIsoDate() guard silently rejected, so no transcript was ever
// written. The mock has to match the real signature for the assertion to mean anything.
vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: async () => '2026-08-29' }));
vi.mock('./facetimeBridge.js', () => ({ probe: vi.fn(), call: vi.fn(), answer: vi.fn(), hangup: vi.fn() }));
vi.mock('../notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' },
}));
// Real proactiveSpeech.js pulls in tts.js (Kokoro/Piper), which reads
// voiceHome() at module-load time — importing it for real here would need the
// whole TTS engine graph booted just to compute a quiet-hours boolean. Only
// the wall clock behind isWithinQuietHours is injected; the predicate itself
// is the real one so the overnight-wrap logic is genuinely exercised.
vi.mock('./proactiveSpeech.js', async () => ({
  isWithinQuietHours: (await import('../../lib/timezone.js')).isWithinTimeWindow,
  getLocalMinutes: vi.fn(async () => 12 * 60),
}));

import { getVoiceConfig } from './config.js';
import { addNotification } from '../notifications.js';
import { getLocalMinutes } from './proactiveSpeech.js';
import {
  PROBE_INTERVAL_MS,
  SILENCE_HANGUP_MS,
  __resetCallSession,
  __setCallSessionDeps,
  attachHost,
  callStateEvents,
  detachHost,
  endCall,
  getCallContext,
  getCallState,
  markSpeaking,
  noteCallerSpeech,
  pollCall,
  pollIncoming,
  recordTurn,
  setCallStateListener,
  startCall,
  takeCallOpeningLine,
} from './callSession.js';

const socket = (id = 'host-1') => ({ id, connected: true, emit: vi.fn() });

let clock;
let probe;
let call;
let answer;
let hangup;
let appendJournal;
let enqueueMindMessage;
let isMindEnabled;
let buildInboundContext;

const install = (overrides = {}) => {
  clock = 1_000_000;
  probe = vi.fn().mockResolvedValue({ state: 'connected' });
  call = vi.fn().mockResolvedValue({ state: 'dialing' });
  answer = vi.fn().mockResolvedValue({ ok: true, command: 'answer', state: 'connected', authorized: true, action: 'press-notification-action', message: 'Answered', errorCode: null });
  hangup = vi.fn().mockResolvedValue({ state: 'ended' });
  appendJournal = vi.fn().mockResolvedValue({});
  enqueueMindMessage = vi.fn().mockResolvedValue({ success: true });
  isMindEnabled = vi.fn().mockResolvedValue(false);
  buildInboundContext = vi.fn().mockResolvedValue('# Persistent mind identity');
  __setCallSessionDeps({ probe, call, answer, hangup, appendJournal, enqueueMindMessage, isMindEnabled, buildInboundContext, now: () => clock, ...overrides });
};

beforeEach(() => {
  __resetCallSession();
  install();
  getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15 } });
  getLocalMinutes.mockResolvedValue(12 * 60);
  addNotification.mockClear();
});

afterEach(() => { __resetCallSession(); vi.useRealTimers(); });

describe('FaceTime call session', () => {
  it('refuses to dial without an attached call host', async () => {
    // A call nobody can hear is worse than no call: this is the fail-closed
    // gate, not a convenience check.
    expect(await startCall()).toEqual({ ok: false, reason: 'no-call-host' });
    expect(call).not.toHaveBeenCalled();
    expect(getCallState()).toMatchObject({ state: 'idle', active: false, hostAttached: false });
  });

  it('gives the single host slot to the first tab and refuses the second', () => {
    const first = socket('host-1');
    expect(attachHost(first)).toMatchObject({ ok: true });
    expect(attachHost(socket('host-2'))).toEqual({ ok: false, reason: 'host-taken' });
    // Re-attaching the incumbent is a reconnect, not a second owner.
    expect(attachHost(first)).toMatchObject({ ok: true });
  });

  it('reaches connected through a probe, not through what it asked for', async () => {
    attachHost(socket());
    probe.mockResolvedValue({ state: 'dialing' });

    expect(await startCall({ openingLine: 'Hi' })).toMatchObject({ ok: true, openingLine: 'Hi' });
    expect(getCallState().state).toBe('dialing');

    // Still ringing: the helper has not seen a pickup, so neither has PortOS.
    await pollCall();
    expect(getCallState().state).toBe('dialing');

    probe.mockResolvedValue({ state: 'connected' });
    await pollCall();
    expect(getCallState()).toMatchObject({ state: 'listening', active: true });
  });

  it('refuses a second call while one is up', async () => {
    attachHost(socket());
    await startCall();
    expect(await startCall()).toEqual({ ok: false, reason: 'call-in-progress' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reports a failed dial without leaving the session stuck dialing', async () => {
    attachHost(socket());
    call.mockRejectedValue(new Error('helper timed out'));

    expect(await startCall()).toMatchObject({ ok: false, reason: 'dial-failed', message: 'helper timed out' });
    expect(getCallState()).toMatchObject({ state: 'idle', active: false });
  });

  it('treats a probe failure as unknown, never as a hangup', async () => {
    attachHost(socket());
    await startCall();
    probe.mockRejectedValue(new Error('helper crashed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await pollCall();

    expect(getCallState().active).toBe(true);
    expect(hangup).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('ends when the caller hangs up on their own device', async () => {
    attachHost(socket());
    await startCall();
    probe.mockResolvedValue({ state: 'ended' });

    await pollCall();

    expect(getCallState()).toMatchObject({ state: 'idle', active: false, endedReason: 'remote-hangup' });
  });

  it('hangs up after the caller has been silent, measuring from the last thing they said', async () => {
    attachHost(socket());
    await startCall();

    clock += SILENCE_HANGUP_MS - 1_000;
    recordTurn('caller', 'Still here');
    await pollCall();
    expect(getCallState().active).toBe(true);

    clock += SILENCE_HANGUP_MS;
    await pollCall();
    expect(getCallState().endedReason).toBe('caller-silent');
  });

  it('hangs up at the configured ceiling even on a talkative call', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 2 } });
    attachHost(socket());
    await startCall();

    for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 10_000) {
      clock += 10_000;
      noteCallerSpeech();
      await pollCall();
    }

    expect(getCallState().endedReason).toBe('max-duration');
    expect(hangup).toHaveBeenCalled();
  });

  it.each([
    ['an absent setting', {}],
    ['a nonsense setting', { maxCallMinutes: 0 }],
  ])('falls back to the 15-minute default for %s', async (_label, facetime) => {
    getVoiceConfig.mockResolvedValue({ facetime });
    attachHost(socket());
    await startCall();

    clock += 14 * 60_000;
    noteCallerSpeech();
    await pollCall();
    expect(getCallState().active).toBe(true);

    clock += 2 * 60_000;
    noteCallerSpeech();
    await pollCall();
    expect(getCallState().endedReason).toBe('max-duration');
  });

  it('writes the transcript to the journal with speaker labels and no handle', async () => {
    attachHost(socket());
    await startCall();
    recordTurn('caller', 'What is on my calendar?');
    markSpeaking();
    recordTurn('assistant', 'Two meetings this afternoon.');

    await endCall('remote-hangup');

    expect(appendJournal).toHaveBeenCalledWith(
      '2026-08-29',
      'FaceTime Audio call\nCaller: What is on my calendar?\nPortOS: Two meetings this afternoon.',
      { source: 'voice' },
    );
  });

  it('writes nothing for a call where no one said anything', async () => {
    attachHost(socket());
    await startCall();

    await endCall('caller-silent');

    expect(appendJournal).not.toHaveBeenCalled();
  });

  it('still resets when the journal write fails', async () => {
    attachHost(socket());
    await startCall();
    recordTurn('caller', 'Hello');
    appendJournal.mockRejectedValue(new Error('disk full'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await endCall('remote-hangup');

    // A failed write must not leave the session `active`, or no further call
    // could ever be placed.
    expect(getCallState()).toMatchObject({ state: 'idle', active: false });
    consoleError.mockRestore();
  });

  it('ends the call when the host tab goes away', async () => {
    const tab = socket();
    attachHost(tab);
    await startCall();

    await detachHost(tab);

    expect(getCallState()).toMatchObject({ hostAttached: false, active: false, endedReason: 'host-detached' });
    expect(hangup).toHaveBeenCalled();
  });

  it('ignores a detach from a tab that never owned the slot', async () => {
    const owner = socket('host-1');
    attachHost(owner);
    await startCall();

    await detachHost(socket('host-2'));

    expect(getCallState()).toMatchObject({ hostAttached: true, active: true });
  });

  it('broadcasts every state change to the registered listener', async () => {
    const states = [];
    setCallStateListener((snapshot) => states.push(snapshot.state));
    attachHost(socket());
    await startCall();
    await pollCall();
    await endCall('remote-hangup');

    expect(states).toContain('dialing');
    expect(states).toContain('listening');
    expect(states).toContain('ended');
  });

  it('survives a listener that throws', async () => {
    setCallStateListener(() => { throw new Error('socket gone'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    attachHost(socket());

    expect(await startCall()).toMatchObject({ ok: true });
    consoleError.mockRestore();
  });

  it('polls on the documented interval', () => {
    expect(PROBE_INTERVAL_MS).toBe(2_000);
  });

  it('ignores turns recorded outside a call', () => {
    expect(recordTurn('caller', 'nobody is listening')).toMatchObject({ turns: 0 });
    expect(noteCallerSpeech()).toMatchObject({ active: false });
  });

  it('hands the opening line over exactly once, however often state is broadcast', async () => {
    // `voice:call:state` is a broadcast and fires on every transition, so a
    // non-consuming read would make the call host say the line twice.
    attachHost(socket());
    await startCall({ openingLine: '  This is PortOS about your backups.  ', origin: 'mind' });

    expect(takeCallOpeningLine()).toBe('This is PortOS about your backups.');
    expect(takeCallOpeningLine()).toBe('');
  });

  it('carries a mind briefing only for the call the mind placed', async () => {
    attachHost(socket());
    await startCall({ openingLine: 'Hello', context: '# Persistent mind identity', origin: 'mind' });
    expect(getCallContext()).toBe('# Persistent mind identity');

    await endCall('remote-hangup');
    // No call, no briefing — the pipeline must not keep applying it to the
    // widget's ordinary turns.
    expect(getCallContext()).toBeNull();

    await startCall({ openingLine: 'Hello' });
    expect(getCallContext()).toBeNull();
  });

  it('gives a mind-placed call back to the mind as a message, and a user call not at all', async () => {
    attachHost(socket());
    await startCall({ openingLine: 'This is PortOS.', origin: 'mind' });
    probe.mockResolvedValue({ state: 'connected' });
    await pollCall();
    recordTurn('assistant', 'This is PortOS.');
    recordTurn('caller', 'Got it, thanks.');

    await endCall('caller-silent');

    expect(enqueueMindMessage).toHaveBeenCalledTimes(1);
    const [text] = enqueueMindMessage.mock.calls[0];
    expect(text).toContain('caller-silent');
    expect(text).toContain('Caller: Got it, thanks.');

    enqueueMindMessage.mockClear();
    attachHost(socket());
    await startCall();
    recordTurn('caller', 'Just me calling in.');
    await endCall('remote-hangup');
    expect(enqueueMindMessage).not.toHaveBeenCalled();
    expect(appendJournal).toHaveBeenCalledTimes(2);
  });

  it('tells the mind about a call nobody picked up', async () => {
    // An empty transcript is the one case where silence is the news: without
    // this the mind would never learn the call went unanswered and could dial
    // again to say the same thing.
    attachHost(socket());
    await startCall({ openingLine: 'This is PortOS.', origin: 'mind' });

    await endCall('caller-silent');

    expect(enqueueMindMessage).toHaveBeenCalledTimes(1);
    expect(enqueueMindMessage.mock.calls[0][0]).toContain('nothing said');
    expect(appendJournal).not.toHaveBeenCalled();
  });

  it('still ends cleanly when the mind handoff fails', async () => {
    // The handoff is telemetry for the next wake; losing it must not strand the
    // session in a state that blocks the next call.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueueMindMessage.mockRejectedValue(new Error('mind queue full'));
    attachHost(socket());
    await startCall({ openingLine: 'Hello', origin: 'mind' });
    recordTurn('caller', 'Hi');

    await endCall('remote-hangup');

    expect(getCallState()).toMatchObject({ state: 'idle', active: false });
    consoleError.mockRestore();
  });

  it('broadcasts every state change on callStateEvents, for a tab that is not the call host', async () => {
    const states = [];
    callStateEvents.on('state', (snapshot) => states.push(snapshot.state));
    attachHost(socket());
    await startCall();
    await endCall('remote-hangup');

    expect(states).toContain('dialing');
    expect(states).toContain('ended');
  });
});

describe('FaceTime incoming-call watcher', () => {
  it('never reads the helper while autoAnswer is off, even with a host attached', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: false } });
    attachHost(socket());

    expect(await pollIncoming()).toEqual({ checked: false, reason: 'auto-answer-off' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('answers an authorized incoming call, speaks a greeting, and runs it like any other call', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true }, llm: { personality: { name: 'Alfred' } } });
    probe.mockResolvedValue({ state: 'dialing', authorized: true });
    attachHost(socket());

    const result = await pollIncoming();

    expect(result).toMatchObject({ incoming: true, answered: true });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(getCallState()).toMatchObject({ state: 'listening', active: true });
    expect(takeCallOpeningLine()).toBe("Hi, this is Alfred. Go ahead.");
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('leaves a call from any other handle ringing and logs nothing that names them', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    // The helper reports nothing distinguishing "no call" from "an
    // unauthorized caller" — fail-closed at the helper boundary. This is the
    // only shape an unmatched caller can produce.
    probe.mockResolvedValue({ state: 'idle', authorized: true });
    attachHost(socket());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pollIncoming();

    expect(result).toEqual({ checked: true, incoming: false });
    expect(answer).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('answers at any hour, but a quiet-hours greeting is softer, never withheld', async () => {
    getVoiceConfig.mockResolvedValue({
      facetime: { maxCallMinutes: 15, autoAnswer: true },
      llm: { personality: { name: 'Alfred' }, proactive: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } },
    });
    getLocalMinutes.mockResolvedValue(3 * 60); // 3am — inside the overnight window
    probe.mockResolvedValue({ state: 'dialing', authorized: true });
    attachHost(socket());

    const result = await pollIncoming();

    expect(result).toMatchObject({ answered: true });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(takeCallOpeningLine()).toMatch(/it's late/i);
  });

  it('records a missed call, and never presses answer, when no host is attached', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    probe.mockResolvedValue({ state: 'dialing', authorized: true });
    // No attachHost() in this test — the production timer would never reach
    // here with `host` unset (see attachHost/detachHost), but a host that
    // detaches between this tick starting and the answer landing is a real
    // race, and pollIncoming has to be correct standalone regardless.

    const result = await pollIncoming();

    expect(result).toEqual({ checked: true, incoming: true, answered: false, reason: 'no-host' });
    expect(answer).not.toHaveBeenCalled();
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_warning',
      title: 'Missed call from you — the call host was not attached',
      priority: 'medium',
    }));
    expect(getCallState()).toMatchObject({ state: 'idle', active: false });
  });

  it('records a missed call when the helper fails to press an authorized ring', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    probe.mockResolvedValue({ state: 'dialing', authorized: true });
    answer.mockRejectedValue(new Error('AX press failed'));
    attachHost(socket());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pollIncoming();

    expect(result).toEqual({ checked: true, incoming: true, answered: false, reason: 'helper-failed' });
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Missed call from you — the FaceTime helper failed to answer',
    }));
    consoleError.mockRestore();
  });

  it('notifies once per ring, not once per 2-second tick, while it keeps ringing unanswered', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    probe.mockResolvedValue({ state: 'dialing', authorized: true });
    // host stays unattached for all three ticks.

    await pollIncoming();
    await pollIncoming();
    await pollIncoming();

    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it('is ready to notify again for the next ring once the first one stops', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    probe.mockResolvedValue({ state: 'dialing', authorized: true });

    await pollIncoming();
    expect(addNotification).toHaveBeenCalledTimes(1);

    probe.mockResolvedValue({ state: 'idle', authorized: false }); // ring stopped
    await pollIncoming();
    probe.mockResolvedValue({ state: 'dialing', authorized: true }); // a second call rings
    await pollIncoming();

    expect(addNotification).toHaveBeenCalledTimes(2);
  });

  it('hands an answered call to the mind on hangup only when the mind was running when it answered', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    probe.mockResolvedValue({ state: 'dialing', authorized: true });
    isMindEnabled.mockResolvedValue(true);
    attachHost(socket());
    await pollIncoming();
    recordTurn('caller', 'Hey, it is me.');

    await endCall('remote-hangup');

    expect(buildInboundContext).toHaveBeenCalledTimes(1);
    expect(enqueueMindMessage).toHaveBeenCalledTimes(1);
    expect(enqueueMindMessage.mock.calls[0][0]).toContain('you answered');
  });

  it('runs the plain persona with no mind handoff when the mind was not running', async () => {
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    probe.mockResolvedValue({ state: 'dialing', authorized: true });
    isMindEnabled.mockResolvedValue(false);
    attachHost(socket());
    await pollIncoming();
    recordTurn('caller', 'Hey, it is me.');

    await endCall('remote-hangup');

    expect(buildInboundContext).not.toHaveBeenCalled();
    expect(enqueueMindMessage).not.toHaveBeenCalled();
  });

  it('polls the helper only while a call-host tab is attached, and stops on detach', async () => {
    vi.useFakeTimers();
    getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15, autoAnswer: true } });
    probe.mockResolvedValue({ state: 'idle', authorized: false });
    const host = socket();

    attachHost(host);
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 2);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);

    await detachHost(host);
    probe.mockClear();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);
    expect(probe).not.toHaveBeenCalled();
  });
});
