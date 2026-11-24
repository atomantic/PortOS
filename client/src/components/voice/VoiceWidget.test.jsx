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
  getVadLevel: vi.fn(() => 0),
  webSpeechSupported: true,
  startWebSpeechCapture: mocks.startWebSpeechCapture,
  stopWebSpeechCapture: mocks.stopWebSpeechCapture,
  isWebSpeechCapturing: vi.fn(() => false),
  disposeCaptureOwner: mocks.disposeCaptureOwner,
  onProactiveSpeech: vi.fn(() => vi.fn()),
  captureScreenForVision: vi.fn(),
  sendScreenshotResult: vi.fn(),
  enableVisionCapture: vi.fn(),
  disableVisionCapture: vi.fn(),
  isVisionCaptureEnabled: vi.fn(() => false),
  onVisionCaptureEnded: vi.fn(() => vi.fn()),
  speakSynthesized: mocks.speakSynthesized,
  onVoiceOutputPrimary: vi.fn((handler) => { handler(true); return vi.fn(); }),
  claimVoiceOutput: vi.fn(),
}));

vi.mock('../../services/voiceFastPath', () => ({
  resolveTurn: mocks.resolveTurn,
  buildRouterSystemPrompt: vi.fn(),
  TIER: { SERVER: 'server', TRIGGER: 'trigger', NANO: 'nano' },
}));

vi.mock('../../services/browserLlm', () => ({ warmNano: vi.fn() }));
vi.mock('../../services/apiPalette', () => ({ getPaletteManifest: vi.fn() }));
vi.mock('../../services/apiVoice', () => ({ getVoiceConfig: mocks.getVoiceConfig }));
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
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import VoiceWidgetGate from './VoiceWidgetGate';
import VoiceToggleButton from './VoiceToggleButton';
import * as voiceClientMock from '../../services/voiceClient';
import { ENGAGE_EVENT, DISENGAGE_EVENT } from '../../services/voiceVisibility';

const HIDDEN_KEY = 'portos.voice.hidden';
const settle = () => act(async () => {});

const renderWidget = async () => {
  localStorage.setItem(HIDDEN_KEY, '0');
  render(<VoiceWidgetGate><VoiceToggleButton /></VoiceWidgetGate>);
  await settle();
  return screen.findByRole('complementary', { name: 'Voice assistant' });
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

  it('exposes toggle states and keeps the active speaker focusable', async () => {
    const widget = await renderWidget();
    const speaker = within(widget).getByRole('button', { name: /speaker/ });
    expect(speaker).not.toBeDisabled();
    expect(speaker).toHaveAttribute('aria-pressed', 'true');
    expect(within(widget).getByRole('button', { name: /^(hands-free|push-to-talk)$/ })).toHaveAttribute('aria-pressed');
    expect(within(widget).getByRole('button', { name: 'Start hands-free listening' })).toHaveAttribute('aria-pressed', 'false');
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
    expect(within(widget).getByRole('button', { name: 'Show conversation' })).toHaveAttribute('aria-expanded', 'false');
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
});
