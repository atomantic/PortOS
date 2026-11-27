import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../socketIo.js', () => ({ emitToOperators: vi.fn() }));
vi.mock('../llamaServerAutoStart.js', () => ({ setLlamaServerAutoStart: vi.fn() }));
vi.mock('../llamaServerManager.js', () => ({
  getLlamaServerStatus: vi.fn(),
  startLlamaServer: vi.fn(),
  stopLlamaServer: vi.fn(),
}));

import { emitToOperators } from '../socketIo.js';
import { getLlamaServerStatus, startLlamaServer as managedStartLlamaServer } from '../llamaServerManager.js';
import { setLlamaServerAutoStart } from '../llamaServerAutoStart.js';
import { CONVERSATIONAL_GEMMA } from '../../lib/voiceModelCatalog.js';
import {
  _resetConversationalGemmaSetupForTests,
  cancelConversationalGemmaSetup,
  getConversationalGemmaSetupStatus,
  startConversationalGemmaSetup,
} from './conversationalGemmaSetup.js';

describe('conversationalGemmaSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetConversationalGemmaSetupForTests();
  });

  afterEach(() => {
    _resetConversationalGemmaSetupForTests();
  });

  it('reports local disk and llama-server binary readiness without network probes', async () => {
    const status = await getConversationalGemmaSetupStatus({
      supported: true,
      resolveLlamaServerBinary: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-server'),
      readGgufStat: vi.fn().mockResolvedValue({ size: 33_000_000_000 }),
      getHfToken: vi.fn().mockResolvedValue('hf_test'),
    });

    expect(status).toMatchObject({
      supported: true,
      llamaInstalled: true,
      ggufExists: true,
      ggufSizeBytes: 33_000_000_000,
      hasHfToken: true,
      phase: 'idle',
      running: false,
    });
  });

  it('starts llama-server, enables provider, and selects Voice LLM when GGUF is already on disk', async () => {
    const startLlamaServer = vi.fn().mockResolvedValue({ running: true });
    const updateProvider = vi.fn().mockResolvedValue({});
    const updateVoiceConfig = vi.fn().mockResolvedValue({});

    const status = await startConversationalGemmaSetup({
      supported: true,
      awaitCompletion: true,
      resolveLlamaServerBinary: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-server'),
      readGgufStat: vi.fn().mockResolvedValue({ size: 33_000_000_000 }),
      getHfToken: vi.fn().mockResolvedValue(null),
      llamaInstallMod: {
        resolveLlamaServerBinary: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-server'),
        installLlamaServer: vi.fn(),
      },
      llamaLifecycleMod: {
        getLlamaServerStatus: vi.fn().mockResolvedValue({ running: false }),
        startLlamaServer,
        stopLlamaServer: vi.fn(),
      },
      providersMod: {
        getProviderById: vi.fn().mockResolvedValue({
          id: 'llama-server',
          endpoint: 'http://127.0.0.1:5568/v1',
          models: [],
          enabled: false,
        }),
        updateProvider,
        createProvider: vi.fn(),
      },
      voiceConfigMod: { updateVoiceConfig },
    });

    expect(startLlamaServer).toHaveBeenCalledWith(expect.objectContaining({
      model: CONVERSATIONAL_GEMMA.localGgufPath,
      alias: CONVERSATIONAL_GEMMA.id,
      specType: 'none',
      ctxSize: 4096,
    }));
    expect(updateProvider).toHaveBeenCalledWith('llama-server', expect.objectContaining({
      enabled: true,
      models: [CONVERSATIONAL_GEMMA.id],
      defaultModel: CONVERSATIONAL_GEMMA.id,
    }));
    expect(updateVoiceConfig).toHaveBeenCalledWith({
      llm: { provider: 'llama-server', model: CONVERSATIONAL_GEMMA.id },
    });
    expect(status.phase).toBe('ready');
    expect(emitToOperators).toHaveBeenCalledWith('voice:conversationalGemma:changed');
  });

  it('installs llama.cpp and surfaces token-required cleanly when GGUF and HF token are missing', async () => {
    const installLlamaServer = vi.fn().mockResolvedValue({});
    const status = await startConversationalGemmaSetup({
      supported: true,
      awaitCompletion: true,
      resolveLlamaServerBinary: vi.fn().mockReturnValue(null),
      readGgufStat: vi.fn().mockResolvedValue(null),
      getHfToken: vi.fn().mockResolvedValue(null),
      checkAccess: vi.fn().mockResolvedValue({ status: 'token-required' }),
      llamaInstallMod: {
        resolveLlamaServerBinary: vi.fn().mockReturnValue(null),
        installLlamaServer,
      },
      llamaLifecycleMod: {
        getLlamaServerStatus: vi.fn(),
        startLlamaServer: vi.fn(),
        stopLlamaServer: vi.fn(),
      },
    });

    expect(installLlamaServer).toHaveBeenCalledTimes(1);
    expect(status.phase).toBe('failed');
    expect(status.accessStatus).toBe('token-required');
  });

  it('installs, converts, launches, and selects Conversational Gemma end-to-end', async () => {
    const convertModel = vi.fn().mockImplementation(async ({ onProgress }) => {
      onProgress({ phase: 'downloading', detail: 'Downloading…', percent: 40 });
      onProgress({ phase: 'converting', detail: 'Converting…', percent: 80 });
    });
    const createProvider = vi.fn().mockResolvedValue({});
    const updateVoiceConfig = vi.fn().mockResolvedValue({});
    const startLlamaServer = vi.fn().mockResolvedValue({ running: true });

    const status = await startConversationalGemmaSetup({
      supported: true,
      awaitCompletion: true,
      resolveLlamaServerBinary: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-server'),
      readGgufStat: vi.fn().mockResolvedValue(null),
      getHfToken: vi.fn().mockResolvedValue('hf_secret'),
      checkAccess: vi.fn().mockResolvedValue({ status: 'ready' }),
      convertModel,
      llamaInstallMod: {
        resolveLlamaServerBinary: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-server'),
        installLlamaServer: vi.fn(),
      },
      llamaLifecycleMod: {
        getLlamaServerStatus: vi.fn().mockResolvedValue({ running: false }),
        startLlamaServer,
        stopLlamaServer: vi.fn(),
      },
      providersMod: {
        getProviderById: vi.fn().mockResolvedValue(null),
        createProvider,
        updateProvider: vi.fn(),
      },
      voiceConfigMod: { updateVoiceConfig },
    });

    expect(convertModel).toHaveBeenCalledTimes(1);
    expect(startLlamaServer).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'llama-server',
      enabled: true,
      models: [CONVERSATIONAL_GEMMA.id],
    }));
    expect(updateVoiceConfig).toHaveBeenCalledWith({
      llm: { provider: 'llama-server', model: CONVERSATIONAL_GEMMA.id },
    });
    expect(status.phase).toBe('ready');
  });

  it('launches llama-server through the serialized manager when no lifecycle double is injected', async () => {
    getLlamaServerStatus.mockResolvedValue({ running: false });
    managedStartLlamaServer.mockResolvedValue({ running: true });

    const status = await startConversationalGemmaSetup({
      supported: true,
      awaitCompletion: true,
      resolveLlamaServerBinary: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-server'),
      readGgufStat: vi.fn().mockResolvedValue({ size: 33_000_000_000 }),
      getHfToken: vi.fn().mockResolvedValue(null),
      llamaInstallMod: {
        resolveLlamaServerBinary: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-server'),
        installLlamaServer: vi.fn(),
      },
      providersMod: {
        getProviderById: vi.fn().mockResolvedValue(null),
        createProvider: vi.fn().mockResolvedValue({}),
        updateProvider: vi.fn(),
      },
      voiceConfigMod: { updateVoiceConfig: vi.fn().mockResolvedValue({}) },
    });

    expect(managedStartLlamaServer).toHaveBeenCalledWith(expect.objectContaining({ alias: CONVERSATIONAL_GEMMA.id }));
    expect(setLlamaServerAutoStart).toHaveBeenCalledWith(true);
    expect(status.phase).toBe('ready');
  });

  it('cancels safely when idle', async () => {
    const status = await cancelConversationalGemmaSetup({
      supported: true,
      resolveLlamaServerBinary: vi.fn().mockReturnValue(null),
      readGgufStat: vi.fn().mockResolvedValue(null),
      getHfToken: vi.fn().mockResolvedValue(null),
    });
    expect(status.phase).toBe('idle');
  });
});
