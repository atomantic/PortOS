import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(),
  saveState: vi.fn(async () => {}),
  withStateLock: (fn) => fn(),
}));
vi.mock('./agentRunEventLog.js', () => ({ appendMindEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./persistentMindContext.js', () => ({
  preparePersistentMindContext: vi.fn(async () => ({ text: '# Persistent mind identity\nmindId=cos-persistent-mind' })),
  readPersistentMindMemories: vi.fn(async () => []),
}));
vi.mock('./instanceFeatures.js', () => ({ isInstanceFeatureEnabled: vi.fn(async () => true) }));
vi.mock('./voice/config.js', () => ({ getVoiceConfig: vi.fn() }));
vi.mock('./voice/voiceOutput.js', () => ({ getVoiceOutputSocket: vi.fn(() => null) }));
vi.mock('./voice/callSession.js', () => ({ startCall: vi.fn(), isCallActive: vi.fn(() => false) }));
vi.mock('./voice/proactiveSpeech.js', async () => ({
  // The real window predicate (proactiveSpeech re-exports it under the
  // quiet-hours name) so the overnight-wrap logic is genuinely exercised; only
  // the wall clock behind it is injected. Importing the module itself would
  // drag in the TTS engines this suite has no business booting.
  isWithinQuietHours: (await import('../lib/timezone.js')).isWithinTimeWindow,
  getLocalMinutes: vi.fn(async () => 12 * 60),
}));

import { loadState, saveState } from './cosState.js';
import { appendMindEvent } from './agentRunEventLog.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { getVoiceConfig } from './voice/config.js';
import { getVoiceOutputSocket } from './voice/voiceOutput.js';
import { isCallActive, startCall } from './voice/callSession.js';
import { getLocalMinutes } from './voice/proactiveSpeech.js';
import {
  PERSISTENT_MIND_CALL_SUPPRESSION_REASONS,
  buildPersistentMindCallCapabilityPrompt,
  requestUserCall,
} from './persistentMindCallCapability.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

let root;

const setState = (overrides = {}) => {
  root = {
    config: { persistentMindCapabilities: { callUser: true } },
    persistentMind: { callHistory: [] },
    ...overrides,
  };
  loadState.mockResolvedValue(root);
};

const setVoice = (overrides = {}) => {
  getVoiceConfig.mockResolvedValue({
    enabled: true,
    facetime: { targetHandle: '+15550100', targetName: 'Example User' },
    llm: { proactive: { quietHours: { enabled: false, start: '22:00', end: '07:00' } } },
    ...overrides,
  });
};

const request = (overrides = {}) => requestUserCall({
  reason: 'The nightly backup has been failing for three days',
  openingLine: 'This is PortOS. Your nightly backup has failed three nights running.',
  now: NOW,
  ...overrides,
});

const eventKinds = () => appendMindEvent.mock.calls.map(([event]) => event.kind);
const eventFor = (kind) => appendMindEvent.mock.calls.map(([event]) => event).find((event) => event.kind === kind);

beforeEach(() => {
  vi.clearAllMocks();
  setState();
  setVoice();
  isInstanceFeatureEnabled.mockResolvedValue(true);
  getVoiceOutputSocket.mockReturnValue(null);
  isCallActive.mockReturnValue(false);
  getLocalMinutes.mockResolvedValue(12 * 60);
  startCall.mockResolvedValue({ ok: true, state: { state: 'dialing' } });
});

describe('persistent mind call capability', () => {
  it('places the call, speaking the opening line, only when every gate passes', async () => {
    await expect(request()).resolves.toEqual({ placed: true, reason: null });
    expect(startCall).toHaveBeenCalledWith(expect.objectContaining({
      openingLine: 'This is PortOS. Your nightly backup has failed three nights running.',
      origin: 'mind',
    }));
    expect(eventKinds()).toEqual(['mind.call.requested', 'mind.call.placed']);
    // The budget is only spent on a call that actually went out, and it is
    // written to durable state rather than kept in module memory.
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(root.persistentMind.callHistory).toEqual([
      expect.objectContaining({ source: 'mind', reason: 'The nightly backup has been failing for three days' }),
    ]);
  });

  it('never records the dialed handle on the trajectory', async () => {
    await request();
    const serialized = JSON.stringify(appendMindEvent.mock.calls);
    expect(serialized).not.toContain('+15550100');
    expect(serialized).not.toContain('Example User');
  });

  it('refuses when the grant is off, and dials nothing', async () => {
    // The model does not get to assert its own authority: the grant is
    // re-read after inference, from stored config.
    setState({ config: { persistentMindCapabilities: { callUser: false } }, persistentMind: { callHistory: [] } });
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'not-granted' });
    expect(startCall).not.toHaveBeenCalled();
    expect(eventFor('mind.call.suppressed').data.status).toBe('not-granted');
  });

  it('prefers a browser tab over a phone whenever one can speak', async () => {
    getVoiceOutputSocket.mockReturnValue({ id: 'socket-1' });
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'tab-available' });
    expect(startCall).not.toHaveBeenCalled();
  });

  it('honors voice quiet hours', async () => {
    setVoice({ llm: { proactive: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } } });
    getLocalMinutes.mockResolvedValue(3 * 60);
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'quiet-hours' });
    getLocalMinutes.mockResolvedValue(9 * 60);
    await expect(request()).resolves.toMatchObject({ placed: true });
  });

  it('suppresses the fourth call in a rolling 24 hours', async () => {
    setState({
      config: { persistentMindCapabilities: { callUser: true } },
      persistentMind: {
        callHistory: [{ at: minutesAgo(700) }, { at: minutesAgo(400) }, { at: minutesAgo(100) }],
      },
    });
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'rate-capped' });
    expect(startCall).not.toHaveBeenCalled();
  });

  it('keeps consecutive calls at least thirty minutes apart', async () => {
    setState({
      config: { persistentMindCapabilities: { callUser: true } },
      persistentMind: { callHistory: [{ at: minutesAgo(5) }] },
    });
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'too-soon' });
  });

  it('does not spend the budget when the dial itself fails', async () => {
    // Without this, a Mac with no call-host tab open would silently burn the
    // day's three calls on dials nobody could hear.
    startCall.mockResolvedValue({ ok: false, reason: 'no-call-host' });
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'no-call-host' });
    expect(saveState).not.toHaveBeenCalled();
    expect(root.persistentMind.callHistory).toEqual([]);
  });

  it('refuses without the FaceTime feature or a configured identity', async () => {
    isInstanceFeatureEnabled.mockResolvedValue(false);
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'feature-disabled' });
    isInstanceFeatureEnabled.mockResolvedValue(true);
    setVoice({ facetime: { targetHandle: '', targetName: '' } });
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'identity-unconfigured' });
    setVoice({ enabled: false });
    await expect(request()).resolves.toMatchObject({ placed: false, reason: 'voice-disabled' });
    expect(startCall).not.toHaveBeenCalled();
  });

  it('rejects a malformed request before any gate runs', async () => {
    await expect(requestUserCall({ reason: '', openingLine: 'Hello', now: NOW }))
      .resolves.toMatchObject({ placed: false, reason: 'invalid-request' });
    expect(loadState).not.toHaveBeenCalled();
    expect(eventKinds()).toEqual(['mind.call.suppressed']);
  });

  it('lets the notification escalation call without the mind grant but under the same caps', async () => {
    setState({
      config: { persistentMindCapabilities: { callUser: false } },
      persistentMind: { callHistory: [] },
    });
    await expect(request({ requireMindGrant: false, source: 'critical-notification' }))
      .resolves.toMatchObject({ placed: true });
    expect(root.persistentMind.callHistory[0]).toMatchObject({ source: 'critical-notification' });

    setState({
      config: { persistentMindCapabilities: { callUser: false } },
      persistentMind: { callHistory: [{ at: minutesAgo(1) }] },
    });
    await expect(request({ requireMindGrant: false, source: 'critical-notification' }))
      .resolves.toMatchObject({ placed: false, reason: 'too-soon' });
  });

  it('places no call for an interrupted turn', async () => {
    const controller = new AbortController();
    controller.abort('stopped');
    await expect(request({ signal: controller.signal })).resolves.toMatchObject({ placed: false, reason: 'interrupted' });
    expect(startCall).not.toHaveBeenCalled();
  });

  it('reports only declared suppression reasons', async () => {
    // The reasons are a published contract — they are written verbatim onto
    // the trajectory event and named in the docs — so an undeclared one is a
    // silent break in what the user can look up.
    const seen = new Set();
    setState({ config: { persistentMindCapabilities: { callUser: false } }, persistentMind: { callHistory: [] } });
    seen.add((await request()).reason);
    setState({ config: { persistentMindCapabilities: { callUser: true } }, persistentMind: { callHistory: [{ at: minutesAgo(1) }] } });
    seen.add((await request()).reason);
    getVoiceOutputSocket.mockReturnValue({ id: 'socket-1' });
    seen.add((await request()).reason);
    seen.add((await requestUserCall({ reason: '', openingLine: '', now: NOW })).reason);
    for (const reason of seen) expect(PERSISTENT_MIND_CALL_SUPPRESSION_REASONS).toContain(reason);
  });

  it('describes the limits to the model only when the grant is on', async () => {
    const off = buildPersistentMindCallCapabilityPrompt({ enabled: false });
    expect(off).toContain('OFF');
    expect(off).not.toContain('24 hours');
    const on = buildPersistentMindCallCapabilityPrompt({ enabled: true });
    expect(on).toContain('30 minutes');
    expect(on).toContain('3 calls have already been placed in the last 24 hours');
  });
});
