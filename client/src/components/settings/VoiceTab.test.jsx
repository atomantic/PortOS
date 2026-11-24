import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import VoiceTab from './VoiceTab';
import { getProviders } from '../../services/apiProviders';
import { nanoAvailability } from '../../services/browserLlm';
import toast from '../ui/Toast';

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

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
const featureFlags = vi.hoisted(() => ({ facetime: false }));
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: (name) => name === 'facetime' && featureFlags.facetime }),
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

  it('labels a healthy facetime service probe without a false down badge', async () => {
    voiceApi.getVoiceStatus.mockResolvedValue({ services: { facetime: { ok: true, state: 'ready' } } });
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    expect(await screen.findByText(/FaceTime Audio/)).toBeTruthy();
    expect(screen.queryByText(/facetime down/i)).toBeNull();
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

  it('shows an error row with Retry when the voice catalog fails, not a picker offering only the saved voice', async () => {
    voiceApi.listVoices.mockRejectedValueOnce(new Error('voices 500'));
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load voices — voices 500');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('option', { name: /Expressive Alto/ });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('VoiceTab Piper voice download guards', () => {
  const piperVoices = [
    { name: 'voice-a', label: 'Voice A', downloaded: false, path: '/a' },
    { name: 'voice-b', label: 'Voice B', downloaded: false, path: '/b' },
  ];
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    voiceApi.getVoiceConfig.mockResolvedValue({ ...structuredClone(config), tts: { ...config.tts, engine: 'piper' } });
    voiceApi.getVoiceStatus.mockResolvedValue({ services: {} });
    voiceApi.listVoiceEngines.mockResolvedValue({
      engines: [
        { id: 'piper', configKey: 'piper', label: 'Piper', description: 'CLI' },
        { id: 'qwen3-tts', configKey: 'qwen3', label: 'Qwen3-TTS', description: 'x', aliases: ['qwen3'] },
      ],
    });
    voiceApi.listVoices.mockImplementation(async (engine) => (engine === 'piper'
      ? { voices: piperVoices }
      : { voices: [{ name: 'warm-narrator', label: 'Warm Narrator' }] }));
  });

  it('does not overwrite the new engine voice list when a Piper download resolves after an engine switch', async () => {
    const d = deferred();
    voiceApi.fetchPiperVoice.mockReturnValue(d.promise);
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    await screen.findByRole('option', { name: /voice-b/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Voice' }), { target: { value: 'voice-a' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'TTS engine' }), { target: { value: 'qwen3-tts' } });
    await screen.findByRole('option', { name: /Warm Narrator/ });
    await act(async () => { d.resolve(); await new Promise((r) => setTimeout(r, 20)); });
    await waitFor(() => expect(voiceApi.listVoices).toHaveBeenCalledWith('piper', { silent: true }));
    expect(screen.getByRole('option', { name: /Warm Narrator/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /voice-b/ })).toBeNull();
  });

  it('keeps the latest requested voice downloading when an earlier download settles first', async () => {
    const a = deferred();
    const b = deferred();
    voiceApi.fetchPiperVoice.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    await screen.findByRole('option', { name: /voice-b/ });
    const select = screen.getByRole('combobox', { name: 'Voice' });
    fireEvent.change(select, { target: { value: 'voice-a' } });
    fireEvent.change(select, { target: { value: 'voice-b' } });
    await act(async () => { a.resolve(); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByRole('button', { name: 'Downloading voice-b…' }).disabled).toBe(true);
    await act(async () => { b.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview this voice' }).disabled).toBe(false));
  });

  it('performs no state updates or toasts after unmount when a download fails', async () => {
    const d = deferred();
    voiceApi.fetchPiperVoice.mockReturnValue(d.promise.then(() => { throw new Error('boom'); }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    await screen.findByRole('option', { name: /voice-b/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Voice' }), { target: { value: 'voice-a' } });
    unmount();
    await act(async () => { d.resolve(); await new Promise((r) => setTimeout(r, 20)); });
    expect(toast.error).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
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

  it('shows a load error with Retry beside the provider pickers, and a successful retry fills them', async () => {
    getProviders
      .mockRejectedValueOnce(new Error('registry 500'))
      .mockResolvedValueOnce({
        providers: [{ id: 'lmstudio', type: 'api', name: 'LM Studio', models: ['some-model'] }],
      });
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('registry 500');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findAllByRole('option', { name: 'some-model' })).not.toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('VoiceTab personality traits input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      llm: { ...structuredClone(config.llm), usePersonality: true },
    });
    voiceApi.getVoiceStatus.mockResolvedValue({ services: {} });
    voiceApi.listVoiceEngines.mockResolvedValue({ engines: [] });
    voiceApi.listVoices.mockResolvedValue({ engine: 'qwen3-tts', voices: [] });
    getProviders.mockResolvedValue({ providers: [] });
  });

  it('keeps typed commas and spaces and saves the normalized trait list', async () => {
    voiceApi.updateVoiceConfig.mockImplementation(async (c) => ({ config: c, reconciliation: {} }));
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    const input = await screen.findByLabelText(/Traits/);
    let typed = '';
    for (const ch of 'concise, warm, very direct') {
      typed += ch;
      fireEvent.change(input, { target: { value: typed } });
      expect(input).toHaveValue(typed);
    }
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(voiceApi.updateVoiceConfig).toHaveBeenCalled());
    expect(voiceApi.updateVoiceConfig.mock.calls[0][0].llm.personality.traits)
      .toEqual(['concise', 'warm', 'very direct']);
  });
});

describe('VoiceTab FaceTime identity gating', () => {
  const saved = { targetName: 'Alex', targetHandle: '+15550100' };
  const buttons = () => ['Probe', 'Test call', 'Hangup'].map((n) => screen.getByRole('button', { name: n }));

  beforeEach(() => {
    vi.clearAllMocks();
    featureFlags.facetime = true;
    voiceApi.getVoiceStatus.mockResolvedValue({ services: {} });
    voiceApi.listVoiceEngines.mockResolvedValue({ engines: [] });
    voiceApi.listVoices.mockResolvedValue({ engine: 'qwen3-tts', voices: [] });
    voiceApi.getFaceTimeStatus.mockResolvedValue({});
    getProviders.mockResolvedValue({ providers: [] });
  });

  afterEach(() => { featureFlags.facetime = false; });

  it('keeps controls disabled for typed-but-unsaved identity until Save succeeds', async () => {
    voiceApi.getVoiceConfig.mockResolvedValue(structuredClone(config));
    voiceApi.updateVoiceConfig.mockImplementation(async (c) => ({ config: c, reconciliation: {} }));
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Target name'), { target: { value: 'Alex' } });
    fireEvent.change(screen.getByLabelText('Target handle'), { target: { value: '+15550100' } });
    buttons().forEach((b) => expect(b).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => buttons().forEach((b) => expect(b).toBeEnabled()));
  });

  it('disables controls when a saved handle is edited and re-enables when reverted', async () => {
    voiceApi.getVoiceConfig.mockResolvedValue({ ...structuredClone(config), facetime: { ...saved } });
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    const handle = await screen.findByLabelText('Target handle');
    await waitFor(() => buttons().forEach((b) => expect(b).toBeEnabled()));
    fireEvent.change(handle, { target: { value: '+15550199' } });
    buttons().forEach((b) => expect(b).toBeDisabled());
    fireEvent.change(handle, { target: { value: '+15550100' } });
    buttons().forEach((b) => expect(b).toBeEnabled());
  });

  it('surfaces the server refusal message on a 409 FaceTime test call', async () => {
    voiceApi.getVoiceConfig.mockResolvedValue({ ...structuredClone(config), facetime: { ...saved } });
    voiceApi.controlFaceTime.mockRejectedValueOnce(Object.assign(
      new Error('No FaceTime call host tab is attached'),
      { code: 'NO_CALL_HOST', status: 409, context: { command: 'call', reason: 'no-call-host' } },
    ));
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    const testCallBtn = await screen.findByRole('button', { name: 'Test call' });
    await waitFor(() => expect(testCallBtn).toBeEnabled());
    fireEvent.click(testCallBtn);
    await waitFor(() => expect(screen.getByText(/No FaceTime call host tab is attached/)).toBeInTheDocument());
    expect(voiceApi.controlFaceTime).toHaveBeenCalledWith('call', { silent: true });
  });
});

describe('VoiceTab initial load failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceApi.getVoiceConfig.mockResolvedValue(structuredClone(config));
    voiceApi.getVoiceStatus.mockResolvedValue({ services: {} });
    voiceApi.listVoiceEngines.mockResolvedValue({ engines: [] });
    voiceApi.listVoices.mockResolvedValue({ engine: 'qwen3-tts', voices: [] });
  });

  it('shows an alert with the error message and a working Retry when config fails', async () => {
    voiceApi.getVoiceConfig.mockRejectedValueOnce(new Error('config boom'));
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('config boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/config boom/)).toBeNull());
    expect(voiceApi.getVoiceConfig).toHaveBeenCalledTimes(2);
  });

  it('lets a speech rate below 1 be typed', async () => {
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    const rate = await screen.findByLabelText('Speech rate');
    fireEvent.change(rate, { target: { value: '0' } });
    expect(rate).toHaveValue(0);
    fireEvent.change(rate, { target: { value: '0.8' } });
    fireEvent.blur(rate);
    expect(rate).toHaveValue(0.8);
  });

  it('still renders the form when only the status probe fails', async () => {
    voiceApi.getVoiceStatus.mockRejectedValue(new Error('status down'));
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText(/Loading voice settings/)).toBeNull());
    expect(screen.queryByText(/Could not load voice settings/)).toBeNull();
  });
});

describe('VoiceTab fast-path and footer refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceApi.getVoiceConfig.mockResolvedValue({
      ...structuredClone(config),
      llm: { ...structuredClone(config.llm), fastPath: { enabled: true, browserLlm: true } },
    });
    voiceApi.getVoiceStatus.mockResolvedValue({ services: {} });
    voiceApi.listVoiceEngines.mockResolvedValue({ engines: [] });
    voiceApi.listVoices.mockResolvedValue({ engine: 'qwen3-tts', voices: [] });
    nanoAvailability.mockResolvedValue('available');
  });

  it('probes Gemini Nano status in the fast-path section and refreshes voices from footer Refresh', async () => {
    render(<MemoryRouter><VoiceTab /></MemoryRouter>);
    expect(await screen.findByText('On-device model ready')).toBeTruthy();

    nanoAvailability.mockResolvedValue('downloadable');
    fireEvent.click(screen.getByLabelText(/Tier 2 — on-device browser model/));
    fireEvent.click(screen.getByLabelText(/Tier 2 — on-device browser model/));
    expect(await screen.findByText('Available — downloads on first use')).toBeTruthy();

    const callsBefore = voiceApi.listVoices.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(voiceApi.listVoices.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(voiceApi.getVoiceStatus).toHaveBeenCalledTimes(2);
  });
});
