import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './473-llama-server-api-provider.js';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2));

describe('473-llama-server-api-provider migration', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'portos-mig-473-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds disabled llama-server API preset to existing installs', async () => {
    writeJson(providersPath, { providers: { ollama: { id: 'ollama', type: 'api' } } });
    await migration.up({ rootDir });
    const out = readJson(providersPath);
    expect(out.providers['llama-server']).toMatchObject({
      id: 'llama-server',
      name: 'llama.cpp (local)',
      type: 'api',
      endpoint: 'http://127.0.0.1:5568/v1',
      llamaBacked: true,
      enabled: false,
      models: [],
    });
  });

  it('preserves an existing llama-server record untouched', async () => {
    const custom = {
      id: 'llama-server',
      name: 'Custom llama.cpp',
      type: 'api',
      endpoint: 'http://127.0.0.1:5568/v1',
      enabled: true,
      models: ['Trelis/gemma-4-31B-it-conversational'],
    };
    writeJson(providersPath, { providers: { 'llama-server': custom } });
    await migration.up({ rootDir });
    expect(readJson(providersPath).providers['llama-server']).toEqual(custom);
  });
});
