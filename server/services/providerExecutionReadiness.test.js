import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureOllama: vi.fn(),
  ensureMtplx: vi.fn(),
  isOllama: vi.fn(),
  isMtplx: vi.fn(),
}));

vi.mock('./ollamaManager.js', () => ({
  ensureProviderReady: mocks.ensureOllama,
  isOllamaProvider: mocks.isOllama,
}));

vi.mock('./mtplxServerManager.js', () => ({
  ensureMtplxProviderReady: mocks.ensureMtplx,
  isMtplxProvider: mocks.isMtplx,
}));

const { ensureProviderReadyForExecution } = await import('./providerExecutionReadiness.js');

describe('provider execution readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureOllama.mockResolvedValue({ success: true });
    mocks.ensureMtplx.mockResolvedValue({ success: true });
    mocks.isOllama.mockReturnValue(false);
    mocks.isMtplx.mockReturnValue(false);
  });

  it('leaves providers without a managed local daemon alone', async () => {
    const provider = { id: 'remote', type: 'api' };

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureOllama).not.toHaveBeenCalled();
    expect(mocks.ensureMtplx).not.toHaveBeenCalled();
  });

  it('uses Ollama readiness for an Ollama provider', async () => {
    const provider = { id: 'ollama', type: 'api' };
    mocks.isOllama.mockReturnValue(true);

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureOllama).toHaveBeenCalledWith(provider);
    expect(mocks.ensureMtplx).not.toHaveBeenCalled();
  });

  it('wakes MTPLX for an MTPLX provider', async () => {
    const provider = { id: 'mtplx', type: 'api' };
    mocks.isMtplx.mockReturnValue(true);

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureMtplx).toHaveBeenCalledWith(provider);
    expect(mocks.ensureOllama).not.toHaveBeenCalled();
  });

  it('keeps the failing runtime in the error shown by the runner', async () => {
    const provider = { id: 'mtplx', type: 'api' };
    mocks.isMtplx.mockReturnValue(true);
    mocks.ensureMtplx.mockResolvedValue({ success: false, error: 'checkpoint failed to load' });

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({
      success: false,
      error: 'MTPLX is not running and PortOS could not start it: checkpoint failed to load',
    });
  });
});
