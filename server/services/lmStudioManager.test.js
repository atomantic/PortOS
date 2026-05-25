import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

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
  vi.resetModules();
});

afterEach(() => {
  if (originalModelsDir === undefined) delete process.env.LM_STUDIO_MODELS_DIR;
  else process.env.LM_STUDIO_MODELS_DIR = originalModelsDir;
  if (originalUrl === undefined) delete process.env.LM_STUDIO_URL;
  else process.env.LM_STUDIO_URL = originalUrl;
  fs.rmSync(tempDir, { recursive: true, force: true });
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
