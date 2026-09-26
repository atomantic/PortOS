import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './392-voice-llm-pin-lmstudio-default.js';
import retireKokoroTts from './376-retire-kokoro-tts.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 392 — pin the outgoing voice LLM default', () => {
  let rootDir;
  let settingsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-392-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    settingsPath = join(rootDir, 'data/settings.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  // The whole point: voice config is a sparse patch merged over VOICE_DEFAULTS,
  // so an install that configured voice but never touched the provider field
  // would silently switch backends when the default changed.
  it('pins lmstudio for an install that configured voice without naming a provider', async () => {
    writeJson(settingsPath, { voice: { enabled: true, llm: { model: 'auto' } } });
    await migration.up({ rootDir });
    const settings = readJson(settingsPath);
    expect(settings.voice.llm.provider).toBe('lmstudio');
    expect(settings.voice.llm.model).toBe('auto');
    expect(settings.voice.enabled).toBe(true);
  });

  it('pins lmstudio when voice is configured with no llm block at all', async () => {
    writeJson(settingsPath, { voice: { enabled: true } });
    await migration.up({ rootDir });
    expect(readJson(settingsPath).voice.llm.provider).toBe('lmstudio');
  });

  it('leaves an explicitly chosen provider alone', async () => {
    for (const provider of ['ollama', 'lmstudio', 'openai']) {
      writeJson(settingsPath, { voice: { llm: { provider } } });
      await migration.up({ rootDir });
      expect(readJson(settingsPath).voice.llm.provider).toBe(provider);
    }
  });

  // An install with no stored voice config has expressed no preference and is
  // exactly who the NEW default is for — pinning it to the outgoing backend
  // would deny every fresh install the change.
  it('leaves an install that never configured voice on the new default', async () => {
    writeJson(settingsPath, { theme: 'dark' });
    await migration.up({ rootDir });
    expect(readJson(settingsPath).voice).toBeUndefined();
  });

  it('keeps the fresh settings seed on the current voice defaults through migrations 376 and 392', async () => {
    copyFileSync(new URL('../../data.reference/settings.json', import.meta.url), settingsPath);
    await retireKokoroTts.up({ rootDir });
    await migration.up({ rootDir });
    const settings = readJson(settingsPath);
    expect(settings.voice.llm.provider).toBe('ollama');
    expect(settings.voice.tts.engine).toBe('piper');
  });

  it('is a no-op with no settings file', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(existsSync(settingsPath)).toBe(false);
  });

  // Gates on the presence of its INPUT, so a second run finds the field it
  // wrote and changes nothing.
  it('is idempotent across repeated runs', async () => {
    writeJson(settingsPath, { voice: { enabled: true } });
    await migration.up({ rootDir });
    const first = readFileSync(settingsPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(settingsPath, 'utf-8')).toBe(first);
  });
});
