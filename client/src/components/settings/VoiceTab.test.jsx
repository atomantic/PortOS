import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import VoiceTab from './VoiceTab';
import { getProviders } from '../../services/apiProviders';

const voiceApi = vi.hoisted(() => ({
  getVoiceStatus: vi.fn(),
  getVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
  listVoices: vi.fn(),
  listVoiceEngines: vi.fn(),
  testTts: vi.fn(),
  fetchPiperVoice: vi.fn(),
  getFaceTimeStatus: vi.fn(),
  controlFaceTime: vi.fn(),
}));

vi.mock('../../services/apiVoice', () => voiceApi);
vi.mock('../../services/apiProviders', () => ({
  getProviders: vi.fn().mockResolvedValue({ providers: [] }),
  refreshProviderModels: vi.fn(),
}));
vi.mock('../../services/voiceClient', () => ({ playWav: vi.fn(), webSpeechSupported: true }));
vi.mock('../../services/browserLlm', () => ({ nanoAvailability: vi.fn().mockResolvedValue('available') }));
vi.mock('../../services/voiceVisibility', () => ({
  readVoiceHidden: vi.fn(() => false),
  writeVoiceHidden: vi.fn(),
}));
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: () => false }),
}));

const config = {
  enabled: false,
  hotkey: 'Space',
  facetime: {},
  stt: {
    engine: 'web-speech', endpoint: 'http://127.0.0.1:5562', model: 'base.en', coreml: false,
  },
  tts: {
    engine: 'qwen3-tts',
    rate: 1,
    kokoro: { voice: 'af_heart', dtype: 'q8' },
    piper: { voice: 'en_GB-jenny_dioco-medium' },
    qwen3: { voice: 'warm-narrator' },
  },
  llm: {
    provider: 'lmstudio',
    model: 'auto',
    visionModel: 'auto',
    systemPrompt: '',
    usePersonality: false,
    personality: {},
    tools: { enabled: false },
    codeAgent: { enabled: false },
    proactive: { enabled: false },
    fastPath: { enabled: false },
  },
};

describe('VoiceTab TTS engine registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceApi.getVoiceConfig.mockResolvedValue(structuredClone(config));
    voiceApi.getVoiceStatus.mockResolvedValue({ services: {} });
    voiceApi.listVoiceEngines.mockResolvedValue({
      engines: [
        { id: 'kokoro', configKey: 'kokoro', label: 'Kokoro', description: 'In-process, high quality' },
        { id: 'piper', configKey: 'piper', label: 'Piper', description: 'CLI binary, lightweight' },
        { id: 'qwen3-tts', configKey: 'qwen3', label: 'Qwen3-TTS', description: 'Voice design, cloning, and streaming', aliases: ['qwen3'] },
      ],
    });
    voiceApi.listVoices.mockResolvedValue({
      engine: 'qwen3-tts',
      voices: [
        { name: 'warm-narrator', label: 'Warm Narrator', language: 'en', gender: 'neutral' },
        { name: 'expressive-alto', label: 'Expressive Alto', language: 'en', gender: 'female' },
      ],
    });
    voiceApi.updateVoiceConfig.mockImplementation(async (nextConfig) => ({
      config: nextConfig,
      reconciliation: { skipped: true },
    }));
  });

  it('explains the Kokoro upgrade and keeps Piper setup user-triggered', async () => {
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config), tts: { ...config.tts, engine: 'piper', retiredEngine: 'kokoro' },
    });
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    expect(await screen.findByText(/Kokoro has been retired/)).toHaveTextContent('Save & Reconcile');
    expect(screen.getByRole('combobox', { name: 'TTS engine' })).toHaveValue('piper');
    expect(voiceApi.updateVoiceConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save & Reconcile' }));
    await waitFor(() => expect(voiceApi.updateVoiceConfig).toHaveBeenCalled());
  });

  it('loads engine options and patches the registry configuration key for Qwen3 voices', async () => {
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    const engineSelect = await screen.findByRole('combobox', { name: 'TTS engine' });
    expect(voiceApi.listVoiceEngines).toHaveBeenCalledWith({ silent: true });
    expect(engineSelect).toHaveValue('qwen3-tts');
    expect(screen.getByRole('option', { name: 'Qwen3-TTS (Voice design, cloning, and streaming)' })).toBeTruthy();

    // The selector mounts before its async voice catalog has loaded.
    await screen.findByRole('option', { name: /Expressive Alto/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Voice' }), {
      target: { value: 'expressive-alto' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Reconcile' }));

    await waitFor(() => expect(voiceApi.updateVoiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        tts: expect.objectContaining({
          qwen3: expect.objectContaining({ voice: 'expressive-alto' }),
          piper: expect.objectContaining({ voice: 'en_GB-jenny_dioco-medium' }),
        }),
      }),
      { silent: true },
    ));
  });

  it('preserves the saved engine and disables voice edits when registry metadata is unavailable', async () => {
    voiceApi.listVoiceEngines.mockRejectedValueOnce(new Error('offline'));

    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    const engineSelect = await screen.findByRole('combobox', { name: 'TTS engine' });
    expect(engineSelect).toHaveValue('qwen3-tts');
    expect(screen.getByRole('option', { name: 'qwen3-tts (current)' })).toBeTruthy();
    expect(await screen.findByText(/Could not load the TTS engine registry/)).toBeTruthy();

    const voiceSelect = await screen.findByRole('combobox', { name: 'Voice' });
    expect(voiceSelect).toHaveValue('warm-narrator');
    expect(voiceSelect.disabled).toBe(true);
  });

  it('normalizes a legacy Qwen engine alias from registry metadata', async () => {
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      tts: { ...structuredClone(config.tts), engine: 'qwen3' },
    });

    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    expect(await screen.findByRole('combobox', { name: 'TTS engine' })).toHaveValue('qwen3-tts');
    expect(screen.getByRole('combobox', { name: 'Voice' }).disabled).toBe(false);
  });

  it('keeps a linked voice the fetched catalog no longer has selectable', async () => {
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      tts: { ...structuredClone(config.tts), qwen3: { voice: 'retired-voice' } },
    });

    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    const voiceSelect = await screen.findByRole('combobox', { name: 'Voice' });
    expect(voiceSelect).toHaveValue('retired-voice');
    expect(screen.getByRole('option', { name: 'retired-voice (current)' })).toBeTruthy();
  });
});

describe('VoiceTab LLM / code-agent pickers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceApi.getVoiceConfig.mockResolvedValue(structuredClone(config));
    voiceApi.getVoiceStatus.mockResolvedValue({ services: {} });
    voiceApi.listVoiceEngines.mockResolvedValue({ engines: [] });
    voiceApi.listVoices.mockResolvedValue({ engine: 'qwen3-tts', voices: [] });
  });

  it('keeps a linked LLM provider, model, and vision model the registry no longer lists selectable', async () => {
    getProviders.mockResolvedValue({
      providers: [{ id: 'lmstudio', type: 'api', name: 'LM Studio', models: ['some-model'] }],
    });
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      llm: {
        ...structuredClone(config.llm),
        provider: 'retired-provider',
        model: 'retired-model',
        visionModel: 'retired-vision-model',
      },
    });

    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    const providerSelect = await screen.findByRole('combobox', { name: 'LLM provider' });
    expect(providerSelect).toHaveValue('retired-provider');
    expect(screen.getByRole('option', { name: 'retired-provider (not an API provider)' })).toBeTruthy();

    expect(screen.getByRole('combobox', { name: 'LLM model' })).toHaveValue('retired-model');
    expect(screen.getByRole('option', { name: 'retired-model (current)' })).toBeTruthy();

    expect(screen.getByRole('combobox', { name: 'Vision model' })).toHaveValue('retired-vision-model');
    expect(screen.getByRole('option', { name: 'retired-vision-model (current)' })).toBeTruthy();
  });

  it('shows the saved LLM provider without a false "not an API provider" label while the registry has not loaded', async () => {
    getProviders.mockReturnValue(new Promise(() => {})); // never resolves
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      llm: { ...structuredClone(config.llm), provider: 'lmstudio' },
    });

    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    const providerSelect = await screen.findByRole('combobox', { name: 'LLM provider' });
    expect(providerSelect).toHaveValue('lmstudio');
    expect(screen.getByRole('option', { name: 'lmstudio' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /not an API provider/ })).toBeNull();
  });

  it('keeps a linked coding agent and its model selectable once the registry has loaded', async () => {
    getProviders.mockResolvedValue({
      providers: [{ id: 'claude-code', type: 'cli', name: 'Claude Code', models: ['sonnet'] }],
    });
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      llm: {
        ...structuredClone(config.llm),
        codeAgent: { enabled: true, provider: 'retired-agent', model: 'retired-agent-model' },
      },
    });

    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    const agentSelect = await screen.findByRole('combobox', { name: 'Coding agent' });
    expect(agentSelect).toHaveValue('retired-agent');
    expect(screen.getByRole('option', { name: 'retired-agent (not a coding agent)' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('retired-agent-model');
    expect(screen.getByRole('option', { name: 'retired-agent-model (current)' })).toBeTruthy();
  });

  it('does not mislabel a saved coding agent while the registry has not loaded', async () => {
    getProviders.mockReturnValue(new Promise(() => {})); // never resolves
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      llm: {
        ...structuredClone(config.llm),
        codeAgent: { enabled: true, provider: 'retired-agent', model: 'retired-agent-model' },
      },
    });

    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    await screen.findByRole('combobox', { name: 'Coding agent' });
    expect(screen.queryByRole('option', { name: /not a coding agent/ })).toBeNull();
  });
});
