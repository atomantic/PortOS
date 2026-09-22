import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const toast = vi.fn();
  toast.error = vi.fn();
  return {
    toast,
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
  onVoiceEvent: vi.fn(() => vi.fn()),
  isCapturing: vi.fn(() => false),
  startContinuous: vi.fn(),
  stopContinuous: mocks.stopContinuous,
  isContinuous: mocks.isContinuous,
  whenPlaybackDrained: vi.fn(() => Promise.resolve(true)),
  getVadLevel: vi.fn(() => 0),
  webSpeechSupported: false,
  startWebSpeechCapture: vi.fn(),
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
  speakSynthesized: vi.fn(),
  onVoiceOutputPrimary: vi.fn((handler) => { handler(false); return vi.fn(); }),
  claimVoiceOutput: vi.fn(),
}));

vi.mock('../../services/voiceFastPath', () => ({
  resolveTurn: vi.fn(),
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
