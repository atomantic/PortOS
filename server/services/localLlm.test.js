import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// vi.mock factories are hoisted above the module body, so the mutable holder
// and the mock objects must come from vi.hoisted (which runs first). The
// service captures ENV_PATH = join(PATHS.root, '.env') at import time, so each
// test sets `state.root` to a fresh temp dir and re-imports under resetModules.
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../lib/fileUtils.js', () => ({ PATHS: state }));

const mocks = vi.hoisted(() => ({
  ollama: {
    getInstalledModels: vi.fn(async () => []),
    pullModel: vi.fn(async (id) => ({ success: true, modelId: id })),
    deleteModel: vi.fn(async (id) => ({ success: true, modelId: id })),
    getStatus: vi.fn(async () => ({ available: true, baseUrl: 'x', version: '1', modelCount: 0, models: [] })),
    // No local GGUF found by default → migrate falls back to re-pull.
    resolveLocalModel: vi.fn(async () => null),
    importModelFromGguf: vi.fn(async ({ name }) => ({ success: true, modelId: name }))
  },
  lmstudio: {
    getAvailableModels: vi.fn(async () => []),
    downloadModel: vi.fn(async (id) => ({ success: true, modelId: id })),
    getStatus: vi.fn(async () => ({ available: false, baseUrl: 'y', loadedModels: 0 })),
    resetCache: vi.fn(),
    isAppInstalled: vi.fn(() => false),
    getLastListError: vi.fn(() => null),
    resolveLocalModel: vi.fn(async () => null),
    importModelFromGguf: vi.fn(async ({ lmstudioId }) => ({ success: true, modelId: lmstudioId }))
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

  describe('migrateBackend', () => {
    it('re-provisions known source models on the target and flips the marker', async () => {
      writeEnv('LLM_BACKEND=lmstudio\n');
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' },
        { id: 'someorg/Totally-Unknown-GGUF' } // best-effort → ollama bare name
      ]);

      const events = [];
      const r = await svc.migrateBackend('ollama', (e) => events.push(e));

      expect(r.success).toBe(true);
      expect(r.backend).toBe('ollama');
      expect(mocks.ollama.pullModel).toHaveBeenCalledWith('llama3.2', expect.any(Function));
      expect(r.results.find((x) => x.target === 'llama3.2').status).toBe('installed');
      expect(svc.getBackend()).toBe('ollama');
      expect(events.at(-1).event).toBe('complete');
    });

    it('skips a model with no known target equivalent (→ LM Studio)', async () => {
      writeEnv('LLM_BACKEND=ollama\n');
      mocks.ollama.getInstalledModels.mockResolvedValueOnce([
        { id: 'custom-unlisted:latest', name: 'custom-unlisted:latest' }
      ]);

      const r = await svc.migrateBackend('lmstudio');
      expect(r.results.find((x) => x.source === 'custom-unlisted:latest').status).toBe('skipped');
      expect(mocks.lmstudio.downloadModel).not.toHaveBeenCalled();
    });

    it('copies a local GGUF to the target instead of downloading (fast path)', async () => {
      writeEnv('LLM_BACKEND=lmstudio\n');
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce({
        ggufPath: '/models/llama-3.2-3b.gguf', projectorPath: null, isMlx: false, isSharded: false
      });

      const r = await svc.migrateBackend('ollama');
      expect(r.results[0].status).toBe('imported');
      expect(mocks.ollama.importModelFromGguf).toHaveBeenCalledWith({ name: 'llama3.2', ggufPath: '/models/llama-3.2-3b.gguf' });
      expect(mocks.ollama.pullModel).not.toHaveBeenCalled(); // no network download
    });

    it('does not local-copy an MLX model — falls back to re-pull', async () => {
      writeEnv('LLM_BACKEND=lmstudio\n');
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      // MLX dir has no GGUF to copy → must re-pull the catalog equivalent.
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce({
        ggufPath: null, projectorPath: null, isMlx: true, isSharded: false
      });

      const r = await svc.migrateBackend('ollama');
      expect(mocks.ollama.importModelFromGguf).not.toHaveBeenCalled();
      expect(mocks.ollama.pullModel).toHaveBeenCalledWith('llama3.2', expect.any(Function));
      expect(r.results[0].status).toBe('installed');
    });

    it('re-pulls when an Ollama-target import would drop a separate projector', async () => {
      writeEnv('LLM_BACKEND=lmstudio\n');
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

    it('does not flip the marker when every provision fails (target unusable)', async () => {
      writeEnv('LLM_BACKEND=lmstudio\n');
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' }
      ]);
      mocks.lmstudio.resolveLocalModel.mockResolvedValueOnce(null); // no local copy → re-pull
      mocks.ollama.pullModel.mockResolvedValueOnce({ success: false, error: 'Ollama not available' });

      const r = await svc.migrateBackend('ollama');
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/no models could be provisioned/);
      expect(svc.getBackend()).toBe('lmstudio'); // marker left unchanged
      expect(mocks.providers.updateProvider).not.toHaveBeenCalled(); // provider not flipped either
    });

    it('rejects migrating to the already-active backend (no-op)', async () => {
      writeEnv('LLM_BACKEND=ollama\n');
      const r = await svc.migrateBackend('ollama');
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/already the active backend/);
      // No source read, no installs attempted.
      expect(mocks.ollama.getInstalledModels).not.toHaveBeenCalled();
      expect(mocks.lmstudio.getAvailableModels).not.toHaveBeenCalled();
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
