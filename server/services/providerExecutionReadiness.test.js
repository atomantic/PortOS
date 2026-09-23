import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

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

const { ensureProviderReadyForExecution, ensureManagedRuntimeReady } = await import('./providerExecutionReadiness.js');

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
      id: 'nvidia-nim',
      name: 'NVIDIA NIM',
      type: 'api',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      apiKey: '',
    };

    await expect(ensureProviderReadyForExecution(provider)).resolves.toEqual({
      success: false,
      error: 'Authentication unavailable for NVIDIA NIM: API key is not set. Add it in Settings > AI Providers.',
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

describe('ensureManagedRuntimeReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureOllama.mockResolvedValue({ success: true });
    mocks.ensureMtplx.mockResolvedValue({ success: true });
    mocks.isOllama.mockReturnValue(false);
    mocks.isMtplx.mockReturnValue(false);
    mocks.ensureSlotstream.mockResolvedValue({ success: true });
    mocks.isSlotstream.mockReturnValue(false);
  });

  it('is a no-op success for a provider no row recognizes', async () => {
    const provider = { id: 'remote', type: 'api', endpoint: 'https://api.example.com/v1' };
    await expect(ensureManagedRuntimeReady(provider)).resolves.toEqual({ success: true });
    expect(mocks.ensureOllama).not.toHaveBeenCalled();
    expect(mocks.ensureMtplx).not.toHaveBeenCalled();
    expect(mocks.ensureSlotstream).not.toHaveBeenCalled();
  });

  it('fires onStarting with the matched runtime label before waking it', async () => {
    const provider = { id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' };
    mocks.isMtplx.mockReturnValue(true);
    const onStarting = vi.fn();

    await expect(ensureManagedRuntimeReady(provider, { onStarting })).resolves.toEqual({ success: true });
    expect(onStarting).toHaveBeenCalledWith('MTPLX');
    expect(mocks.ensureMtplx).toHaveBeenCalledWith(provider);
  });

  it('turns a rejected ensure() into a failed-readiness result instead of throwing', async () => {
    const provider = { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' };
    mocks.isOllama.mockReturnValue(true);
    mocks.ensureOllama.mockRejectedValue(new Error('spawn ENOENT'));

    await expect(ensureManagedRuntimeReady(provider)).resolves.toEqual({
      success: false,
      error: 'Ollama is not running and PortOS could not start it: spawn ENOENT',
    });
  });
});

describe('managed-runtime wake ownership (issue #8104)', () => {
  // `bootstrap.js`'s boot-time `ensureRunning` import from `ollamaManager.js`
  // is a different symbol (the daemon's own startup hook, not a per-call
  // readiness gate) and stays allowed — this only guards the three symbols
  // `providerExecutionReadiness.js` wraps into `ensureManagedRuntimeReady`.
  const GUARDED_IMPORTS = [
    { module: './ollamaManager.js', symbol: 'ensureProviderReady' },
    { module: './mtplxServerManager.js', symbol: 'ensureMtplxProviderReady' },
    { module: './slotstreamServerManager.js', symbol: 'ensureSlotstreamProviderReady' },
  ];

  const servicesDir = dirname(fileURLToPath(import.meta.url));

  function listServiceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) return listServiceFiles(full);
      if (!name.endsWith('.js') || name.endsWith('.test.js')) return [];
      return [full];
    });
  }

  it('lets only providerExecutionReadiness.js import the raw per-runtime wake functions', () => {
    const offenders = [];
    for (const file of listServiceFiles(servicesDir)) {
      if (relative(servicesDir, file) === 'providerExecutionReadiness.js') continue;
      const source = readFileSync(file, 'utf8');
      for (const { module, symbol } of GUARDED_IMPORTS) {
        const escapedModule = module.replace(/[.]/g, '\\.');
        const importLine = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"]${escapedModule}['"]`);
        if (importLine.test(source)) {
          offenders.push(`${relative(servicesDir, file)} imports ${symbol} from ${module}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
