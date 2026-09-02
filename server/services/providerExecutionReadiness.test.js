import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureOllama: vi.fn(),
  ensureMtplx: vi.fn(),
  isOllama: vi.fn(),
  isMtplx: vi.fn(),
  ensureSlotstream: vi.fn(),
  isSlotstream: vi.fn(),
}));

vi.mock('./ollamaManager.js', () => ({
  ensureProviderReady: mocks.ensureOllama,
  isOllamaProvider: mocks.isOllama,
}));

vi.mock('./mtplxServerManager.js', () => ({
  ensureMtplxProviderReady: mocks.ensureMtplx,
  isMtplxProvider: mocks.isMtplx,
}));

vi.mock('./slotstreamServerManager.js', () => ({
  ensureSlotstreamProviderReady: mocks.ensureSlotstream,
  isSlotstreamProvider: mocks.isSlotstream,
}));

const { ensureProviderReadyForExecution } = await import('./providerExecutionReadiness.js');

describe('provider execution readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureOllama.mockResolvedValue({ success: true });
    mocks.ensureMtplx.mockResolvedValue({ success: true });
    mocks.isOllama.mockReturnValue(false);
    mocks.isMtplx.mockReturnValue(false);
    mocks.ensureSlotstream.mockResolvedValue({ success: true });
    mocks.isSlotstream.mockReturnValue(false);
  });

  it('leaves configured providers without a managed local daemon alone', async () => {
    const provider = { id: 'remote', type: 'api', endpoint: 'https://api.example.com/v1', apiKey: 'sk-example' };

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureOllama).not.toHaveBeenCalled();
    expect(mocks.ensureMtplx).not.toHaveBeenCalled();
  });

  it('rejects a public API provider without its required key before fetch', async () => {
    const provider = {
      id: 'nvidia-kimi',
      name: 'NVIDIA Kimi K2.5',
      type: 'api',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      apiKey: '',
    };

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({
      success: false,
      error: 'Authentication unavailable for NVIDIA Kimi K2.5: API key is not set. Add it in Settings > AI Providers.',
    });
    expect(mocks.ensureOllama).not.toHaveBeenCalled();
    expect(mocks.ensureMtplx).not.toHaveBeenCalled();
  });

  it('keeps private-network API endpoints keyless', async () => {
    const provider = { id: 'peer-llm', type: 'api', endpoint: 'http://desk.ts.net:11434/v1', apiKey: '' };

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
  });

  it('uses Ollama readiness for an Ollama provider', async () => {
    const provider = { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' };
    mocks.isOllama.mockReturnValue(true);

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureOllama).toHaveBeenCalledWith(provider);
    expect(mocks.ensureMtplx).not.toHaveBeenCalled();
  });

  it('wakes MTPLX for an MTPLX provider', async () => {
    const provider = { id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' };
    mocks.isMtplx.mockReturnValue(true);

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureMtplx).toHaveBeenCalledWith(provider);
    expect(mocks.ensureOllama).not.toHaveBeenCalled();
  });

  it('wakes Slotstream for a Slotstream provider the idle reaper stopped', async () => {
    const provider = { id: 'slotstream', type: 'api', endpoint: 'http://127.0.0.1:5564/v1' };
    mocks.isSlotstream.mockReturnValue(true);

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureSlotstream).toHaveBeenCalledWith(provider);
    expect(mocks.ensureOllama).not.toHaveBeenCalled();
    expect(mocks.ensureMtplx).not.toHaveBeenCalled();
  });

  it('keeps the failing runtime in the error shown by the runner', async () => {
    const provider = { id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' };
    mocks.isMtplx.mockReturnValue(true);
    mocks.ensureMtplx.mockResolvedValue({ success: false, error: 'checkpoint failed to load' });

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({
      success: false,
      error: 'MTPLX is not running and PortOS could not start it: checkpoint failed to load',
    });
  });
});
