import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const toast = vi.fn();
  toast.error = vi.fn();
  return {
    toast,
    events: new Map(),
    startWebSpeechCapture: vi.fn(),
    resolveTurn: vi.fn(),
    speakSynthesized: vi.fn().mockResolvedValue(undefined),
    disposeCaptureOwner: vi.fn(),
    stopContinuous: vi.fn().mockResolvedValue(undefined),
    stopCapture: vi.fn().mockResolvedValue(null),
    stopWebSpeechCapture: vi.fn(),
    isContinuous: vi.fn(() => false),
    interrupt: vi.fn(),
    getVoiceConfig: vi.fn(() => Promise.resolve({
      enabled: true,
      hotkey: 'Space',
      stt: { engine: 'whisper', language: 'en' },
      llm: { fastPath: null },
      tts: { engine: 'piper', piper: { voice: 'example-voice' }, rate: 1 },
    })),
  };
});

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
  startContinuous: vi.fn(),
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
  onVoiceOutputPrimary: vi.fn((handler) => { handler(false); return vi.fn(); }),
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
vi.mock('../../hooks/useVoiceUiSync', () => ({
  useVoiceUiSync: vi.fn(),
  pushUiIndexAfterAction: vi.fn(),
}));
vi.mock('../../services/uiInteract', () => ({
  doClick: vi.fn(() => ({ ok: true })),
  doFill: vi.fn(() => ({ ok: true })),
  doSelect: vi.fn(() => ({ ok: true })),
  doSetCheckbox: vi.fn(() => ({ ok: true })),
}));
vi.mock('../../services/voiceVisibility', () => ({
  VISIBILITY_EVENT: 'voice-visibility',
  ENGAGE_EVENT: 'voice-engage',
  DISENGAGE_EVENT: 'voice-disengage',
  readVoiceHidden: vi.fn(() => false),
  writeVoiceHidden: vi.fn(),
  isVoiceHiddenStorageEvent: vi.fn(() => false),
}));
vi.mock('../micrographics', () => ({ MicroGlyph: () => null }));
vi.mock('../../lib/a11yKeyboard', () => ({ shouldIgnoreGlobalKey: vi.fn(() => false) }));
vi.mock('../../lib/safeStorage', () => ({
  safeReadStorage: vi.fn(() => null),
  safeWriteStorage: vi.fn(),
}));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import VoiceWidget from './VoiceWidget';

describe('VoiceWidget owner lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.clear();
    mocks.resolveTurn.mockResolvedValue({ tier: 'nano', reply: 'Example reply' });
    mocks.stopContinuous.mockResolvedValue(undefined);
    mocks.isContinuous.mockReturnValue(false);
    mocks.getVoiceConfig.mockResolvedValue({
      enabled: true,
      hotkey: 'Space',
      stt: { engine: 'whisper', language: 'en' },
      llm: { fastPath: null },
      tts: { engine: 'piper', piper: { voice: 'example-voice' }, rate: 1 },
    });
  });

  it('keeps a disable event authoritative when the initial enabled snapshot arrives later', async () => {
    let resolveConfig;
    mocks.getVoiceConfig.mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));
    const { unmount } = render(<VoiceWidget />);

    act(() => mocks.events.get('voice:config:changed')({ enabled: false }));
    await act(async () => resolveConfig({ enabled: true }));

    expect(screen.queryByRole('button', { name: 'Open voice controls' })).toBeNull();
    expect(mocks.startWebSpeechCapture).not.toHaveBeenCalled();
    unmount();
  });

  it('preserves event hotkey and engines while hydrating untouched language and personality', async () => {
    let resolveConfig;
    mocks.getVoiceConfig.mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));
    const { unmount } = render(<VoiceWidget />);
    const fastPath = { enabled: true, triggers: false, nano: false };
    act(() => mocks.events.get('voice:config:changed')({
      enabled: true, hotkey: 'KeyV', sttEngine: 'web-speech', fastPath,
      ttsEngine: 'kokoro', ttsVoice: 'new-voice', ttsRate: 1.2,
    }));
    await act(async () => resolveConfig({
      enabled: false, hotkey: 'Space', stt: { engine: 'whisper', language: 'fr' },
      llm: { fastPath: null, personality: { name: 'Example' } },
      tts: { engine: 'piper', piper: { voice: 'old-voice' }, rate: 1 },
    }));

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
      engine: 'kokoro', voice: 'new-voice', rate: 1.2,
    });
    unmount();
  });

  it('hydrates untouched hotkey and engines after a partial settings event', async () => {
    let resolveConfig;
    mocks.getVoiceConfig.mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));
    const { unmount } = render(<VoiceWidget />);
    act(() => mocks.events.get('voice:config:changed')({ sttLanguage: 'de', fastPath: null }));
    await act(async () => resolveConfig({
      enabled: true, hotkey: 'KeyB', stt: { engine: 'web-speech', language: 'en' },
      llm: { fastPath: { enabled: true } },
    }));
    fireEvent.keyDown(window, { code: 'KeyB' });
    const capture = mocks.startWebSpeechCapture.mock.calls[0][0];
    expect(capture.language).toBe('de');
    await act(async () => capture.routeFinal('example utterance'));
    expect(mocks.resolveTurn).not.toHaveBeenCalled();
    expect(mocks.getVoiceConfig).toHaveBeenCalledOnce();
    unmount();
  });

  it('invalidates capture before invoking the latest cancel handler on unmount', async () => {
    const { unmount } = render(<VoiceWidget />);

    mocks.isContinuous.mockReturnValue(true);
    unmount();

    expect(mocks.disposeCaptureOwner).toHaveBeenCalledOnce();
    expect(mocks.stopContinuous).toHaveBeenCalledOnce();
    expect(mocks.interrupt).toHaveBeenCalledOnce();
    expect(mocks.disposeCaptureOwner.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopContinuous.mock.invocationCallOrder[0]);
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
