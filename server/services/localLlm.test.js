import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// vi.mock factories are hoisted above the module body, so the mutable holder
// and the mock objects must come from vi.hoisted (which runs first). The
// service captures ENV_PATH = join(PATHS.root, '.env') at import time, so each
// test sets `state.root` to a fresh temp dir and re-imports under resetModules.
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../lib/fileUtils.js', async () => {
  const fsMod = await import('fs');
  return {
    PATHS: state,
    atomicWrite: async (file, data) => fsMod.writeFileSync(file, data),
  };
});

const mocks = vi.hoisted(() => ({
  ollama: {
    getInstalledModels: vi.fn(async () => []),
    pullModel: vi.fn(async (id) => ({ success: true, modelId: id })),
    deleteModel: vi.fn(async (id) => ({ success: true, modelId: id })),
    getStatus: vi.fn(async () => ({ available: true, baseUrl: 'x', version: '1', modelCount: 0, models: [] })),
    startServer: vi.fn(async () => ({ success: true, running: true })),
    stopServer: vi.fn(async () => ({ success: true, running: false })),
    startPersistentService: vi.fn(async () => ({ success: true, running: true, persistent: true })),
    stopPersistentService: vi.fn(async () => ({ success: true, running: false, persistent: false })),
    // No local GGUF found by default → migrate falls back to re-pull.
    resolveLocalModel: vi.fn(async () => null),
    // Echo the requested mode as the real outcome (link mode "succeeds" in tests).
    importModelFromGguf: vi.fn(async ({ name, mode }) => ({ success: true, modelId: name, linked: mode === 'link' }))
  },
  lmstudio: {
    getAvailableModels: vi.fn(async () => []),
    downloadModel: vi.fn(async (id) => ({ success: true, modelId: id })),
    getStatus: vi.fn(async () => ({ available: false, baseUrl: 'y', loadedModels: 0 })),
    resetCache: vi.fn(),
    isAppInstalled: vi.fn(() => false),
    getLastListError: vi.fn(() => null),
    resolveLocalModel: vi.fn(async () => null),
    importModelFromGguf: vi.fn(async ({ lmstudioId, mode }) => ({ success: true, modelId: lmstudioId, linked: mode === 'link' }))
  },
  providers: {
    getProviderById: vi.fn(async () => ({ id: 'ollama', enabled: false })),
    updateProvider: vi.fn(async () => ({}))
  }
}));
vi.mock('./ollamaManager.js', () => mocks.ollama);
vi.mock('./lmStudioManager.js', () => mocks.lmstudio);
vi.mock('./providers.js', () => mocks.providers);

const writeEnv = (content) => fs.writeFileSync(path.join(state.root, '.env'), content);

let svc;
beforeEach(async () => {
  vi.clearAllMocks(); // clears calls, keeps the default impls defined above
  delete process.env.LLM_BACKEND;
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'portos-llm-svc-'));
  vi.resetModules();
  svc = await import('./localLlm.js');
});

describe('localLlm', () => {
  describe('getBackend', () => {
    it('defaults to ollama when .env has no marker', () => {
      expect(svc.getBackend()).toBe('ollama');
    });
    it('reads LLM_BACKEND fresh from .env', () => {
      writeEnv('LLM_BACKEND=lmstudio\nPGMODE=docker\n');
      expect(svc.getBackend()).toBe('lmstudio');
    });
    it('ignores an invalid marker', () => {
      writeEnv('LLM_BACKEND=garbage\n');
      expect(svc.getBackend()).toBe('ollama');
    });
    it('lets a valid process.env override win over an invalid .env marker', () => {
      writeEnv('LLM_BACKEND=garbage\n');
      process.env.LLM_BACKEND = 'lmstudio'; // cleared by beforeEach
      expect(svc.getBackend()).toBe('lmstudio');
    });
    it('prefers a valid .env marker over a process.env override', () => {
      writeEnv('LLM_BACKEND=ollama\n');
      process.env.LLM_BACKEND = 'lmstudio';
      expect(svc.getBackend()).toBe('ollama');
    });
  });

  describe('switchBackend', () => {
    it('writes the marker and enables the paired (disabled) provider', async () => {
      const r = await svc.switchBackend('lmstudio');
      expect(r).toEqual({ success: true, backend: 'lmstudio' });
      expect(svc.getBackend()).toBe('lmstudio');
      expect(mocks.providers.updateProvider).toHaveBeenCalledWith('lmstudio', { enabled: true });
    });
    it('rejects an unknown backend', async () => {
      const r = await svc.switchBackend('nope');
      expect(r.success).toBe(false);
    });
  });

  describe('ensureBackendProvider', () => {
    it('does not re-enable an already-enabled provider', async () => {
      mocks.providers.getProviderById.mockResolvedValueOnce({ id: 'ollama', enabled: true });
      await svc.ensureBackendProvider('ollama');
      expect(mocks.providers.updateProvider).not.toHaveBeenCalled();
    });
  });

  describe('installModel / deleteModel dispatch', () => {
    it('routes Ollama install to pullModel', async () => {
      await svc.installModel('ollama', 'llama3.2');
      expect(mocks.ollama.pullModel).toHaveBeenCalledWith('llama3.2', undefined);
    });
    it('routes Ollama delete to deleteModel', async () => {
      await svc.deleteModel('ollama', 'llama3.2');
      expect(mocks.ollama.deleteModel).toHaveBeenCalledWith('llama3.2');
    });
    it('rejects an unknown backend', async () => {
      expect((await svc.installModel('nope', 'x')).success).toBe(false);
    });
  });

  describe('controlOllamaServer', () => {
    it('starts and stops Ollama through the Ollama manager', async () => {
      expect(await svc.controlOllamaServer('start')).toEqual({ success: true, running: true });
      expect(await svc.controlOllamaServer('stop')).toEqual({ success: true, running: false });
      expect(mocks.ollama.startServer).toHaveBeenCalledTimes(1);
      expect(mocks.ollama.stopServer).toHaveBeenCalledTimes(1);
    });

    it('enables and disables Ollama as a persistent service', async () => {
      expect(await svc.controlOllamaServer('enable')).toEqual({ success: true, running: true, persistent: true });
      expect(await svc.controlOllamaServer('disable')).toEqual({ success: true, running: false, persistent: false });
      expect(mocks.ollama.startPersistentService).toHaveBeenCalledTimes(1);
      expect(mocks.ollama.stopPersistentService).toHaveBeenCalledTimes(1);
    });

    it('rejects unknown Ollama service actions', async () => {
      const r = await svc.controlOllamaServer('restart');
      expect(r.success).toBe(false);
      expect(mocks.ollama.startServer).not.toHaveBeenCalled();
      expect(mocks.ollama.stopServer).not.toHaveBeenCalled();
      expect(mocks.ollama.startPersistentService).not.toHaveBeenCalled();
      expect(mocks.ollama.stopPersistentService).not.toHaveBeenCalled();
    });
  });

  describe('migrateBackend', () => {
    it('moves the OTHER backend\'s known models onto the target WITHOUT changing the default', async () => {
      writeEnv('LLM_BACKEND=lmstudio\n'); // default stays lmstudio throughout
      // Source is always the opposite of the target — here ollama is the target,
      // so lmstudio is the source regardless of which is the default.
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' },
        { id: 'someorg/Totally-Unknown-GGUF' } // best-effort → ollama bare name
      ]);

      const events = [];
      const r = await svc.migrateBackend('ollama', { onProgress: (e) => events.push(e) });

      expect(r.success).toBe(true);
      expect(r.from).toBe('lmstudio');
      expect(r.to).toBe('ollama');
      expect(mocks.ollama.pullModel).toHaveBeenCalledWith('llama3.2', expect.any(Function));
      expect(r.results.find((x) => x.target === 'llama3.2').status).toBe('installed');
      expect(svc.getBackend()).toBe('lmstudio'); // default marker untouched
      expect(mocks.providers.updateProvider).not.toHaveBeenCalled(); // providers untouched
      expect(events.at(-1).event).toBe('complete');
    });

    it('returns success with no results when the source backend has no models', async () => {
      // Target ollama → source lmstudio (empty).
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([]);
      const r = await svc.migrateBackend('ollama');
      expect(r.success).toBe(true);
      expect(r.results).toEqual([]);
      expect(mocks.ollama.pullModel).not.toHaveBeenCalled();
      expect(mocks.ollama.importModelFromGguf).not.toHaveBeenCalled();
    });

    it('skips a model with no known target equivalent (→ LM Studio)', async () => {
      // Target lmstudio → source ollama.
      mocks.ollama.getInstalledModels.mockResolvedValueOnce([
        { id: 'custom-unlisted:latest', name: 'custom-unlisted:latest' }
      ]);

      const r = await svc.migrateBackend('lmstudio');
      expect(r.from).toBe('ollama');
      expect(r.results.find((x) => x.source === 'custom-unlisted:latest').status).toBe('skipped');
      expect(mocks.lmstudio.downloadModel).not.toHaveBeenCalled();
    });

    it('links a local GGUF to the target instead of downloading (default link mode)', async () => {
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce({
        ggufPath: '/models/llama-3.2-3b.gguf', projectorPath: null, isMlx: false, isSharded: false
      });

      const r = await svc.migrateBackend('ollama'); // mode defaults to 'link'
      expect(r.results[0].status).toBe('imported');
      expect(r.results[0].linked).toBe(true);
      expect(mocks.ollama.importModelFromGguf).toHaveBeenCalledWith({ name: 'llama3.2', ggufPath: '/models/llama-3.2-3b.gguf', mode: 'link' });
      expect(mocks.ollama.pullModel).not.toHaveBeenCalled(); // no network download
    });

    it('copies (not links) the local GGUF when mode is "copy"', async () => {
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce({
        ggufPath: '/models/llama-3.2-3b.gguf', projectorPath: null, isMlx: false, isSharded: false
      });

      const r = await svc.migrateBackend('ollama', { mode: 'copy' });
      expect(r.mode).toBe('copy');
      expect(r.results[0].status).toBe('imported');
      expect(r.results[0].linked).toBe(false);
      expect(mocks.ollama.importModelFromGguf).toHaveBeenCalledWith({ name: 'llama3.2', ggufPath: '/models/llama-3.2-3b.gguf', mode: 'copy' });
    });

    it('does not local-import an MLX model — falls back to re-pull', async () => {
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      // MLX dir has no GGUF to link/copy → must re-pull the catalog equivalent.
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce({
        ggufPath: null, projectorPath: null, isMlx: true, isSharded: false
      });

      const r = await svc.migrateBackend('ollama');
      expect(mocks.ollama.importModelFromGguf).not.toHaveBeenCalled();
      expect(mocks.ollama.pullModel).toHaveBeenCalledWith('llama3.2', expect.any(Function));
      expect(r.results[0].status).toBe('installed');
    });

    it('re-pulls when an Ollama-target import would drop a separate projector', async () => {
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce({
        ggufPath: '/m/w.gguf', projectorPath: '/m/mmproj.gguf', isMlx: false, isSharded: false
      });

      const r = await svc.migrateBackend('ollama');
      expect(mocks.ollama.importModelFromGguf).not.toHaveBeenCalled();
      expect(mocks.ollama.pullModel).toHaveBeenCalled();
      expect(r.results[0].status).toBe('installed');
    });

    it('fails (without touching the default or providers) when every provision fails', async () => {
      writeEnv('LLM_BACKEND=lmstudio\n');
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce(null); // no local copy → re-pull
      mocks.ollama.pullModel.mockResolvedValueOnce({ success: false, error: 'Ollama not available' });

      const r = await svc.migrateBackend('ollama');
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/no models could be provisioned/);
      expect(svc.getBackend()).toBe('lmstudio'); // default left unchanged
      expect(mocks.providers.updateProvider).not.toHaveBeenCalled(); // providers untouched
    });
  });

  describe('installBackend', () => {
    it('rejects an unknown backend', async () => {
      expect((await svc.installBackend('nope')).success).toBe(false);
    });

    it('returns a download hint on an unsupported platform (no install attempted)', async () => {
      const orig = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const r = await svc.installBackend('lmstudio');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/lmstudio\.ai/); // surfaces the manual download link
      } finally {
        Object.defineProperty(process, 'platform', orig);
      }
    });
  });
});
