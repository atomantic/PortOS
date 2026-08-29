import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', () => ({ getVoiceConfig: vi.fn() }));
vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: () => '2026-08-29' }));
vi.mock('./facetimeBridge.js', () => ({ probe: vi.fn(), call: vi.fn(), hangup: vi.fn() }));

import { getVoiceConfig } from './config.js';
import {
  PROBE_INTERVAL_MS,
  SILENCE_HANGUP_MS,
  __resetCallSession,
  __setCallSessionDeps,
  attachHost,
  detachHost,
  endCall,
  getCallState,
  markSpeaking,
  noteCallerSpeech,
  pollCall,
  recordTurn,
  setCallStateListener,
  startCall,
} from './callSession.js';

const socket = (id = 'host-1') => ({ id, connected: true, emit: vi.fn() });

let clock;
let probe;
let call;
let hangup;
let appendJournal;

const install = (overrides = {}) => {
  clock = 1_000_000;
  probe = vi.fn().mockResolvedValue({ state: 'connected' });
  call = vi.fn().mockResolvedValue({ state: 'dialing' });
  hangup = vi.fn().mockResolvedValue({ state: 'ended' });
  appendJournal = vi.fn().mockResolvedValue({});
  __setCallSessionDeps({ probe, call, hangup, appendJournal, now: () => clock, ...overrides });
};

beforeEach(() => {
  __resetCallSession();
  install();
  getVoiceConfig.mockResolvedValue({ facetime: { maxCallMinutes: 15 } });
});

afterEach(() => { __resetCallSession(); });

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
});
