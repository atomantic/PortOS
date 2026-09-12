import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './376-retire-kokoro-tts.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('retire Kokoro settings migration', () => {
  it('switches existing installs without losing customized voices, disabled state or unrelated settings; reruns are inert', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kokoro-upgrade-'));
    roots.push(rootDir);
    await mkdir(join(rootDir, 'data'));
    const path = join(rootDir, 'data/settings.json');
    const settings = { theme: 'light', voice: { enabled: false, tts: {
      engine: 'kokoro', rate: 1.4, kokoro: { voice: 'af_heart' },
      piper: { voice: 'custom', voicePath: '~/custom.onnx', speakerId: 7 },
    } } };
    await writeFile(path, JSON.stringify(settings));
    await migration.up({ rootDir });
    const upgraded = JSON.parse(await readFile(path, 'utf8'));
    expect(upgraded).toEqual({ ...settings, voice: { ...settings.voice, tts: {
      ...settings.voice.tts, engine: 'piper', retiredEngine: 'kokoro',
    } } });
    const once = await readFile(path, 'utf8');
    await migration.up({ rootDir });
    expect(await readFile(path, 'utf8')).toBe(once);
  });

  it('leaves other engines untouched and fails on unreadable input so repair can retry', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kokoro-upgrade-'));
    roots.push(rootDir);
    await migration.up({ rootDir });
    await mkdir(join(rootDir, 'data'));
    const path = join(rootDir, 'data/settings.json');
    const raw = JSON.stringify({ voice: { tts: { engine: 'qwen3-tts' } } });
    await writeFile(path, raw);
    await migration.up({ rootDir });
    expect(await readFile(path, 'utf8')).toBe(raw);
    await writeFile(path, '{');
    await expect(migration.up({ rootDir })).rejects.toThrow();
  });
});

it('keeps a fresh settings seed on Piper without an upgrade marker', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'piper-fresh-'));
  roots.push(rootDir);
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/settings.json');
  const seed = await readFile(new URL('../../data.reference/settings.json', import.meta.url), 'utf8');
  await writeFile(path, seed);
  await migration.up({ rootDir });
  const settings = JSON.parse(await readFile(path, 'utf8'));
  expect(settings.voice.tts.engine).toBe('piper');
  expect(settings.voice.tts).not.toHaveProperty('retiredEngine');
});
