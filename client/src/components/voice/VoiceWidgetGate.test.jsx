import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  whenPlaybackDrained: vi.fn(() => Promise.resolve(true)),
  whenVoiceTurnAudioDrained: vi.fn(() => Promise.resolve(true)),
  getVadLevel: vi.fn(() => 0),
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
  onVoiceOutputPrimary: vi.fn((handler) => { handler(false); return vi.fn(); }),
  claimVoiceOutput: vi.fn(),
  prepareVoicePlayback: vi.fn(),
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
vi.mock('../../services/apiVoice', () => ({
  getVoiceConfig: mocks.getVoiceConfig,
  updateVoiceConfig: vi.fn(async (patch) => ({ config: patch })),
}));
vi.mock('../../services/apiProviders', () => ({
  getProviders: vi.fn(async () => ({ providers: [] })),
  refreshProviderModels: vi.fn(async () => ({ models: [] })),
}));
vi.mock('../../services/apiVoiceAvatar', () => ({
  fetchVoiceAvatar: vi.fn(async () => ({ supported: false })),
  fetchAvatarLibrary: vi.fn(async () => ({
    collectionId: 'avatars', collectionName: 'Avatars', avatars: [], active: 0,
    channels: Array.from({ length: 6 }, () => ({ label: '', avatar: null })),
  })),
  saveAvatarChannels: vi.fn(),
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

import { warmNano } from '../../services/browserLlm';
import VoiceWidgetGate from './VoiceWidgetGate';
import VoiceToggleButton from './VoiceToggleButton';

const HIDDEN_KEY = 'portos.voice.hidden';
const ENGAGE = 'Engage voice agent controls';
const DISENGAGE = 'Hide voice agent controls';
// Rendered by the widget itself, so its presence means the chunk mounted.
const WIDGET_MIC = 'Start hands-free listening';

const emitSocket = (event, payload) => {
  for (const handler of [...(mocks.socketHandlers.get(event) || [])]) handler(payload);
};

const settle = () => act(async () => {});

const renderGate = ({ strict = false } = {}) => {
  const tree = <VoiceWidgetGate><VoiceToggleButton /></VoiceWidgetGate>;
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

// Holds the widget chunk until the test releases it, as a slow network would.
const deferWidgetChunk = () => {
  let release;
  let fail;
  mocks.loadWidget.mockImplementationOnce((load) => new Promise((resolve, reject) => {
    release = () => resolve(load());
    fail = reject;
  }));
  return {
    release: () => act(async () => { release(); }),
    fail: (err) => act(async () => { fail(err); }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.clear();
  mocks.socketHandlers.clear();
  mocks.loadWidget.mockImplementation((load) => load());
  mocks.reloadOnceForStaleChunk.mockResolvedValue(false);
  mocks.startContinuous.mockResolvedValue(undefined);
  mocks.stopContinuous.mockResolvedValue(undefined);
  mocks.stopCapture.mockResolvedValue(null);
  mocks.speakSynthesized.mockResolvedValue(undefined);
  mocks.resolveTurn.mockResolvedValue({ tier: 'nano', reply: 'Example reply' });
  mocks.isContinuous.mockReturnValue(false);
  mocks.getVoiceConfig.mockResolvedValue(ENABLED_CONFIG);
});

describe('VoiceWidgetGate — voice stays out of the page until it is on', () => {
  it('requests no voice module while voice is disabled', async () => {
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, enabled: false });
    renderGate();
    await settle();

    expect(mocks.getVoiceConfig).toHaveBeenCalledOnce();
    expect(mocks.loadWidget).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: ENGAGE })).toBeNull();
    // fireEvent returns false only when a handler called preventDefault: the
    // hotkey must stay the page's own while voice is off.
    expect(fireEvent.keyDown(window, { code: 'Space' })).toBe(true);
    // Nor may a stray engage event pull the chunk in.
    act(() => { window.dispatchEvent(new Event('portos:voice:engage')); });
    act(() => emitSocket('connect'));
    await settle();
    expect(mocks.loadWidget).not.toHaveBeenCalled();
  });

  it('loads and mounts the widget when Settings turns voice on, without a reload', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, enabled: false });
    renderGate();
    await settle();
    expect(mocks.loadWidget).not.toHaveBeenCalled();

    act(() => emitSocket('voice:config:changed', { enabled: true }));

    expect(await screen.findByRole('button', { name: WIDGET_MIC })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DISENGAGE })).toBeInTheDocument();
    expect(mocks.loadWidget).toHaveBeenCalledOnce();
    // Turning voice on shows the controls; it does not open the mic.
    expect(mocks.startContinuous).not.toHaveBeenCalled();
    expect(mocks.getVoiceConfig).toHaveBeenCalledOnce();
  });

  it('applies a live personality change and re-warms Nano with it', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    mocks.getVoiceConfig.mockResolvedValue({
      ...ENABLED_CONFIG,
      llm: { fastPath: { enabled: true, browserLlm: true }, personality: { name: 'First' } },
    });
    warmNano.mockResolvedValue(undefined);
    renderGate();
    expect(await screen.findByRole('button', { name: WIDGET_MIC })).toBeInTheDocument();
    await settle();
    const before = warmNano.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    act(() => emitSocket('voice:config:changed', { personality: { name: 'Second' } }));
    await settle();
    expect(warmNano.mock.calls.length).toBeGreaterThan(before);
  });

  it('keeps one config subscription and releases it on unmount', async () => {
    const { unmount } = renderGate();
    await screen.findByRole('button', { name: ENGAGE });

    expect(mocks.socketHandlers.get('voice:config:changed').size).toBe(1);
    // The widget and the toggle read the gate's copy: neither subscribes.
    expect(mocks.events.has('voice:config:changed')).toBe(false);
    expect(mocks.getVoiceConfig).toHaveBeenCalledOnce();

    unmount();
    expect(mocks.socketHandlers.get('voice:config:changed').size).toBe(0);
    expect(mocks.socketHandlers.get('connect').size).toBe(0);
  });

  it('asks for the widget chunk again when the connection comes back after a failed load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(HIDDEN_KEY, '0');
    mocks.loadWidget.mockRejectedValueOnce(new Error('network unreachable'));
    renderGate();
    await screen.findByRole('button', { name: DISENGAGE });
    await settle();
    expect(screen.queryByRole('button', { name: WIDGET_MIC })).toBeNull();
    // Nobody asked for a start, so there is nothing to tell the user yet.
    expect(mocks.toast.error).not.toHaveBeenCalled();

    act(() => emitSocket('connect'));
    expect(await screen.findByRole('button', { name: WIDGET_MIC })).toBeInTheDocument();
    expect(mocks.loadWidget).toHaveBeenCalledTimes(2);

    // Mounted: a later reconnect has nothing left to fetch.
    act(() => emitSocket('connect'));
    await settle();
    expect(mocks.loadWidget).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('asks for the config again when the socket reconnects after a failed read', async () => {
    mocks.getVoiceConfig.mockRejectedValueOnce(new Error('server restarting'));
    renderGate();
    await settle();
    expect(mocks.loadWidget).not.toHaveBeenCalled();

    act(() => emitSocket('connect'));
    expect(await screen.findByRole('button', { name: ENGAGE })).toBeInTheDocument();
    expect(mocks.getVoiceConfig).toHaveBeenCalledTimes(2);

    // Answered: a later reconnect is not a reason to read again.
    act(() => emitSocket('connect'));
    await settle();
    expect(mocks.getVoiceConfig).toHaveBeenCalledTimes(2);
  });
});

describe('VoiceWidgetGate — a start requested before the chunk resolves', () => {
  const renderWhileLoading = async (options) => {
    const chunk = deferWidgetChunk();
    renderGate(options);
    // The toggle can render before the gate's effect attaches the listeners
    // that accept input on behalf of the still-loading widget.
    await settle();
    expect(mocks.loadWidget).toHaveBeenCalledOnce();
    expect(screen.queryByRole('complementary', { name: 'Voice assistant' })).toBeNull();
    return chunk;
  };

  it.each([false, true])('is replayed exactly once after the widget loads (StrictMode: %s)', async (strict) => {
    const chunk = await renderWhileLoading({ strict });

    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    await settle();
    expect(mocks.loadWidget).toHaveBeenCalledOnce();
    expect(mocks.startContinuous).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: WIDGET_MIC })).toBeNull();

    await chunk.release();
    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());
    // StrictMode unmounts the freshly mounted widget once, which invalidates
    // any capture begun before it. The replayed start has to come after that.
    expect(mocks.disposeCaptureOwner).toHaveBeenCalledTimes(strict ? 1 : 0);
    for (const disposedAt of mocks.disposeCaptureOwner.mock.invocationCallOrder) {
      expect(disposedAt).toBeLessThan(mocks.startContinuous.mock.invocationCallOrder[0]);
    }

    // Nothing left to replay: a later config change must not start it again.
    act(() => emitSocket('voice:config:changed', { hotkey: 'KeyV' }));
    act(() => emitSocket('voice:config:changed', { enabled: false }));
    act(() => emitSocket('voice:config:changed', { enabled: true }));
    await settle();
    expect(mocks.startContinuous).toHaveBeenCalledOnce();
  });

  it('is dropped when the toggle is pressed again before the widget loads', async () => {
    const chunk = await renderWhileLoading();

    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    fireEvent.click(screen.getByRole('button', { name: DISENGAGE }));
    await chunk.release();
    await settle();

    expect(mocks.startContinuous).not.toHaveBeenCalled();
  });

  it('is dropped when voice is turned off before the widget loads', async () => {
    const chunk = await renderWhileLoading();

    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    act(() => emitSocket('voice:config:changed', { enabled: false }));
    await chunk.release();
    act(() => emitSocket('voice:config:changed', { enabled: true }));
    await settle();

    expect(screen.getByRole('button', { name: DISENGAGE })).toBeInTheDocument();
    expect(mocks.startContinuous).not.toHaveBeenCalled();
  });

  it('holds a push-to-talk press on the configured hotkey', async () => {
    mocks.getVoiceConfig.mockResolvedValue({ ...ENABLED_CONFIG, hotkey: 'KeyV' });
    const chunk = await renderWhileLoading();

    expect(fireEvent.keyDown(window, { code: 'Space' })).toBe(true);
    // Claimed (preventDefault) so the page does not also act on the key.
    expect(fireEvent.keyDown(window, { code: 'KeyV' })).toBe(false);
    // The hotkey reveals a hidden widget, as it does once the widget is loaded.
    expect(localStorage.getItem(HIDDEN_KEY)).toBe('0');

    await chunk.release();
    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());
    // Visible and live: the mic control now offers to stop.
    expect(await screen.findByRole('button', { name: 'Stop hands-free listening' })).toBeInTheDocument();
  });

  it('treats a second hotkey press as the stop it would be on a live capture', async () => {
    const chunk = await renderWhileLoading();

    fireEvent.keyDown(window, { code: 'Space' });
    fireEvent.keyDown(window, { code: 'Space' });
    await chunk.release();
    await settle();

    expect(mocks.startContinuous).not.toHaveBeenCalled();
  });

  it('leaves the hotkey to a field the user is typing in', async () => {
    const chunk = deferWidgetChunk();
    render(<VoiceWidgetGate><input aria-label="Example field" /></VoiceWidgetGate>);
    await settle();

    expect(fireEvent.keyDown(screen.getByLabelText('Example field'), { code: 'Space' })).toBe(true);
    await chunk.release();
    await settle();

    expect(mocks.startContinuous).not.toHaveBeenCalled();
  });

  it('opens the mic for a Daily Log dictation that began while the widget was loading', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    const chunk = await renderWhileLoading();

    // The server answers Daily Log's Dictate button once; nobody repeats it.
    act(() => emitSocket('voice:dictation', { enabled: true, date: '2026-01-02' }));
    await chunk.release();

    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Dictating to Daily Log/)).toBeInTheDocument();
    await settle();
    expect(mocks.startContinuous).toHaveBeenCalledOnce();
  });

  it('forgets a dictation, and the start it implied, that ended before the widget loaded', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    const chunk = await renderWhileLoading();
    fireEvent.click(screen.getByRole('button', { name: DISENGAGE }));
    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));

    act(() => emitSocket('voice:dictation', { enabled: true, date: '2026-01-02' }));
    act(() => emitSocket('voice:dictation', { enabled: false }));
    await chunk.release();
    await screen.findByRole('button', { name: WIDGET_MIC });
    await settle();

    expect(screen.queryByText(/Dictating to Daily Log/)).toBeNull();
    expect(mocks.startContinuous).not.toHaveBeenCalled();
  });

  it('keeps the mic closed for a held dictation once the controls are hidden', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    const chunk = await renderWhileLoading();
    const hide = screen.getByRole('button', { name: DISENGAGE });

    act(() => emitSocket('voice:dictation', { enabled: true, date: '2026-01-02' }));
    // Hiding the controls stops a live capture; it must also stop a held one,
    // or the mic would open with nothing on screen to show it.
    fireEvent.click(hide);
    await chunk.release();
    await settle();
    expect(mocks.startContinuous).not.toHaveBeenCalled();

    // Dictation itself is still on, so showing the controls again says so.
    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    expect(await screen.findByText(/Dictating to Daily Log/)).toBeInTheDocument();
  });

  it('asks for the widget again when dictation starts after a load that failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(HIDDEN_KEY, '0');
    mocks.loadWidget.mockRejectedValueOnce(new Error('network unreachable'));
    renderGate();
    await screen.findByRole('button', { name: DISENGAGE });
    await settle();
    expect(mocks.loadWidget).toHaveBeenCalledOnce();

    act(() => emitSocket('voice:dictation', { enabled: true, date: '2026-01-02' }));

    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());
    expect(mocks.loadWidget).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/Dictating to Daily Log/)).toBeInTheDocument();
    warn.mockRestore();
  });

  it('still opens the mic for a held dictation when the first load fails and a retry succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(HIDDEN_KEY, '0');
    const chunk = await renderWhileLoading();

    act(() => emitSocket('voice:dictation', { enabled: true, date: '2026-01-02' }));
    await chunk.fail(new Error('network unreachable'));
    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith('Voice controls could not load. Try again.');

    act(() => emitSocket('connect'));
    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Dictating to Daily Log/)).toBeInTheDocument();
    warn.mockRestore();
  });

  it('says so and tries again on the next press when the chunk fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await renderWhileLoading();

    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    await chunk.fail(new Error('network unreachable'));
    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith('Voice controls could not load. Try again.');
    expect(mocks.reloadOnceForStaleChunk).not.toHaveBeenCalled();
    expect(mocks.startContinuous).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: DISENGAGE }));
    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());
    expect(mocks.loadWidget).toHaveBeenCalledTimes(2);
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('answers a press made during the stale-build check with that attempt, not a second import', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let finishProbe;
    mocks.reloadOnceForStaleChunk.mockReturnValueOnce(new Promise((resolve) => { finishProbe = resolve; }));
    const chunk = await renderWhileLoading();
    const engage = screen.getByRole('button', { name: ENGAGE });
    await chunk.fail(new Error('Failed to fetch dynamically imported module'));
    expect(mocks.reloadOnceForStaleChunk).toHaveBeenCalledOnce();

    // Pressed while the check is still out: no second import may start, or
    // the first one's failure would discard this press after it succeeded.
    fireEvent.click(engage);
    await settle();
    expect(mocks.loadWidget).toHaveBeenCalledOnce();

    // Not a newer build after all: the press is told the load failed.
    await act(async () => { finishProbe(false); });
    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith('Voice controls could not load. Try again.');
    expect(mocks.startContinuous).not.toHaveBeenCalled();

    // And the next press loads the widget and opens the mic, once.
    fireEvent.click(screen.getByRole('button', { name: DISENGAGE }));
    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());
    expect(mocks.loadWidget).toHaveBeenCalledTimes(2);
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('hands a chunk from a replaced build to the stale-build reload instead of reporting it', async () => {
    mocks.reloadOnceForStaleChunk.mockResolvedValue(true);
    const chunk = await renderWhileLoading();

    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    await chunk.fail(new Error('Failed to fetch dynamically imported module'));

    expect(mocks.reloadOnceForStaleChunk).toHaveBeenCalledOnce();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});

describe('VoiceWidgetGate — once the widget is listening', () => {
  it('starts once per toggle press, however the config changes afterwards', async () => {
    renderGate();
    await screen.findByRole('button', { name: ENGAGE });
    await settle();
    expect(mocks.loadWidget).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: ENGAGE }));
    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());

    // The widget heard that press itself; the gate has nothing to replay.
    act(() => emitSocket('voice:config:changed', { hotkey: 'KeyV' }));
    act(() => emitSocket('voice:config:changed', { enabled: false }));
    act(() => emitSocket('voice:config:changed', { enabled: true }));
    await settle();
    expect(mocks.startContinuous).toHaveBeenCalledOnce();
  });

  it('answers the hotkey once, from the widget', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    renderGate();
    await screen.findByRole('button', { name: WIDGET_MIC });

    expect(fireEvent.keyDown(window, { code: 'Space' })).toBe(false);
    await waitFor(() => expect(mocks.startContinuous).toHaveBeenCalledOnce());

    await settle();
    expect(mocks.startContinuous).toHaveBeenCalledOnce();
  });

  it.each([false, true])('keeps a disable event authoritative after delayed hydration (StrictMode: %s)', async (strict) => {
    let resolveConfig;
    mocks.getVoiceConfig.mockReturnValue(new Promise((resolve) => { resolveConfig = resolve; }));
    localStorage.setItem(HIDDEN_KEY, '0');
    const { unmount } = renderGate({ strict });

    act(() => emitSocket('voice:config:changed', { enabled: false }));
    await act(async () => resolveConfig({ enabled: true }));

    expect(screen.queryByRole('button', { name: 'Open voice controls' })).toBeNull();
    expect(screen.queryByRole('button', { name: DISENGAGE })).toBeNull();
    expect(mocks.loadWidget).not.toHaveBeenCalled();
    expect(mocks.startWebSpeechCapture).not.toHaveBeenCalled();
    unmount();
  });

  it('preserves event hotkey and engines while hydrating untouched language and personality', async () => {
    let resolveConfig;
    mocks.getVoiceConfig.mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));
    localStorage.setItem(HIDDEN_KEY, '0');
    const { unmount } = renderGate();
    const fastPath = { enabled: true, triggers: false, nano: false };
    act(() => emitSocket('voice:config:changed', {
      enabled: true, hotkey: 'KeyV', sttEngine: 'web-speech', fastPath,
      ttsEngine: 'kokoro', ttsVoice: 'new-voice', ttsRate: 1.2,
    }));
    await act(async () => resolveConfig({
      enabled: false, hotkey: 'Space', stt: { engine: 'whisper', language: 'fr' },
      llm: { fastPath: null, personality: { name: 'Example' } },
      tts: { engine: 'piper', piper: { voice: 'old-voice' }, rate: 1 },
    }));
    await screen.findByRole('button', { name: WIDGET_MIC });

    fireEvent.keyDown(window, { code: 'Space' });
    expect(mocks.startWebSpeechCapture).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { code: 'KeyV' });
    expect(mocks.startWebSpeechCapture).toHaveBeenCalledOnce();
    const capture = mocks.startWebSpeechCapture.mock.calls[0][0];
    expect(capture.language).toBe('fr');
    await act(async () => capture.routeFinal('example utterance'));
    expect(mocks.resolveTurn).toHaveBeenCalledWith('example utterance', expect.objectContaining({
      fastPath, personality: { name: 'Example' },
    }));
    expect(mocks.speakSynthesized).toHaveBeenCalledWith('Example reply', {
      engine: 'kokoro', voice: 'new-voice', rate: 1.2, animate: true,
    });
    unmount();
  });

  it.each(['before', 'after'])('uses hydrated and updated qwen3-tts settings for a hotkey pressed %s the widget mounts', async (pressTiming) => {
    mocks.getVoiceConfig.mockResolvedValue({
      enabled: true,
      hotkey: 'Space',
      stt: { engine: 'web-speech', language: 'en' },
      llm: { fastPath: { enabled: true } },
      tts: { engine: 'qwen3-tts', qwen3: { voice: 'warm-narrator' }, rate: 1.1 },
    });
    const chunk = deferWidgetChunk();
    localStorage.setItem(HIDDEN_KEY, '0');
    const { unmount } = renderGate();
    await settle();
    expect(screen.getByRole('button', { name: DISENGAGE })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Voice assistant' })).toBeNull();
    expect(mocks.loadWidget).toHaveBeenCalledOnce();

    const pressHotkey = () => expect(fireEvent.keyDown(window, { code: 'Space' })).toBe(false);
    if (pressTiming === 'before') {
      pressHotkey();
      expect(mocks.startWebSpeechCapture).not.toHaveBeenCalled();
    }
    await chunk.release();
    await screen.findByRole('complementary', { name: 'Voice assistant' });
    await settle();
    if (pressTiming === 'after') {
      expect(mocks.startWebSpeechCapture).not.toHaveBeenCalled();
      pressHotkey();
    }

    await waitFor(() => {
      expect(mocks.startWebSpeechCapture, 'an admitted hotkey starts one Web Speech capture').toHaveBeenCalledOnce();
    });
    const capture = mocks.startWebSpeechCapture.mock.calls[0][0];
    await act(async () => capture.routeFinal('example utterance'));
    expect(mocks.speakSynthesized).toHaveBeenCalledWith('Example reply', {
      engine: 'qwen3-tts', voice: 'warm-narrator', rate: 1.1, animate: true,
    });

    act(() => emitSocket('voice:config:changed', {
      ttsEngine: 'qwen3-tts',
      ttsVoice: 'expressive-alto',
      ttsRate: 1.25,
    }));
    await act(async () => capture.routeFinal('second utterance'));
    expect(mocks.speakSynthesized).toHaveBeenLastCalledWith('Example reply', {
      engine: 'qwen3-tts', voice: 'expressive-alto', rate: 1.25, animate: true,
    });
    unmount();
  });

  it('hydrates untouched hotkey and engines after a partial settings event', async () => {
    let resolveConfig;
    mocks.getVoiceConfig.mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));
    localStorage.setItem(HIDDEN_KEY, '0');
    const { unmount } = renderGate();
    act(() => emitSocket('voice:config:changed', { sttLanguage: 'de', fastPath: null }));
    await act(async () => resolveConfig({
      enabled: true, hotkey: 'KeyB', stt: { engine: 'web-speech', language: 'en' },
      llm: { fastPath: { enabled: true } },
    }));
    await screen.findByRole('button', { name: WIDGET_MIC });

    fireEvent.keyDown(window, { code: 'KeyB' });
    const capture = mocks.startWebSpeechCapture.mock.calls[0][0];
    expect(capture.language).toBe('de');
    await act(async () => capture.routeFinal('example utterance'));
    expect(mocks.resolveTurn).not.toHaveBeenCalled();
    expect(mocks.getVoiceConfig).toHaveBeenCalledOnce();
    unmount();
  });

  it('invalidates capture before invoking the latest cancel handler on unmount', async () => {
    localStorage.setItem(HIDDEN_KEY, '0');
    const { unmount } = renderGate();
    await screen.findByRole('button', { name: WIDGET_MIC });
    expect(mocks.interrupt).not.toHaveBeenCalled();

    mocks.isContinuous.mockReturnValue(true);
    unmount();

    expect(mocks.disposeCaptureOwner).toHaveBeenCalledOnce();
    expect(mocks.stopContinuous).toHaveBeenCalledOnce();
    expect(mocks.disposeCaptureOwner.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopContinuous.mock.invocationCallOrder[0]);
    // The teardown awaits the mic release before it drops queued speech.
    await waitFor(() => expect(mocks.interrupt).toHaveBeenCalledOnce());
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
