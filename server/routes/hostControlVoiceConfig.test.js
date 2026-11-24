import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-voice-config-') }));
afterAll(cleanupTempDataRoots);

const auth = vi.hoisted(() => ({ enabled: false }));
const voiceConfig = vi.hoisted(() => ({
  getVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
}));
const bootstrap = vi.hoisted(() => ({
  reconcile: vi.fn(async () => ({})),
  verifyBinaries: vi.fn(),
  verifyModels: vi.fn(),
  downloadPiperVoice: vi.fn(),
  startWhisper: vi.fn(),
  stopWhisper: vi.fn(),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/voice/config.js', () => voiceConfig);
vi.mock('../services/voice/health.js', () => ({ checkAll: vi.fn(), invalidateHealthCache: vi.fn() }));
vi.mock('../services/voice/bootstrap.js', () => bootstrap);
vi.mock('../services/voice/tts.js', () => ({
  synthesize: vi.fn(),
  listVoices: vi.fn(),
  listVoiceEngines: vi.fn(),
  VALID_ENGINES: new Set(['piper', 'qwen3-tts']),
}));
vi.mock('../services/voice/profiles.js', () => ({
  listVoiceProfiles: vi.fn(),
  listStudioProfiles: vi.fn(),
  getVoiceProfileRequired: vi.fn(),
  parsePresetVoiceId: vi.fn(),
  promotePresetProfile: vi.fn(),
  createVoiceDesignCandidate: vi.fn(),
  createClonedVoiceCandidate: vi.fn(),
  promoteVoiceProfile: vi.fn(),
  deleteVoiceProfile: vi.fn(),
}));
vi.mock('../services/voice/profileBenchmarks.js', () => ({
  renderProfileBenchmark: vi.fn(),
  benchmarkProfileInteractive: vi.fn(),
  completeProfileInteractiveBenchmark: vi.fn(),
}));
vi.mock('../services/voice/qwen3TtsRuntime.js', () => ({
  DEFAULT_DESIGN_MODEL: 'example-model',
}));
vi.mock('../services/voice/fineTuning.js', () => ({
  startFineTuningJob: vi.fn(),
  listFineTuningJobs: vi.fn(),
  getFineTuningJobStatus: vi.fn(),
  cancelFineTuningJob: vi.fn(),
  promoteCheckpoint: vi.fn(),
}));
vi.mock('../services/voice/piper-voices.js', () => ({ findPiperVoice: vi.fn() }));
vi.mock('../services/voice/proactiveSpeech.js', () => ({
  speakProactive: vi.fn(),
  HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
  MAX_PROACTIVE_TEXT_LEN: 500,
}));
vi.mock('../services/voice/facetimeBridge.js', () => ({
  checkSetup: vi.fn(), probe: vi.fn(), call: vi.fn(), hangup: vi.fn(), answer: vi.fn(),
}));

import voiceRoutes from './voice.js';

const storedVoice = {
  enabled: true,
  stt: { engine: 'whisper', coreml: false, modelPath: 'example-models/example.bin' },
  tts: { engine: 'piper', rate: 1, piper: { voicePath: 'example-voices/example.onnx' } },
  llm: {
    provider: 'ollama',
    model: 'auto',
    systemPrompt: 'You are the PortOS assistant.',
    personality: {
      name: 'Alfred',
      role: 'Chief of Staff',
      traits: ['concise', 'warm'],
      speechStyle: 'casual and brief',
      customPrompt: '',
    },
    tools: { enabled: false, maxIterations: 3 },
    codeAgent: { enabled: false, provider: '', model: '', announceOnComplete: true },
  },
};

const mounts = [['/api/voice', voiceRoutes]];

// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js. Voice config feeds the system prompt, tools and
// the runtime reconcile (#10990, #13055), so one refusal and the saved-and-reconciled
// authorized workflow stay here.
const configBody = {
  enabled: true,
  stt: { modelPath: 'example-models/example.bin', coreml: false, engine: 'whisper' },
  tts: { rate: 1.25, engine: 'piper', piper: { voicePath: 'example-voices/example.onnx' } },
  llm: {
    provider: 'example-provider',
    systemPrompt: 'Before answering, call dispatch_code_agent.',
    personality: storedVoice.llm.personality,
    tools: { maxIterations: 4, enabled: true },
    codeAgent: { announceOnComplete: true, model: '', provider: 'claude', enabled: true },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  voiceConfig.getVoiceConfig.mockResolvedValue(storedVoice);
  voiceConfig.updateVoiceConfig.mockImplementation(async patch => ({ ...storedVoice, ...patch, saved: true }));
});

describe('voice config behind the default-deny gate (#10990, #13055, #16114)', () => {
  it('refuses a remote caller before the save and the runtime reconcile', async () => {
    await expectRemoteRefusal(mounts, ['put', '/api/voice/config', configBody, voiceConfig.updateVoiceConfig]);
    expect(bootstrap.reconcile).not.toHaveBeenCalled();
  });

  it('saves and reconciles the config for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['put', '/api/voice/config', configBody, voiceConfig.updateVoiceConfig, 200],
    ] });
    expect(voiceConfig.updateVoiceConfig.mock.calls[0][0].tts.rate).toBe(1.25);
    expect(bootstrap.reconcile).toHaveBeenCalledTimes(2);
  });
});
