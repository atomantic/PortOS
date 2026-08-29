import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../brainJournal.js', () => ({ appendJournal: vi.fn(), getToday: vi.fn() }));
vi.mock('../brainStorage.js', () => ({ createInboxLog: vi.fn() }));

import {
  __resetCaptureSession,
  __setCaptureSessionDeps,
  attachCaptureHost,
  detachCaptureHost,
  endCapture,
  formatClockTime,
  getCaptureHost,
  getCaptureState,
  isCaptureActive,
  recordUtterance,
  setCaptureStateListener,
  startCapture,
} from './captureSession.js';

const socket = (id = 'host-1') => ({ id, connected: true, emit: vi.fn() });

let clock;
let appendJournal;
let getToday;
let createInboxLog;

const install = (overrides = {}) => {
  clock = 1_000_000;
  appendJournal = vi.fn().mockResolvedValue({});
  getToday = vi.fn().mockResolvedValue('2026-08-29');
  createInboxLog = vi.fn().mockResolvedValue({ id: 'inbox-1' });
  __setCaptureSessionDeps({ appendJournal, getToday, createInboxLog, now: () => clock, ...overrides });
};

beforeEach(() => {
  __resetCaptureSession();
  install();
});

afterEach(() => { __resetCaptureSession(); });

describe('meeting capture session', () => {
  it('refuses to start without an attached capture host', () => {
    expect(startCapture(socket())).toEqual({ ok: false, reason: 'no-capture-host' });
    expect(getCaptureState()).toMatchObject({ state: 'idle', active: false, hostAttached: false });
  });

  it('gives the single host slot to the first tab and refuses the second', () => {
    const first = socket('host-1');
    expect(attachCaptureHost(first)).toMatchObject({ ok: true });
    expect(attachCaptureHost(socket('host-2'))).toEqual({ ok: false, reason: 'host-taken' });
    // Re-attaching the incumbent is a reconnect, not a second owner.
    expect(attachCaptureHost(first)).toMatchObject({ ok: true });
  });

  it('refuses a second capture while one is running', () => {
    const host = socket();
    attachCaptureHost(host);
    expect(startCapture(host)).toMatchObject({ ok: true });
    expect(startCapture(host)).toEqual({ ok: false, reason: 'capture-in-progress' });
  });

  it('accumulates timestamped utterances only while listening', () => {
    const host = socket();
    attachCaptureHost(host);
    startCapture(host);

    clock += 5_000;
    recordUtterance('Let’s start the standup.');
    clock += 12_000;
    recordUtterance('  ');

    expect(getCaptureState()).toMatchObject({ turns: 1, active: true });
    // A blank/whitespace-only transcript segment is not a turn.
    expect(recordUtterance('nobody is listening yet')).toMatchObject({ turns: 2 });
  });

  it('ignores utterances recorded outside an active capture', () => {
    expect(recordUtterance('too early')).toMatchObject({ turns: 0 });
  });

  it('writes a timestamped transcript to the journal and files a review-only inbox item', async () => {
    const host = socket();
    attachCaptureHost(host);
    startCapture(host);
    clock = 1_000_000;
    recordUtterance('Kickoff: ship the capture mode.');
    clock = 1_030_000;
    recordUtterance('Assign the doc pass to Sam.');

    await endCapture('stopped');

    const expectedBody = 'Meeting capture\n00:16:40–00:17:10 UTC\n'
      + '[00:16:40] Kickoff: ship the capture mode.\n'
      + '[00:17:10] Assign the doc pass to Sam.';
    expect(appendJournal).toHaveBeenCalledWith('2026-08-29', expectedBody, { source: 'voice' });
    expect(createInboxLog).toHaveBeenCalledWith({ capturedText: expectedBody, source: 'voice', status: 'needs_review' });
    expect(getCaptureState()).toMatchObject({ state: 'idle', active: false, endedReason: 'stopped' });
  });

  it('writes nothing for a capture where nobody said anything', async () => {
    const host = socket();
    attachCaptureHost(host);
    startCapture(host);

    await endCapture('stopped');

    expect(appendJournal).not.toHaveBeenCalled();
    expect(createInboxLog).not.toHaveBeenCalled();
  });

  it('never invokes an AI provider — only the journal and inbox writes', async () => {
    // The whole point of this module: capture never classifies. There is no
    // provider/classifier dependency to call in the first place, so this
    // pins the deps surface rather than a runtime behavior.
    const host = socket();
    attachCaptureHost(host);
    startCapture(host);
    recordUtterance('one turn');

    await endCapture('stopped');

    expect(createInboxLog).toHaveBeenCalledWith(expect.not.objectContaining({ ai: expect.anything() }));
  });

  it('still resets when the journal write fails, and still files the inbox item', async () => {
    const host = socket();
    attachCaptureHost(host);
    startCapture(host);
    recordUtterance('hello');
    appendJournal.mockRejectedValue(new Error('disk full'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await endCapture('stopped');

    // A failed write must not leave the session `listening`, or no further
    // capture could ever be started.
    expect(getCaptureState()).toMatchObject({ state: 'idle', active: false });
    expect(createInboxLog).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('still resets when the inbox write fails after a successful journal write', async () => {
    const host = socket();
    attachCaptureHost(host);
    startCapture(host);
    recordUtterance('hello');
    createInboxLog.mockRejectedValue(new Error('write failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await endCapture('stopped');

    expect(appendJournal).toHaveBeenCalled();
    expect(getCaptureState()).toMatchObject({ state: 'idle', active: false });
    consoleError.mockRestore();
  });

  it('ends the capture when the host tab goes away', async () => {
    const tab = socket();
    attachCaptureHost(tab);
    startCapture(tab);
    recordUtterance('mid-sentence');

    await detachCaptureHost(tab);

    expect(getCaptureState()).toMatchObject({ hostAttached: false, active: false, endedReason: 'host-detached' });
    expect(appendJournal).toHaveBeenCalled();
  });

  it('ignores a detach from a tab that never owned the slot', async () => {
    const owner = socket('host-1');
    attachCaptureHost(owner);
    startCapture(owner);

    await detachCaptureHost(socket('host-2'));

    expect(getCaptureState()).toMatchObject({ hostAttached: true, active: true });
  });

  it('broadcasts every state change to the registered listener', async () => {
    const states = [];
    setCaptureStateListener((snapshot) => states.push(snapshot.state));
    const host = socket();
    attachCaptureHost(host);
    startCapture(host);
    recordUtterance('hi');
    await endCapture('stopped');

    expect(states).toEqual(expect.arrayContaining(['listening', 'ended']));
  });

  it('survives a listener that throws', () => {
    setCaptureStateListener(() => { throw new Error('socket gone'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = socket();

    expect(attachCaptureHost(host)).toMatchObject({ ok: true });
    consoleError.mockRestore();
  });

  it('exposes the current host for the socket layer to gate on', () => {
    const host = socket();
    expect(getCaptureHost()).toBeNull();
    attachCaptureHost(host);
    expect(getCaptureHost()).toBe(host);
  });

  it('reports active only while listening', async () => {
    const host = socket();
    attachCaptureHost(host);
    expect(isCaptureActive()).toBe(false);
    startCapture(host);
    expect(isCaptureActive()).toBe(true);
    await endCapture('stopped');
    expect(isCaptureActive()).toBe(false);
  });

  it('formats a clock time in UTC regardless of host locale', () => {
    expect(formatClockTime(Date.UTC(2026, 7, 29, 3, 4, 5))).toBe('03:04:05');
  });
});
