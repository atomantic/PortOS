import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The gate, the sidebar toggle and the widget are rendered together here, the
// way Layout mounts them. Only the modules below the widget (the voice client,
// the fast path, the DOM index) and the chunk loader are replaced, so these
// tests see the real start/replay path end to end.

const ENABLED_CONFIG = {
  enabled: true,
  hotkey: 'Space',
  stt: { engine: 'whisper', language: 'en' },
  llm: { fastPath: null },
  tts: { engine: 'piper', piper: { voice: 'example-voice' }, rate: 1 },
};

const mocks = vi.hoisted(() => {
  const toast = vi.fn();
  toast.error = vi.fn();
  const socketHandlers = new Map();
  return {
    toast,
    events: new Map(),
    socketHandlers,
    socket: {
      on: vi.fn((event, handler) => {
        if (!socketHandlers.has(event)) socketHandlers.set(event, new Set());
        socketHandlers.get(event).add(handler);
      }),
      off: vi.fn((event, handler) => socketHandlers.get(event)?.delete(handler)),
      emit: vi.fn(),
    },
    // Stands in for the dynamic import of the widget chunk.
    loadWidget: vi.fn(),
    reloadOnceForStaleChunk: vi.fn(),
    startContinuous: vi.fn(),
    startWebSpeechCapture: vi.fn(),
    resolveTurn: vi.fn(),
    speakSynthesized: vi.fn(),
    disposeCaptureOwner: vi.fn(),
    stopContinuous: vi.fn(),
    stopCapture: vi.fn(),
    stopWebSpeechCapture: vi.fn(),
    isContinuous: vi.fn(() => false),
    interrupt: vi.fn(),
    getVoiceConfig: vi.fn(),
  };
});

vi.mock('../../services/socket', () => ({ default: mocks.socket }));
vi.mock('../../services/apiLocalLlm.js', () => ({
  getConversationalGemmaSetupStatus: vi.fn().mockResolvedValue({ supported: true, llamaInstalled: false, ggufExists: false, running: false, phase: 'idle' }),
  startConversationalGemmaSetup: vi.fn(),
  cancelConversationalGemmaSetup: vi.fn(),
}));
vi.mock('../../utils/lazyWithReload', () => ({ importWithRetry: (load) => mocks.loadWidget(load) }));
vi.mock('../../utils/staleChunkReload', () => ({
  isStaleChunkError: (err) => err?.message === 'Failed to fetch dynamically imported module',
  reloadOnceForStaleChunk: mocks.reloadOnceForStaleChunk,
}));

vi.mock('../../services/voiceClient', () => ({
  startCapture: vi.fn(),
  stopCapture: mocks.stopCapture,
  interrupt: mocks.interrupt,
  resetConversation: vi.fn(),
  sendText: vi.fn(),
  onVoiceEvent: vi.fn((name, handler) => {
    mocks.events.set(name, handler);
    return () => mocks.events.delete(name);
  }),
  isCapturing: vi.fn(() => false),
  startContinuous: mocks.startContinuous,
  stopContinuous: mocks.stopContinuous,
  isContinuous: mocks.isContinuous,
  whenVoiceTurnAudioDrained: vi.fn(async () => true),
  whenPlaybackDrained: vi.fn(() => Promise.resolve(true)),
  getVadLevel: vi.fn(() => 0),
  prepareVoicePlayback: vi.fn(),
  webSpeechSupported: true,
  startWebSpeechCapture: mocks.startWebSpeechCapture,
  stopWebSpeechCapture: mocks.stopWebSpeechCapture,
  isWebSpeechCapturing: vi.fn(() => false),
  disposeCaptureOwner: mocks.disposeCaptureOwner,
  onProactiveSpeech: vi.fn(() => vi.fn()),
  captureVisionFrame: vi.fn(),
  imageFileToDataUrl: vi.fn(),
  attachVoiceImage: vi.fn(),
  removeVoiceImage: vi.fn(),
  sendScreenshotResult: vi.fn(),
  enableVisionCapture: vi.fn(),
  disableVisionCapture: vi.fn(),
  isVisionCaptureEnabled: vi.fn(() => false),
  getVisionStream: vi.fn(() => null),
  onVisionFrameCaptured: vi.fn(() => vi.fn()),
  onVisionCaptureEnded: vi.fn(() => vi.fn()),
  speakSynthesized: mocks.speakSynthesized,
  onVoiceOutputPrimary: vi.fn((handler) => { handler(true); return vi.fn(); }),
  claimVoiceOutput: vi.fn(),
  getVoiceVolume: vi.fn(() => 0.85),
  setVoiceVolume: vi.fn(),
  isVoiceMuted: vi.fn(() => false),
  setVoiceMuted: vi.fn(),
  onVoiceAudioPrefs: vi.fn((handler) => { handler({ volume: 0.85, muted: false }); return vi.fn(); }),
  getVoiceOutputLevel: vi.fn(() => 0),
  getVoiceOutputSpectrum: vi.fn(() => null),
}));

vi.mock('../../services/voiceFastPath', () => ({
  resolveTurn: mocks.resolveTurn,
  buildRouterSystemPrompt: vi.fn(),
  TIER: { SERVER: 'server', TRIGGER: 'trigger', NANO: 'nano' },
}));

vi.mock('../../services/browserLlm', () => ({ warmNano: vi.fn() }));
vi.mock('../../services/apiPalette', () => ({ getPaletteManifest: vi.fn() }));
vi.mock('../../services/apiPipeline', () => ({ listPipelineTtsVoices: vi.fn(async () => ({ voices: [] })) }));
vi.mock('../../services/apiVoice', () => ({
  getVoiceConfig: mocks.getVoiceConfig,
  updateVoiceConfig: vi.fn(async (patch) => ({ config: patch })),
  getVoiceLlmResidency: vi.fn(async () => ({ state: 'unloaded', runtime: 'lmstudio', model: 'qwen3:14b' })),
}));
vi.mock('../../services/apiProviders', () => ({
  getProviders: vi.fn(async () => ({
    providers: [{ id: 'lmstudio', type: 'api', name: 'LM Studio', models: ['gemma4:31b', 'qwen3:14b'] }],
  })),
  refreshProviderModels: vi.fn(async () => ({ name: 'LM Studio', models: ['gemma4:31b', 'qwen3:14b'] })),
}));
vi.mock('../../services/apiVoiceAvatar', () => ({
  fetchVoiceAvatar: vi.fn(async () => ({ supported: false })),
  fetchAvatarLibrary: vi.fn(async () => ({
    collectionId: 'avatars', collectionName: 'Avatars', avatars: [], active: 0,
    channels: Array.from({ length: 6 }, () => ({ label: '', avatar: null })),
  })),
  saveAvatarChannels: vi.fn(async ({ active }) => ({
    collectionId: 'avatars', collectionName: 'Avatars', avatars: [], active,
    channels: Array.from({ length: 6 }, (_, i) => ({ label: i === 1 ? 'Scout' : '', avatar: null })),
  })),
}));
vi.mock('../ui/Toast', () => ({ default: mocks.toast }));
vi.mock('./useVoiceUiSync', () => ({
  useVoiceUiSync: vi.fn(),
  pushUiIndexAfterAction: vi.fn(),
}));
vi.mock('../../services/uiInteract', () => ({
  doClick: vi.fn(() => ({ ok: true })),
  doFill: vi.fn(() => ({ ok: true })),
  doSelect: vi.fn(() => ({ ok: true })),
  doSetCheckbox: vi.fn(() => ({ ok: true })),
}));
vi.mock('../micrographics', () => ({ MicroGlyph: () => null }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn(), Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a> }));

import VoiceWidgetGate, { useVoiceConsole } from './VoiceWidgetGate';
import VoiceToggleButton from './VoiceToggleButton';
import SidebarContext from '../SidebarContext';
import * as voiceClientMock from '../../services/voiceClient';
import { saveAvatarChannels } from '../../services/apiVoiceAvatar';
import { updateVoiceConfig } from '../../services/apiVoice';
import { ENGAGE_EVENT, DISENGAGE_EVENT } from '../../services/voiceVisibility';
import { REALTIME_ACTIVE_EVENT } from '../../services/voiceRealtime';

const HIDDEN_KEY = 'portos.voice.hidden';
const VISUAL_MODE_KEY = 'portos.voice.visualMode';
const settle = () => act(async () => {});

const renderWidget = async () => {
  localStorage.setItem(HIDDEN_KEY, '0');
  render(<VoiceWidgetGate><VoiceToggleButton /></VoiceWidgetGate>);
  await settle();
  return screen.findByRole('complementary', { name: 'Voice assistant' });
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.events.clear();
  mocks.socketHandlers.clear();
  mocks.loadWidget.mockImplementation((load) => load());
  mocks.reloadOnceForStaleChunk.mockResolvedValue(false);
  mocks.startContinuous.mockResolvedValue(undefined);
  mocks.stopContinuous.mockResolvedValue(undefined);
  mocks.stopCapture.mockResolvedValue(null);
  mocks.speakSynthesized.mockResolvedValue(undefined);
  mocks.isContinuous.mockReturnValue(false);
  mocks.getVoiceConfig.mockResolvedValue(ENABLED_CONFIG);
});

describe('VoiceWidget accessibility', () => {
  it('is a labelled landmark with status regions and typed buttons', async () => {
    const widget = await renderWidget();
    expect(widget.tagName).toBe('ASIDE');
    expect(within(widget).getAllByRole('status').length).toBeGreaterThan(0);
    for (const b of widget.querySelectorAll('button')) {
      expect(b.getAttribute('type'), b.getAttribute('aria-label') || b.textContent).toBeTruthy();
    }
  });

  it('exposes toggle states and omits the speaker button while this tab already owns output', async () => {
    const widget = await renderWidget();
    expect(within(widget).queryByRole('button', { name: /speaker/i })).not.toBeInTheDocument();
    expect(within(widget).getByRole('button', { name: /^(hands-free|push-to-talk)$/ })).toHaveAttribute('aria-pressed');
    const talk = within(widget).getByRole('button', { name: 'Start hands-free listening' });
    expect(talk).toHaveAttribute('aria-pressed', 'false');
    expect(talk.innerHTML).not.toContain('writing-mode:vertical-rl');
  });

  it('shows the agent name above the avatar, keeps transcript only in the transmission log, and omits redundant LCD header badges', async () => {
    mocks.getVoiceConfig.mockResolvedValue({
      ...ENABLED_CONFIG,
      stt: { engine: 'web-speech', language: 'en' },
      llm: { provider: 'lmstudio', model: 'gemma4:31b', personality: { name: 'Alba' }, fastPath: null },
    });
    const widget = await renderWidget();
    const ui = within(widget);
    expect(ui.getByText('CH1 · Alba')).toBeInTheDocument();
    expect(ui.queryByText(/AVATAR LIVE|PORTRAIT/i)).not.toBeInTheDocument();
    expect(ui.queryByText('WEB')).not.toBeInTheDocument();
    expect(ui.queryByText('PT-01')).not.toBeInTheDocument();
    expect(ui.getByText('example-voice')).toBeInTheDocument();

    act(() => mocks.events.get('voice:llm:delta')?.({ delta: 'Unique reply line' }));
    // Transcript appears once, inside the transmission log — not duplicated on top of the avatar.
    expect(ui.getAllByText('Unique reply line')).toHaveLength(1);
    expect(ui.getByRole('log')).toHaveTextContent('Unique reply line');
  });

  it('lets the floating handset claim voice output from another tab', async () => {
    voiceClientMock.onVoiceOutputPrimary.mockImplementationOnce((handler) => {
      handler(false);
      return vi.fn();
    });
    const widget = await renderWidget();
    const speaker = within(widget).getByRole('button', { name: 'claim speaker' });
    expect(speaker).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(speaker);
    expect(voiceClientMock.claimVoiceOutput).toHaveBeenCalledTimes(1);
  });

  it('announces finalized turns in a log and wires the collapse disclosure', async () => {
    const widget = await renderWidget();
    fireEvent.change(within(widget).getByLabelText('Message to the voice assistant'), { target: { value: 'hello there' } });
    fireEvent.click(within(widget).getByRole('button', { name: 'Send text' }));
    const log = await within(widget).findByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    const collapse = within(widget).getByRole('button', { name: 'Hide conversation' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    const panelId = collapse.getAttribute('aria-controls');
    expect(widget.querySelector('[id="' + panelId + '"]')).not.toBeNull();
    fireEvent.click(collapse);
    const expand = within(widget).getByRole('button', { name: 'Show conversation' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).not.toHaveAttribute('aria-controls');
  });

  it('keeps the mic state when the controls are minimized and restored', async () => {
    const widget = await renderWidget();
    const restore = () => fireEvent.click(within(widget).getByRole('button', { name: 'Open voice controls' }));
    const minimize = () => fireEvent.click(within(widget).getByRole('button', { name: 'Minimize voice controls' }));

    restore();
    await settle();
    minimize();
    await settle();
    restore();
    await settle();
    expect(mocks.startContinuous).not.toHaveBeenCalled();

    mocks.isContinuous.mockReturnValue(true);
    minimize();
    await settle();
    restore();
    await settle();
    expect(mocks.stopContinuous).not.toHaveBeenCalled();
  });

  it('moves focus on expand, minimize and hide instead of dropping to body', async () => {
    const widget = await renderWidget();
    fireEvent.click(within(widget).getByRole('button', { name: 'Open voice controls' }));
    await settle();
    expect(document.activeElement).toBe(within(widget).getByLabelText('Message to the voice assistant'));

    fireEvent.click(within(widget).getByRole('button', { name: 'Minimize voice controls' }));
    await settle();
    expect(document.activeElement).toBe(within(widget).getByRole('button', { name: 'Open voice controls' }));

    fireEvent.click(within(widget).getAllByRole('button', { name: 'Hide voice widget' })[0]);
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Engage voice agent controls' }));
  });
});

describe('VoiceWidget async lifecycle', () => {
  it('does not send typed text when it unmounts during the fast path', async () => {
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, llm: { fastPath: { enabled: true } } });
    let finish;
    mocks.resolveTurn.mockReturnValue(new Promise((r) => { finish = r; }));
    localStorage.setItem(HIDDEN_KEY, '0');
    const { unmount } = render(<VoiceWidgetGate><VoiceToggleButton /></VoiceWidgetGate>);
    await settle();
    const widget = await screen.findByRole('complementary', { name: 'Voice assistant' });
    fireEvent.change(within(widget).getByLabelText('Message to the voice assistant'), { target: { value: 'hello' } });
    fireEvent.click(within(widget).getByRole('button', { name: 'Send text' }));
    await settle();
    expect(mocks.resolveTurn).toHaveBeenCalled();
    unmount();
    await act(async () => { finish(null); });
    expect(voiceClientMock.sendText).not.toHaveBeenCalled();
  });

  it('does not reopen the mic when disengage lands while engage awaits the in-flight cancel', async () => {
    await renderWidget();
    let releaseStop;
    mocks.isContinuous.mockReturnValue(true);
    mocks.stopContinuous.mockReturnValue(new Promise((r) => { releaseStop = r; }));
    mocks.startContinuous.mockClear();
    voiceClientMock.startCapture.mockClear();
    mocks.startWebSpeechCapture.mockClear();
    act(() => { window.dispatchEvent(new Event(DISENGAGE_EVENT)); });
    act(() => { window.dispatchEvent(new Event(ENGAGE_EVENT)); });
    act(() => { window.dispatchEvent(new Event(DISENGAGE_EVENT)); });
    mocks.isContinuous.mockReturnValue(false);
    await act(async () => { releaseStop(); });
    await settle();
    expect(mocks.startContinuous).not.toHaveBeenCalled();
    expect(voiceClientMock.startCapture).not.toHaveBeenCalled();
    expect(mocks.startWebSpeechCapture).not.toHaveBeenCalled();
  });

  it('serializes a rapid re-engage behind hideWidget mic teardown', async () => {
    const widget = await renderWidget();
    let releaseStop;
    mocks.isContinuous.mockReturnValue(true);
    mocks.stopContinuous.mockReturnValue(new Promise((r) => { releaseStop = r; }));
    mocks.startContinuous.mockClear();

    fireEvent.click(within(widget).getAllByRole('button', { name: 'Hide voice widget' })[0]);
    act(() => { window.dispatchEvent(new Event(ENGAGE_EVENT)); });
    await settle();
    expect(mocks.startContinuous).not.toHaveBeenCalled();

    mocks.isContinuous.mockReturnValue(false);
    await act(async () => { releaseStop(); });
    await settle();
    expect(mocks.startContinuous).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('complementary', { name: 'Voice assistant' })).toBeInTheDocument();
    expect(localStorage.getItem(HIDDEN_KEY)).toBe('0');
  });

  it('stops an active continuous capture on disengage even after sttEngine switches to web-speech', async () => {
    await renderWidget();
    mocks.isContinuous.mockReturnValue(true);
    act(() => {
      for (const handler of [...(mocks.socketHandlers.get('voice:config:changed') || [])]) {
        handler({ sttEngine: 'web-speech' });
      }
    });
    await settle();

    act(() => { window.dispatchEvent(new Event(DISENGAGE_EVENT)); });
    await settle();
    expect(mocks.stopContinuous).toHaveBeenCalledTimes(1);
    expect(mocks.interrupt).toHaveBeenCalled();
  });

  it('keeps engage waiting until all overlapping cancellations settle', async () => {
    await renderWidget();
    let releaseFirstStop;
    mocks.isContinuous.mockReturnValue(true);
    mocks.stopContinuous.mockReturnValueOnce(new Promise((r) => { releaseFirstStop = r; }));
    mocks.startContinuous.mockClear();

    // First disengage starts an async continuous-capture teardown.
    act(() => { window.dispatchEvent(new Event(DISENGAGE_EVENT)); });
    // Second disengage lands after isContinuous flipped false, so its teardown settles immediately.
    mocks.isContinuous.mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event(DISENGAGE_EVENT)); });
    await settle();

    // Re-engage must still wait for the first teardown rather than starting early.
    act(() => { window.dispatchEvent(new Event(ENGAGE_EVENT)); });
    await settle();
    expect(mocks.startContinuous).not.toHaveBeenCalled();

    await act(async () => { releaseFirstStop(); });
    await settle();
    expect(mocks.startContinuous).toHaveBeenCalledTimes(1);
  });

  it('drops a superseded fast-path turn when a newer typed message is sent', async () => {
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, llm: { fastPath: { enabled: true } } });
    let resolveFirst;
    let resolveSecond;
    mocks.resolveTurn
      .mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveSecond = r; }));
    const widget = await renderWidget();
    const input = within(widget).getByLabelText('Message to the voice assistant');
    const sendBtn = within(widget).getByRole('button', { name: 'Send text' });

    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(sendBtn);
    await settle();

    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.click(sendBtn);
    await settle();

    await act(async () => { resolveSecond({ tier: 'server' }); });
    await act(async () => { resolveFirst({ tier: 'server' }); });
    expect(voiceClientMock.sendText).toHaveBeenCalledTimes(1);
    expect(voiceClientMock.sendText).toHaveBeenCalledWith('second question');
  });

  it('cancels an in-flight fast-path turn on disengage so it neither speaks nor sends to server', async () => {
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, llm: { fastPath: { enabled: true } } });
    let resolveFastPath;
    mocks.resolveTurn.mockReturnValueOnce(new Promise((r) => { resolveFastPath = r; }));
    const widget = await renderWidget();
    fireEvent.change(within(widget).getByLabelText('Message to the voice assistant'), { target: { value: 'cancel me' } });
    fireEvent.click(within(widget).getByRole('button', { name: 'Send text' }));
    await settle();

    act(() => { window.dispatchEvent(new Event(DISENGAGE_EVENT)); });
    await settle();

    await act(async () => { resolveFastPath({ tier: 'nano', reply: 'stale reply' }); });
    expect(mocks.speakSynthesized).not.toHaveBeenCalled();
    expect(voiceClientMock.sendText).not.toHaveBeenCalled();
  });

  it('does not let a stale voice:idle audio drain clobber a newer turn thinking stage', async () => {
    let resolveDrain;
    voiceClientMock.whenVoiceTurnAudioDrained.mockReturnValueOnce(new Promise((r) => { resolveDrain = r; }));
    const widget = await renderWidget();
    const ui = within(widget);

    // Prior turn finishes sending audio and awaits local playback drain.
    act(() => mocks.events.get('voice:tts:audio')?.({ sentence: 'old reply' }));
    act(() => mocks.events.get('voice:idle')?.({ reason: 'turn-complete' }));
    await settle();

    // User starts a new turn before the prior turn's drain promise settles.
    fireEvent.change(ui.getByLabelText('Message to the voice assistant'), { target: { value: 'new question' } });
    fireEvent.click(ui.getByRole('button', { name: 'Send text' }));
    await settle();
    expect(ui.getByText('Thinking', { selector: '[role="status"]' })).toBeInTheDocument();

    // Prior turn's drain resolves (e.g. because cancelVoicePlayback drained the queue);
    // it must NOT reset the new turn's Thinking stage back to Standby.
    await act(async () => { resolveDrain(true); });
    await settle();
    expect(ui.getByText('Thinking', { selector: '[role="status"]' })).toBeInTheDocument();
  });

  it('does not let a delayed voice:transcript echo invalidate a newer turn fast-path lookup', async () => {
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, llm: { fastPath: { enabled: true } } });
    let resolveSecond;
    mocks.resolveTurn.mockReturnValueOnce(new Promise((r) => { resolveSecond = r; }));
    const widget = await renderWidget();
    const ui = within(widget);

    fireEvent.change(ui.getByLabelText('Message to the voice assistant'), { target: { value: 'newer question' } });
    fireEvent.click(ui.getByRole('button', { name: 'Send text' }));
    await settle();

    // Delayed text echo from an earlier server-routed turn arrives while the newer fast path is in flight.
    act(() => mocks.events.get('voice:transcript')?.({ text: 'earlier question', source: 'text' }));
    await settle();

    await act(async () => { resolveSecond({ tier: 'server' }); });
    expect(voiceClientMock.sendText).toHaveBeenCalledTimes(1);
    expect(voiceClientMock.sendText).toHaveBeenCalledWith('newer question');
  });

  it('discards an earlier pending typed fast-path lookup when a new server-transcribed voice turn starts', async () => {
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, llm: { fastPath: { enabled: true } } });
    let resolveTyped;
    mocks.resolveTurn.mockReturnValueOnce(new Promise((r) => { resolveTyped = r; }));
    const widget = await renderWidget();
    const ui = within(widget);

    fireEvent.change(ui.getByLabelText('Message to the voice assistant'), { target: { value: 'older typed question' } });
    fireEvent.click(ui.getByRole('button', { name: 'Send text' }));
    await settle();

    // A genuinely new server-transcribed voice turn starts while the typed fast path is still pending.
    act(() => mocks.events.get('voice:transcript')?.({ text: 'spoken question', source: 'voice' }));
    await settle();

    await act(async () => { resolveTyped({ tier: 'nano', reply: 'stale fast reply' }); });
    expect(mocks.speakSynthesized).not.toHaveBeenCalled();
    expect(voiceClientMock.sendText).not.toHaveBeenCalled();
  });

  it('ignores an older turn voice:idle delivered after a newer typed turn has already started', async () => {
    const widget = await renderWidget();
    const ui = within(widget);

    // Prior server turn is active.
    act(() => mocks.events.get('voice:transcript')?.({ text: 'old turn', source: 'voice' }));
    await settle();

    // User starts a new typed turn before the prior turn's voice:idle arrives.
    fireEvent.change(ui.getByLabelText('Message to the voice assistant'), { target: { value: 'new typed turn' } });
    fireEvent.click(ui.getByRole('button', { name: 'Send text' }));
    await settle();
    expect(ui.getByText('Thinking', { selector: '[role="status"]' })).toBeInTheDocument();

    // Delayed voice:idle from the older turn arrives after the newer turn started.
    act(() => mocks.events.get('voice:idle')?.({ reason: 'turn-complete' }));
    await settle();
    expect(ui.getByText('Thinking', { selector: '[role="status"]' })).toBeInTheDocument();
  });
});

describe('Voice Call console', () => {
  function ConsoleHost() {
    const ref = useVoiceConsole();
    return <main ref={ref} />;
  }

  it('opens microphone only on request, uses the existing turn and transcript, and ends cleanly', async () => {
    localStorage.setItem(HIDDEN_KEY, '1');
    localStorage.setItem('portos.voice.handsFree', '1');
    const { rerender } = render(<VoiceWidgetGate><ConsoleHost /></VoiceWidgetGate>);
    const consoleView = await screen.findByRole('region', { name: 'PortOS call console' });
    await settle();
    const ui = within(consoleView);
    const videoTab = ui.getByRole('button', { name: /Video feed/ });
    const brainTab = ui.getByRole('button', { name: /Voice brain/ });
    const channelsTab = ui.getByRole('button', { name: /Channels/ });
    expect(videoTab).toHaveAttribute('aria-expanded', 'true');
    expect(videoTab).toHaveAttribute('aria-controls', 'station-panel-video');
    expect(consoleView.querySelector('#station-panel-video')).not.toBeNull();
    expect(brainTab).toHaveAttribute('aria-expanded', 'false');
    expect(brainTab).not.toHaveAttribute('aria-controls');
    expect(channelsTab).toHaveAttribute('aria-expanded', 'false');
    expect(channelsTab).not.toHaveAttribute('aria-controls');
    expect(ui.getByRole('heading', { level: 2, name: /Avatar setup|AvatarForcing live/ })).toBeInTheDocument();

    expect(voiceClientMock.startContinuous).not.toHaveBeenCalled();
    expect(voiceClientMock.prepareVoicePlayback).not.toHaveBeenCalled();
    fireEvent.click(ui.getByRole('button', { name: 'Open mic' }));
    expect(voiceClientMock.prepareVoicePlayback).toHaveBeenCalledTimes(1);
    expect(voiceClientMock.startContinuous).toHaveBeenCalledTimes(1);
    expect(ui.getByText('Mic open', { selector: '[role="status"]' })).toBeInTheDocument();

    fireEvent.change(ui.getByRole('textbox', { name: 'Message to the voice assistant' }), { target: { value: 'Hello' } });
    fireEvent.click(ui.getByRole('button', { name: 'Send text' }));
    expect(voiceClientMock.sendText).toHaveBeenCalledWith('Hello');
    expect(voiceClientMock.prepareVoicePlayback).toHaveBeenCalledTimes(2);
    expect(await ui.findByRole('button', { name: /Voice brain.*not loaded/ })).toBeInTheDocument();
    // A cold model reads as a load, not as thinking, until its first token.
    act(() => mocks.events.get('voice:llm:loading')?.({ model: 'qwen3:14b' }));
    expect(ui.getByText('Loading model', { selector: '[role="status"]' })).toBeInTheDocument();
    expect(ui.getByRole('button', { name: /Voice brain.*loading/ })).toBeInTheDocument();
    act(() => mocks.events.get('voice:llm:delta')?.({ delta: 'Hi back' }));
    expect(ui.getByText('Thinking', { selector: '[role="status"]' })).toBeInTheDocument();
    expect(ui.getByRole('log')).toHaveTextContent('Hi back');

    // The transceiver has no audio-only toggle or radio-check sample; its 6-channel
    // avatar strip lets the user switch directly to any channel.
    expect(ui.queryByRole('button', { name: /avatar portrait|audio-only/i })).not.toBeInTheDocument();
    expect(ui.queryByRole('button', { name: /play sample|radio check/i })).not.toBeInTheDocument();
    const channelStrip = ui.getByRole('group', { name: 'Channel selector' });
    expect(within(channelStrip).getAllByRole('button')).toHaveLength(6);
    expect(within(channelStrip).getByRole('button', { name: 'Channel 1' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(channelStrip).getByRole('button', { name: 'Channel 2' }));
    expect(saveAvatarChannels).toHaveBeenCalledWith({ active: 1 });
    expect(await within(channelStrip).findByRole('button', { name: 'Channel 2, Scout' })).toHaveAttribute('aria-pressed', 'true');

    // Double-clicking a channel tile on /voice/call jumps to the Channels tab with that channel's editor open.
    fireEvent.doubleClick(within(channelStrip).getByRole('button', { name: 'Channel 2, Scout' }));
    expect(await ui.findByRole('group', { name: 'Agent for channel 2' })).toBeInTheDocument();

    // End button only appears during an active realtime call, not in regular voice mode.
    expect(ui.queryByRole('button', { name: 'End' })).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(REALTIME_ACTIVE_EVENT, { detail: { active: true, connecting: false } }));
    });
    expect(ui.getByRole('button', { name: 'End' })).toBeInTheDocument();
    fireEvent.click(ui.getByRole('button', { name: 'End' }));
    expect(voiceClientMock.disposeCaptureOwner).toHaveBeenCalledTimes(2);
    expect(voiceClientMock.interrupt).toHaveBeenCalled();
    expect(ui.getByText('Standby', { selector: '[role="status"]' })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(REALTIME_ACTIVE_EVENT, { detail: { active: false, connecting: false } }));
    });
    expect(ui.queryByRole('button', { name: 'End' })).not.toBeInTheDocument();

    fireEvent.click(ui.getByRole('button', { name: 'Open mic' }));
    rerender(<VoiceWidgetGate><main /></VoiceWidgetGate>);
    expect(voiceClientMock.disposeCaptureOwner).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('region', { name: 'PortOS call console' })).not.toBeInTheDocument();
  });
});

describe('Voice Call images', () => {
  function ConsoleHost() {
    const ref = useVoiceConsole();
    return <main ref={ref} />;
  }

  it('uploads an image, shows its description chip, and moves it onto the turn it was sent with', async () => {
    localStorage.setItem(HIDDEN_KEY, '1');
    voiceClientMock.imageFileToDataUrl.mockResolvedValue('data:image/jpeg;base64,AAAA');
    voiceClientMock.attachVoiceImage.mockReturnValue('img_1');
    render(<VoiceWidgetGate><ConsoleHost /></VoiceWidgetGate>);
    const ui = within(await screen.findByRole('region', { name: 'PortOS call console' }));
    await settle();

    const file = new File(['x'], 'chart.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(ui.getByLabelText('Attach an image for the voice assistant'), { target: { files: [file] } });
    });
    expect(voiceClientMock.attachVoiceImage).toHaveBeenCalledWith({ dataUrl: 'data:image/jpeg;base64,AAAA', source: 'upload', name: 'chart.png' });
    expect(ui.getByRole('button', { name: /chart\.png.*Reading/ })).toBeDisabled();

    const added = '[Attached image: an image the user attached ("chart.png")]\nA bar chart of weekly sales.';
    act(() => mocks.events.get('voice:image')?.({ id: 'img_1', source: 'upload', name: 'chart.png', status: 'ready', model: 'vision-model', text: added }));
    fireEvent.click(ui.getByRole('button', { name: /chart\.png.*Ready/ }));
    expect(ui.getByText(/A bar chart of weekly sales/)).toBeInTheDocument();
    expect(ui.getByText(/Added to your message · vision-model/)).toBeInTheDocument();

    fireEvent.change(ui.getByRole('textbox', { name: 'Message to the voice assistant' }), { target: { value: 'What does it show?' } });
    fireEvent.click(ui.getByRole('button', { name: 'Send text' }));
    act(() => mocks.events.get('voice:image')?.({ id: 'img_1', source: 'upload', name: 'chart.png', status: 'sent', model: 'vision-model', text: added }));
    expect(ui.queryByRole('button', { name: 'Remove chart.png' })).not.toBeInTheDocument();
    const log = ui.getByRole('log', { name: 'Transmission log' });
    expect(within(log).getByRole('button', { name: /chart\.png/ })).toBeInTheDocument();
  });
});

describe('VoiceWidget sat-phone visual mode & bottom-left placement', () => {
  it('starts automatically in full transceiver mode in the bottom-left and persists compact preference', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    const { unmount } = render(
      <SidebarContext.Provider value={{ collapsed: false, desktop: true }}>
        <VoiceWidgetGate><VoiceToggleButton /></VoiceWidgetGate>
      </SidebarContext.Provider>,
    );
    await settle();
    const widget = await screen.findByRole('complementary', { name: 'Voice assistant' });
    const ui = within(widget);

    // Bottom-left offset clears expanded desktop sidebar
    expect(widget.className).toContain('left-[17rem]');
    expect(widget.className).not.toContain('right-4');

    // Full visual handset is active by default with portrait, volume dial, and link to /voice/call
    expect(ui.getByRole('img', { name: 'Radio operator portrait' })).toBeInTheDocument();
    expect(ui.getByRole('slider', { name: 'Output volume' })).toBeInTheDocument();
    expect(ui.getByRole('link', { name: 'Open full-page Voice Call' })).toHaveAttribute('href', '/voice/call');

    // Real controls wire through to voiceClient; SFX lives in Settings → Voice, and End is hidden outside realtime calls.
    fireEvent.keyDown(ui.getByRole('slider', { name: 'Output volume' }), { key: 'ArrowUp' });
    expect(voiceClientMock.setVoiceVolume).toHaveBeenCalledWith(0.9);
    fireEvent.click(ui.getByRole('button', { name: 'Mute' }));
    expect(voiceClientMock.setVoiceMuted).toHaveBeenCalledWith(true);
    expect(ui.queryByRole('button', { name: 'SFX' })).not.toBeInTheDocument();
    expect(ui.queryByRole('button', { name: 'End' })).not.toBeInTheDocument();

    // Interactive LCD opens the Voice setup tray directly, and speech speed steps persist tts.rate.
    fireEvent.click(ui.getByRole('button', { name: /Open voice brain settings/ }));
    expect(ui.getByRole('button', { name: 'Voice setup' })).toHaveAttribute('aria-expanded', 'true');
    const speedBtn = ui.getByRole('button', { name: /Speech speed 1\.0×/ });
    fireEvent.click(speedBtn);
    expect(updateVoiceConfig).toHaveBeenCalledWith({ tts: { rate: 1.25 } }, { silent: true });
    expect(ui.getByRole('button', { name: /Speech speed 1\.25×/ })).toBeInTheDocument();

    // Enabling screen vision reveals the live PiP preview over the viewfinder.
    voiceClientMock.enableVisionCapture.mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(ui.getByRole('button', { name: 'Enable screen vision for voice' }));
    });
    expect(ui.getByRole('button', { name: /Screen vision active/ })).toBeInTheDocument();

    // Switching to compact bar hides the handset and saves the preference in localStorage
    fireEvent.click(ui.getByRole('button', { name: 'Switch to compact voice bar' }));
    expect(localStorage.getItem(VISUAL_MODE_KEY)).toBe('compact');
    expect(ui.queryByRole('img', { name: 'Radio operator portrait' })).not.toBeInTheDocument();
    expect(ui.getByRole('button', { name: 'Show transceiver handset' })).toBeInTheDocument();
    expect(ui.getByRole('link', { name: 'Open full-page Voice Call' })).toHaveAttribute('href', '/voice/call');
    unmount();

    // Next launch remembers compact mode from localStorage and lets user restore the handset
    render(
      <SidebarContext.Provider value={{ collapsed: true, desktop: true }}>
        <VoiceWidgetGate><VoiceToggleButton /></VoiceWidgetGate>
      </SidebarContext.Provider>,
    );
    await settle();
    const reopened = await screen.findByRole('complementary', { name: 'Voice assistant' });
    expect(reopened.className).toContain('left-20');
    expect(within(reopened).queryByRole('img', { name: 'Radio operator portrait' })).not.toBeInTheDocument();

    fireEvent.click(within(reopened).getByRole('button', { name: 'Show transceiver handset' }));
    await settle();
    expect(localStorage.getItem(VISUAL_MODE_KEY)).toBe('full');
    expect(within(reopened).getByRole('img', { name: 'Radio operator portrait' })).toBeInTheDocument();
  });
});
