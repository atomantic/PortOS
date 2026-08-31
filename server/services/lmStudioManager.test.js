import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// `lms` drives the tuned load. Stubbed rather than shelled out to: the tests must
// stay hermetic, and a real `lms load` would page a multi-gigabyte GGUF into the
// developer's LM Studio.
const lmsSpawn = vi.fn();
vi.mock('../lib/bufferedSpawn.js', () => ({ bufferedSpawn: (...args) => lmsSpawn(...args) }));
const lmsBinary = { path: '/usr/local/bin/lms' };
vi.mock('../lib/processEnv.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findCommandOnPath: (cmd) => (cmd === 'lms' ? lmsBinary.path : null),
}));

let tempDir;
let originalModelsDir;
let originalUrl;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portos-lms-models-'));
  originalModelsDir = process.env.LM_STUDIO_MODELS_DIR;
  process.env.LM_STUDIO_MODELS_DIR = tempDir;
  // Point LM Studio at a closed port so deleteModel's best-effort
  // availability probe + unload fail fast (ECONNREFUSED) and the tests stay
  // network-free and deterministic regardless of whether LM Studio is running.
  originalUrl = process.env.LM_STUDIO_URL;
  process.env.LM_STUDIO_URL = 'http://127.0.0.1:1';
  lmsSpawn.mockReset().mockResolvedValue({ success: true, code: 0, stdout: '', stderr: '' });
  lmsBinary.path = '/usr/local/bin/lms';
  vi.resetModules();
});

afterEach(() => {
  if (originalModelsDir === undefined) delete process.env.LM_STUDIO_MODELS_DIR;
  else process.env.LM_STUDIO_MODELS_DIR = originalModelsDir;
  if (originalUrl === undefined) delete process.env.LM_STUDIO_URL;
  else process.env.LM_STUDIO_URL = originalUrl;
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const writeFile = (rel, content = 'gguf') => {
  const full = path.join(tempDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};

describe('lmStudioManager local model resolution', () => {
  it('resolves a model when the API id maps directly to the repo folder', async () => {
    const gguf = writeFile('lmstudio-community/gpt-oss-20b-GGUF/gpt-oss-20b-MXFP4.gguf');
    const { resolveLocalModel } = await import('./lmStudioManager.js');

    const resolved = await resolveLocalModel('lmstudio-community/gpt-oss-20b-GGUF');

    expect(resolved).toMatchObject({
      ggufPath: gguf,
      projectorPath: null,
      isMlx: false,
      isSharded: false
    });
  });

  it('falls back to a normalized repo scan when LM Studio reports a different API id', async () => {
    const gguf = writeFile('lmstudio-community/gpt-oss-20b-GGUF/gpt-oss-20b-MXFP4.gguf');
    const { resolveLocalModel } = await import('./lmStudioManager.js');

    const resolved = await resolveLocalModel('openai/gpt-oss-20b');

    expect(resolved).toMatchObject({
      ggufPath: gguf,
      projectorPath: null,
      isMlx: false,
      isSharded: false
    });
  });
});

describe('lmStudioManager stored model inventory', () => {
  it('reports one folder-scoped row for a repo containing multiple quantizations', async () => {
    writeFile('example/model-GGUF/model-Q4_K_M.gguf', 'q4');
    writeFile('example/model-GGUF/model-Q8_0.gguf', 'q8');
    const { listStoredModels } = await import('./lmStudioManager.js');

    const rows = await listStoredModels();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'example/model-GGUF', name: 'model-GGUF' });
    expect(rows[0].size).toBeGreaterThan(0);
  });

  it('re-probes availability when a caller force-refreshes the inventory', async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => ({ data: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { getAvailableModels } = await import('./lmStudioManager.js');

    await getAvailableModels();
    await getAvailableModels(true);

    const availabilityCalls = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/models'));
    expect(availabilityCalls).toHaveLength(2);
  });
});

describe('lmStudioManager residency status', () => {
  it('queries the requested provider endpoint without consulting the global server', async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'example/model', state: 'loaded', max_context_length: 32768 }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLoadedModelsAt } = await import('./lmStudioManager.js');

    await expect(getLoadedModelsAt('http://localhost:12400/v1')).resolves.toEqual({
      models: [expect.objectContaining({ id: 'example/model', state: 'loaded', maxContextLength: 32768 })],
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:12400/api/v0/models',
      expect.any(Object)
    );
  });

  it('keeps a failed loaded-model probe distinct from a trustworthy empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { getLoadedModels, getLastLoadedModelsError } = await import('./lmStudioManager.js');

    await expect(getLoadedModels(true)).resolves.toEqual([]);
    expect(getLastLoadedModelsError()).toMatch(/offline|unavailable/i);
  });

  it('falls back to the LM Studio CLI when the native unload contract returns 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/models/unload')) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({}),
          text: async () => 'Bad Request',
        };
      }
      const data = [{ id: 'example/model', state: 'loaded', type: 'llm' }];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data }),
        text: async () => JSON.stringify({ data }),
      };
    }));
    const { unloadModel } = await import('./lmStudioManager.js');

    await expect(unloadModel('example/model')).resolves.toMatchObject({ success: true });
    expect(lmsSpawn).toHaveBeenCalledWith(
      '/usr/local/bin/lms',
      ['unload', 'example/model'],
      expect.objectContaining({ shell: false }),
    );
  });
});

describe('lmStudioManager deleteModel', () => {
  it('removes the model folder on disk and prunes the empty publisher dir', async () => {
    writeFile('nomic-ai/nomic-embed-text-v1.5-GGUF/model-Q4_K_M.gguf');
    const { deleteModel } = await import('./lmStudioManager.js');

    const result = await deleteModel('nomic-ai/nomic-embed-text-v1.5-GGUF');

    expect(result).toMatchObject({ success: true, modelId: 'nomic-ai/nomic-embed-text-v1.5-GGUF' });
    expect(fs.existsSync(path.join(tempDir, 'nomic-ai', 'nomic-embed-text-v1.5-GGUF'))).toBe(false);
    // Publisher dir had only the one repo, so it's pruned too.
    expect(fs.existsSync(path.join(tempDir, 'nomic-ai'))).toBe(false);
  });

  it('resolves the on-disk folder via the normalized repo scan when given a differing API id', async () => {
    writeFile('lmstudio-community/gpt-oss-20b-GGUF/gpt-oss-20b-MXFP4.gguf');
    const { deleteModel } = await import('./lmStudioManager.js');

    const result = await deleteModel('openai/gpt-oss-20b');

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'lmstudio-community', 'gpt-oss-20b-GGUF'))).toBe(false);
  });

  it('keeps the publisher dir when other repos remain', async () => {
    writeFile('nomic-ai/nomic-embed-text-v1.5-GGUF/model-Q4_K_M.gguf');
    writeFile('nomic-ai/nomic-embed-text-v2-GGUF/model-Q4_K_M.gguf');
    const { deleteModel } = await import('./lmStudioManager.js');

    await deleteModel('nomic-ai/nomic-embed-text-v1.5-GGUF');

    expect(fs.existsSync(path.join(tempDir, 'nomic-ai', 'nomic-embed-text-v1.5-GGUF'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'nomic-ai', 'nomic-embed-text-v2-GGUF'))).toBe(true);
  });

  it('returns success:false when the model is not found on disk', async () => {
    const { deleteModel } = await import('./lmStudioManager.js');

    const result = await deleteModel('nonexistent/model');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('refuses traversal / root ids and deletes nothing', async () => {
    writeFile('nomic-ai/nomic-embed-text-v1.5-GGUF/model-Q4_K_M.gguf');
    const { deleteModel } = await import('./lmStudioManager.js');

    for (const badId of ['.', '/', '..', 'nomic-ai/..', '../../etc']) {
      const result = await deleteModel(badId);
      expect(result.success).toBe(false);
    }
    // The real model and the models root are untouched.
    expect(fs.existsSync(path.join(tempDir, 'nomic-ai', 'nomic-embed-text-v1.5-GGUF'))).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(true);
  });

  it('refuses an ambiguous id that matches multiple variants and deletes neither', async () => {
    // GGUF and MLX variants both normalize to the same repo key (qwen3-4b).
    writeFile('lmstudio-community/qwen3-4b-GGUF/qwen3-4b-Q4_K_M.gguf');
    writeFile('lmstudio-community/qwen3-4b-MLX-4bit/model.safetensors');
    const { deleteModel } = await import('./lmStudioManager.js');

    const result = await deleteModel('qwen/qwen3-4b'); // non-exact id → fuzzy scan

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ambiguous/i);
    expect(fs.existsSync(path.join(tempDir, 'lmstudio-community', 'qwen3-4b-GGUF'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'lmstudio-community', 'qwen3-4b-MLX-4bit'))).toBe(true);
  });

  it('still deletes by exact publisher/repo even when an ambiguous sibling exists', async () => {
    writeFile('lmstudio-community/qwen3-4b-GGUF/qwen3-4b-Q4_K_M.gguf');
    writeFile('lmstudio-community/qwen3-4b-MLX-4bit/model.safetensors');
    const { deleteModel } = await import('./lmStudioManager.js');

    const result = await deleteModel('lmstudio-community/qwen3-4b-GGUF'); // exact match wins

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'lmstudio-community', 'qwen3-4b-GGUF'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'lmstudio-community', 'qwen3-4b-MLX-4bit'))).toBe(true);
  });
});

describe('lmStudioManager evictDownloadedQuant', () => {
  it('removes only the matching GGUF and leaves sibling quants', async () => {
    const keep = writeFile('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q8_K_XL.gguf');
    const drop = writeFile('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf');
    writeFile('unsloth/Qwen3.8-27B-GGUF/mmproj-Qwen3.8-27B-UD-Q4_K_M.gguf');
    const { evictDownloadedQuant } = await import('./lmStudioManager.js');

    const result = await evictDownloadedQuant('unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M');

    expect(result).toMatchObject({ success: true, modelId: 'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M' });
    expect(fs.existsSync(drop)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'unsloth', 'Qwen3.8-27B-GGUF', 'mmproj-Qwen3.8-27B-UD-Q4_K_M.gguf'))).toBe(true);
  });

  it('does not treat UD-Q4_K_M as a Q4_K_M match', async () => {
    const ud = writeFile('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf');
    const plain = writeFile('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf');
    const { evictDownloadedQuant } = await import('./lmStudioManager.js');

    const result = await evictDownloadedQuant('hf.co/unsloth/Qwen3.8-27B-GGUF:Q4_K_M');

    expect(result.success).toBe(true);
    expect(fs.existsSync(plain)).toBe(false);
    expect(fs.existsSync(ud)).toBe(true);
  });

  it('treats a missing quant as a successful no-op so first-time install can share the path', async () => {
    writeFile('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q8_K_XL.gguf');
    const { evictDownloadedQuant } = await import('./lmStudioManager.js');

    const result = await evictDownloadedQuant('unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M');

    expect(result).toMatchObject({ success: true, missing: true });
    expect(fs.existsSync(path.join(tempDir, 'unsloth', 'Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q8_K_XL.gguf'))).toBe(true);
  });

  it('refuses a bare repo id so a force redownload cannot skip existing GGUFs', async () => {
    writeFile('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf');
    writeFile('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q8_K_XL.gguf');
    const { evictDownloadedQuant } = await import('./lmStudioManager.js');

    const result = await evictDownloadedQuant('unsloth/Qwen3.8-27B-GGUF');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/quantization tag/i);
    expect(fs.existsSync(path.join(tempDir, 'unsloth', 'Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q4_K_M.gguf'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'unsloth', 'Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q8_K_XL.gguf'))).toBe(true);
  });

  it('returns missing:true when the repo is not on disk', async () => {
    const { evictDownloadedQuant } = await import('./lmStudioManager.js');
    expect(await evictDownloadedQuant('unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M'))
      .toMatchObject({ success: true, missing: true });
  });
});

// LM Studio picks context length, GPU offload, and parallelism when a model is
// LOADED. No request field moves them and the REST load endpoint takes only a
// model id, so `lms load` is the only transport a tuned measurement has.
describe('lmStudioManager.loadModelWithArgs', () => {
  it('passes the tuning flags to lms load, auto-approving the model picker', async () => {
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    const result = await loadModelWithArgs('publisher/model', ['--context-length', '8192']);

    expect(result).toEqual({ success: true });
    const [binary, args] = lmsSpawn.mock.calls[0];
    expect(binary).toBe('/usr/local/bin/lms');
    expect(args).toEqual(['load', 'publisher/model', '-y', '--context-length', '8192']);
  });

  // Reporting success for a load that never happened would file the reading
  // under a tuning the model was not running.
  it('surfaces the CLI failure line rather than a generic error', async () => {
    lmsSpawn.mockResolvedValue({ success: false, code: 1, stdout: '', stderr: 'Model does not fit at that context length\n' });
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    expect(await loadModelWithArgs('publisher/model', ['--context-length', '1048576']))
      .toEqual({ success: false, error: 'Model does not fit at that context length' });
  });

  it('reports the timeout instead of hanging the measurement', async () => {
    lmsSpawn.mockResolvedValue({ timedOut: true });
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    const result = await loadModelWithArgs('publisher/model', ['--context-length', '8192']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('refuses when the lms CLI is not installed, naming the command that fixes it', async () => {
    lmsBinary.path = null;
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    const result = await loadModelWithArgs('publisher/model', ['--context-length', '8192']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('lms bootstrap');
    expect(lmsSpawn).not.toHaveBeenCalled();
  });

  // The bug: an untuned assessment following a tuned one left the model resident
  // at the previous run's context length, then stored the reading as
  // `tuningKey: ''` — "Backend defaults" describing a load that never happened.
  it('reloads without flags when PortOS loaded the model with some', async () => {
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    await loadModelWithArgs('publisher/model', ['--context-length', '8192']);
    lmsSpawn.mockClear();

    expect(await loadModelWithArgs('publisher/model', [])).toEqual({ success: true });
    const [, args] = lmsSpawn.mock.calls[0];
    expect(args).toEqual(['load', 'publisher/model', '-y']);
  });

  // Reloading a model that is already untuned would cold-load the weights, and
  // the first sample would time the page-in as the model's throughput.
  it('reloads nothing when PortOS never loaded the model with flags', async () => {
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    expect(await loadModelWithArgs('publisher/model', [])).toEqual({ success: true, unchanged: true });
    expect(lmsSpawn).not.toHaveBeenCalled();
  });

  it('reloads nothing for a second clear once the model is back at defaults', async () => {
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    await loadModelWithArgs('publisher/model', ['--context-length', '8192']);
    await loadModelWithArgs('publisher/model', []);
    lmsSpawn.mockClear();

    expect(await loadModelWithArgs('publisher/model', [])).toEqual({ success: true, unchanged: true });
    expect(lmsSpawn).not.toHaveBeenCalled();
  });

  // `lms load` on a resident model returns the EXISTING instance and reports
  // success, so an unload that failed means the model serving before the call is
  // still what is serving — in EITHER direction. Reporting success would file
  // the previous configuration's throughput under the one that was asked for.
  // A reachable LM Studio whose `/api/v0/models` reports `resident` loaded, and
  // whose unload succeeds unless `state.fails`.
  const stubLmStudio = (state) => vi.stubGlobal('fetch', vi.fn(async (url) => {
    const href = String(url);
    if (href.includes('/models/unload')) {
      return state.fails
        ? { ok: false, status: 500, text: async () => 'busy', json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    }
    const data = (state.resident || []).map((id) => ({ id, state: 'loaded', type: 'llm' }));
    return { ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) };
  }));

  // The ordinary state before a FIRST assessment: LM Studio up, model not
  // resident. `unloadModel` reports failure for a model that was never loaded,
  // and reading that as a refusal would fail every first run — and then leave
  // the tuning unrecorded, so the follow-up untuned run no-ops and files a
  // still-tuned model as backend defaults.
  it('loads a model that is not resident without treating the unload as a refusal', async () => {
    stubLmStudio({ resident: [], fails: true });
    const { loadModelWithArgs } = await import('./lmStudioManager.js');

    expect(await loadModelWithArgs('publisher/model', ['--context-length', '8192'])).toEqual({ success: true });
    // The tuning was recorded, so the clear that follows knows to reload.
    lmsSpawn.mockClear();
    expect(await loadModelWithArgs('publisher/model', [])).toEqual({ success: true });
    expect(lmsSpawn).toHaveBeenCalled();
  });

  // `getLoadedModels` returns `[]` for "nothing loaded" AND for "both list
  // endpoints failed". Reading the second as "not resident" skips the unload,
  // and `lms load` then hands back the resident instance while reporting
  // success — the previous configuration's throughput filed under this tuning.
  it('attempts the unload when the loaded-model list could not be trusted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const href = String(url);
      if (href.includes('/models/unload')) {
        return { ok: false, status: 500, text: async () => 'busy', json: async () => ({}) };
      }
      // Reachable enough for the availability probe, but neither list endpoint
      // returns a `data` array — so the list is an error, not an empty result.
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    }));
    const { loadModelWithArgs } = await import('./lmStudioManager.js');

    expect(await loadModelWithArgs('publisher/model', ['--context-length', '8192'])).toMatchObject({ success: false });
    expect(lmsSpawn).not.toHaveBeenCalled();
  });

  it('refuses a tuned load when a RESIDENT model would not unload', async () => {
    stubLmStudio({ resident: ['publisher/model'], fails: true });
    const { loadModelWithArgs } = await import('./lmStudioManager.js');

    expect(await loadModelWithArgs('publisher/model', ['--context-length', '8192'])).toMatchObject({ success: false });
    // Refused BEFORE the load — once `lms load` has run the flags may really be
    // in effect, and the refusal would no longer be the whole story.
    expect(lmsSpawn).not.toHaveBeenCalled();
  });

  it('refuses a clear whose unload failed, keeping the record for a retry', async () => {
    const state = { resident: [], fails: false };
    stubLmStudio(state);
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    await loadModelWithArgs('publisher/model', ['--context-length', '8192']);

    state.resident = ['publisher/model'];
    state.fails = true;
    expect(await loadModelWithArgs('publisher/model', [])).toMatchObject({ success: false });

    // The entry survived, so the next attempt still knows the model is tuned
    // rather than no-opping and recording it as backend defaults.
    state.fails = false;
    lmsSpawn.mockClear();
    expect(await loadModelWithArgs('publisher/model', [])).toEqual({ success: true });
    expect(lmsSpawn).toHaveBeenCalled();
  });

  // A failed tuned load leaves the model at whatever it was, so the flags were
  // never applied and there is nothing for a later untuned run to clear.
  it('does not record flags from a load the CLI refused', async () => {
    lmsSpawn.mockResolvedValue({ success: false, code: 1, stdout: '', stderr: 'Model does not fit\n' });
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    await loadModelWithArgs('publisher/model', ['--context-length', '1048576']);
    lmsSpawn.mockClear();

    expect(await loadModelWithArgs('publisher/model', [])).toEqual({ success: true, unchanged: true });
    expect(lmsSpawn).not.toHaveBeenCalled();
  });

  it('refuses without shelling out when no model was named', async () => {
    const { loadModelWithArgs } = await import('./lmStudioManager.js');
    expect(await loadModelWithArgs('', [])).toEqual({ success: false, error: 'No model was named to load.' });
    expect(lmsSpawn).not.toHaveBeenCalled();
  });
});
