import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

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
    getModelCapabilities: vi.fn(async () => []),
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
    getAllProviders: vi.fn(async () => ({ providers: [] })),
    updateProvider: vi.fn(async () => ({})),
    refreshProviderModels: vi.fn(async (id) => ({ id, models: [] })),
    // Mirrors the real aiToolkit/providers.js predicate (not a spy — tests
    // assert against refreshProviderModels calls, not this classification).
    isOllamaBackedProvider: (provider) => {
      if (provider?.id === 'ollama') return true;
      if (provider?.ollamaBacked === true) return true;
      const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || '');
      return /:11434\b/.test(base) || /ollama/i.test(base);
    }
  }
}));
vi.mock('./ollamaManager.js', () => mocks.ollama);
vi.mock('./lmStudioManager.js', () => mocks.lmstudio);
vi.mock('./providers.js', () => mocks.providers);

// child_process is mocked so the install/upgrade paths (spawn-based streaming +
// execFile-based presence checks) are drivable. Defaults are benign for the rest
// of the suite: spawn closes clean, execFile rejects (→ commandExists() false).
const cp = vi.hoisted(() => ({
  defaults: {
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 0));
      return child;
    },
    execFile: (_cmd, _args, _opts, cb) => cb(new Error('ENOENT')),
  },
  spawn: null,
  execFile: null,
}));
vi.mock('child_process', () => ({
  spawn: (...a) => cp.spawn(...a),
  execFile: (cmd, args, opts, cb) => cp.execFile(cmd, args, opts, cb),
}));

// Build a fake `brew` child that streams `lines`, then closes with `code`.
const fakeChild = ({ code = 0, lines = [] } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    for (const l of lines) child.stdout.emit('data', Buffer.from(`${l}\n`));
    child.emit('close', code);
  });
  return child;
};

const writeEnv = (content) => fs.writeFileSync(path.join(state.root, '.env'), content);

// A `setTimeout` macrotask always fires after every microtask queued before
// it — including chained promise `.then()`s a fire-and-forget call kicked off
// — so this reliably waits out an unwaited async chain in tests.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

let svc;
beforeEach(async () => {
  vi.clearAllMocks(); // clears calls, keeps the default impls defined above
  cp.spawn = cp.defaults.spawn; // reset child_process drivers to benign defaults
  cp.execFile = cp.defaults.execFile;
  delete process.env.LLM_BACKEND;
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'portos-llm-svc-'));
  vi.resetModules();
  svc = await import('./localLlm.js');
});

afterEach(() => {
  if (state.root) {
    fs.rmSync(state.root, { recursive: true, force: true });
    state.root = '';
  }
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
    it('does not touch a provider already enabled with a context window set', async () => {
      mocks.providers.getProviderById.mockResolvedValueOnce({ id: 'ollama', enabled: true, numCtx: 32768 });
      await svc.ensureBackendProvider('ollama');
      expect(mocks.providers.updateProvider).not.toHaveBeenCalled();
    });
    it('defaults a context window on an enabled Ollama provider that lacks one', async () => {
      mocks.providers.getProviderById.mockResolvedValueOnce({ id: 'ollama', enabled: true });
      await svc.ensureBackendProvider('ollama');
      expect(mocks.providers.updateProvider).toHaveBeenCalledWith('ollama', { numCtx: 32768 });
    });
    it('enables and sets a context window for a disabled Ollama provider', async () => {
      mocks.providers.getProviderById.mockResolvedValueOnce({ id: 'ollama', enabled: false });
      await svc.ensureBackendProvider('ollama');
      expect(mocks.providers.updateProvider).toHaveBeenCalledWith('ollama', { enabled: true, numCtx: 32768 });
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
    it('refreshes Ollama-backed providers after a successful install', async () => {
      mocks.providers.getAllProviders.mockResolvedValueOnce({
        providers: [
          { id: 'ollama' },
          { id: 'claude-ollama', type: 'tui', ollamaBacked: true },
          { id: 'anthropic', type: 'api', endpoint: 'https://api.anthropic.com' }
        ]
      });
      const result = await svc.installModel('ollama', 'llama3.2');
      expect(result.success).toBe(true);
      // The refresh is fire-and-forget (doesn't block the install response) —
      // flush the microtask queue so the async chain it kicks off has settled.
      await flushMicrotasks();
      expect(mocks.providers.refreshProviderModels).toHaveBeenCalledWith('ollama');
      expect(mocks.providers.refreshProviderModels).toHaveBeenCalledWith('claude-ollama');
      expect(mocks.providers.refreshProviderModels).not.toHaveBeenCalledWith('anthropic');
    });
    it('refreshes Ollama-backed providers after a successful delete', async () => {
      mocks.providers.getAllProviders.mockResolvedValueOnce({ providers: [{ id: 'ollama' }] });
      await svc.deleteModel('ollama', 'llama3.2');
      await flushMicrotasks();
      expect(mocks.providers.refreshProviderModels).toHaveBeenCalledWith('ollama');
    });
    it('does not refresh providers when the Ollama pull fails', async () => {
      mocks.ollama.pullModel.mockResolvedValueOnce({ success: false, error: 'boom' });
      mocks.providers.getAllProviders.mockResolvedValueOnce({ providers: [{ id: 'ollama' }] });
      await svc.installModel('ollama', 'llama3.2');
      await flushMicrotasks();
      expect(mocks.providers.refreshProviderModels).not.toHaveBeenCalled();
    });
    it('does not fail install when a provider refresh throws', async () => {
      mocks.providers.getAllProviders.mockResolvedValueOnce({ providers: [{ id: 'ollama' }] });
      mocks.providers.refreshProviderModels.mockRejectedValueOnce(new Error('unreachable'));
      const result = await svc.installModel('ollama', 'llama3.2');
      expect(result.success).toBe(true);
      await flushMicrotasks(); // let the rejection be caught internally, not surface as unhandled
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

    it('treats a non-zero `brew install` exit as success when the package is actually on disk', async () => {
      // Repro of the real Ollama install failure: `brew install ollama` poured
      // the formula but exited 1 (mlx dep + cleanup/env-hint noise), so PortOS
      // wrongly reported failure for a successful install.
      const orig = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      cp.spawn = () => fakeChild({ code: 1, lines: ['Pouring ollama…', '🍺 ollama installed', 'brew cleanup hint'] });
      // `brew --version` (gate) and `brew list --versions ollama` (presence) succeed.
      cp.execFile = (_cmd, _args, _opts, cb) => cb(null, { stdout: 'ollama 0.30.10', stderr: '' });
      try {
        const r = await svc.installBackend('ollama');
        expect(r.success).toBe(true);
        expect(r.backend).toBe('ollama');
      } finally {
        Object.defineProperty(process, 'platform', orig);
      }
    });

    it('still reports failure when `brew install` exits non-zero AND the package is absent', async () => {
      const orig = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      cp.spawn = () => fakeChild({ code: 1, lines: ['Error: download failed'] });
      // brew --version succeeds (gate passes); brew list rejects (not installed).
      cp.execFile = (_cmd, args, _opts, cb) =>
        args.includes('--version') ? cb(null, { stdout: 'Homebrew 4', stderr: '' }) : cb(new Error('not installed'));
      try {
        const r = await svc.installBackend('ollama');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Homebrew install failed/);
      } finally {
        Object.defineProperty(process, 'platform', orig);
      }
    });
  });

  describe('listModels capability badges', () => {
    it('maps Ollama /api/show capabilities onto the catalog badge vocabulary', async () => {
      mocks.ollama.getInstalledModels.mockResolvedValueOnce([
        { id: 'qwen3.6:35b', name: 'qwen3.6:35b', capabilities: ['completion', 'tools', 'vision', 'thinking'] },
        { id: 'nomic-embed-text', name: 'nomic-embed-text', capabilities: ['embedding'] },
        { id: 'legacy-model', name: 'legacy-model' },
      ]);
      const models = await svc.listModels('ollama');
      expect(models.find((m) => m.id === 'qwen3.6:35b').capabilities.sort())
        .toEqual(['chat', 'reasoning', 'tools', 'vision']);
      expect(models.find((m) => m.id === 'nomic-embed-text').capabilities).toEqual(['embeddings']);
      // No reported capabilities → no guessed badges (unlike the vision id heuristic).
      expect(models.find((m) => m.id === 'legacy-model').capabilities).toEqual([]);
    });

    it('derives LM Studio badges from the native `type` field plus the shared tool-use id heuristic', async () => {
      mocks.lmstudio.getAvailableModels.mockResolvedValueOnce([
        { id: 'qwen2.5-7b-instruct', type: 'llm' },
        { id: 'llava-1.5-7b', type: 'vlm' },
        { id: 'nomic-embed-text', type: 'embeddings' },
      ]);
      const models = await svc.listModels('lmstudio');
      expect(models.find((m) => m.id === 'qwen2.5-7b-instruct').capabilities.sort())
        .toEqual(['chat', 'tools']);
      expect(models.find((m) => m.id === 'llava-1.5-7b').capabilities.sort())
        .toEqual(['chat', 'vision']);
      expect(models.find((m) => m.id === 'nomic-embed-text').capabilities).toEqual(['embeddings']);
    });
  });

  describe('listVisionModels', () => {
    it('detects a vision-capable Ollama model whose id lacks a vl/vision token via /api/show capabilities', async () => {
      mocks.ollama.getInstalledModels.mockResolvedValueOnce([
        { id: 'qwen3.6:35b', name: 'qwen3.6:35b', family: 'qwen35moe' },
        { id: 'gemma4:31b', name: 'gemma4:31b', family: 'gemma4' },
      ]);
      mocks.ollama.getModelCapabilities.mockImplementation(async (id) =>
        id === 'qwen3.6:35b' ? ['completion', 'vision', 'tools'] : ['completion']);

      const models = await svc.listVisionModels();
      expect(models).toEqual([
        { providerId: 'ollama', backend: 'ollama', id: 'qwen3.6:35b', name: 'qwen3.6:35b', vision: true },
      ]);
      // The text-only gemma was excluded even though /api/show was consulted.
      expect(mocks.ollama.getModelCapabilities).toHaveBeenCalledWith('gemma4:31b');
    });

    it('skips the /api/show round-trip when the id already matches the vision heuristic', async () => {
      mocks.ollama.getInstalledModels.mockResolvedValueOnce([
        { id: 'qwen2.5-vl:7b', name: 'qwen2.5-vl:7b', family: 'qwen2vl' },
      ]);

      const models = await svc.listVisionModels();
      expect(models.map((m) => m.id)).toEqual(['qwen2.5-vl:7b']);
      expect(mocks.ollama.getModelCapabilities).not.toHaveBeenCalled();
    });

    it('appends vision-capable CLI providers (codex / claude), one entry per model', async () => {
      mocks.providers.getAllProviders.mockResolvedValueOnce({
        providers: [
          { id: 'codex', type: 'cli', command: 'codex', enabled: true, models: ['gpt-5'], defaultModel: 'gpt-5' },
          { id: 'claude-code', type: 'cli', command: 'claude', enabled: true, name: 'Claude Code', models: ['claude-opus-4-8', 'claude-sonnet-4-6'] },
          { id: 'antigravity-cli', type: 'cli', command: 'agy', enabled: true, models: ['x'] }, // not vision-capable → excluded
          { id: 'lmstudio', type: 'api', enabled: true, models: [] }, // api handled elsewhere → excluded here
          { id: 'codex-off', type: 'cli', command: 'codex', enabled: false, models: ['gpt-5'] }, // disabled → excluded
        ],
      });

      const models = await svc.listVisionModels();
      const cli = models.filter((m) => m.backend === 'cli');
      expect(cli).toEqual([
        { providerId: 'codex', backend: 'cli', id: 'gpt-5', name: 'codex / gpt-5', vision: true },
        { providerId: 'claude-code', backend: 'cli', id: 'claude-opus-4-8', name: 'Claude Code / claude-opus-4-8', vision: true },
        { providerId: 'claude-code', backend: 'cli', id: 'claude-sonnet-4-6', name: 'Claude Code / claude-sonnet-4-6', vision: true },
      ]);
    });
  });

  describe('getLatestOllamaVersion', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('fetches the latest release, strips the leading v, and caches it', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: 'v0.5.7' }) }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await svc.getLatestOllamaVersion()).toBe('0.5.7');
      // Second call within the TTL reuses the cache — no extra network hit.
      expect(await svc.getLatestOllamaVersion()).toBe('0.5.7');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns null on a failed lookup and backs off instead of refetching every call', async () => {
      const fetchMock = vi.fn(async () => { throw new Error('network down'); });
      vi.stubGlobal('fetch', fetchMock);
      expect(await svc.getLatestOllamaVersion()).toBeNull();
      expect(await svc.getLatestOllamaVersion()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStatus update detection', () => {
    afterEach(() => vi.unstubAllGlobals());

    const stubLatest = (tag) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: tag }) })));

    it('flags updateAvailable when the latest release is newer than the running version', async () => {
      mocks.ollama.getStatus.mockResolvedValueOnce({ available: true, baseUrl: 'x', version: '0.5.4', modelCount: 0, models: [] });
      stubLatest('v0.5.7');
      const s = await svc.getStatus();
      expect(s.ollama.version).toBe('0.5.4');
      expect(s.ollama.latestVersion).toBe('0.5.7');
      expect(s.ollama.updateAvailable).toBe(true);
    });

    it('does not flag an update when already on the latest version', async () => {
      mocks.ollama.getStatus.mockResolvedValueOnce({ available: true, baseUrl: 'x', version: '0.5.7', modelCount: 0, models: [] });
      stubLatest('v0.5.7');
      const s = await svc.getStatus();
      expect(s.ollama.updateAvailable).toBe(false);
    });

    it('cannot flag an update when Ollama is stopped (no running version to compare)', async () => {
      mocks.ollama.getStatus.mockResolvedValueOnce({ available: false, baseUrl: 'x', version: null, modelCount: 0, models: [] });
      stubLatest('v0.5.7');
      const s = await svc.getStatus();
      expect(s.ollama.latestVersion).toBe('0.5.7');
      expect(s.ollama.updateAvailable).toBe(false);
    });

    it('does not flag an update when GitHub is unreachable (latest unknown)', async () => {
      mocks.ollama.getStatus.mockResolvedValueOnce({ available: true, baseUrl: 'x', version: '0.5.4', modelCount: 0, models: [] });
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      const s = await svc.getStatus();
      expect(s.ollama.latestVersion).toBeNull();
      expect(s.ollama.updateAvailable).toBe(false);
    });
  });
});
