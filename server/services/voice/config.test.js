import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const dataRoot = () => lazyTempDataRoot('portos-voice-config-');
vi.mock('../../lib/fileUtils.js', async (original) => makePathsProxy(await original(), { dataRoot }));
vi.mock('../userActions.js', () => ({ recordUserAction: vi.fn() }));

const { __resetSettingsCache } = await import('../settings.js');
const { VOICE_DEFAULTS, getVoiceConfig, updateVoiceConfig, invalidateVoiceConfigCache } = await import('./config.js');

const settingsFile = () => join(dataRoot(), 'settings.json');
const seedSettings = (settings) => writeFile(settingsFile(), JSON.stringify(settings));
const readPersistedSettings = async () => JSON.parse(await readFile(settingsFile(), 'utf8'));

beforeEach(async () => {
  __resetSettingsCache();
  invalidateVoiceConfigCache();
  await seedSettings({});
});

afterAll(cleanupTempDataRoots);

it('upgrades restored legacy config on reads and old-client saves without losing settings', async () => {
  const legacy = { enabled: true, tts: { engine: 'kokoro', rate: 1.3, kokoro: { voice: 'af_heart' } } };
  await seedSettings({ voice: legacy });
  const cfg = await getVoiceConfig();
  expect(cfg.tts).toMatchObject({ engine: 'piper', retiredEngine: 'kokoro', rate: 1.3, piper: VOICE_DEFAULTS.tts.piper });
  expect(cfg.enabled).toBe(true);
  expect(await readPersistedSettings()).toEqual({ voice: legacy });
  const saved = await updateVoiceConfig({ tts: { engine: 'kokoro' } });
  expect(saved).toEqual(cfg);
  expect(await readPersistedSettings()).toEqual({ voice: saved });
});


describe('voice configuration defaults', () => {
  it('provides a usable Qwen3-TTS voice and model when the engine is selected', () => {
    expect(VOICE_DEFAULTS.tts.qwen3).toEqual({
      modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
      voice: 'warm-narrator',
    });
  });

  it('keeps every shipped voice setting aligned with its code default', async () => {
    const seed = JSON.parse(await readFile(new URL('../../../data.reference/settings.json', import.meta.url), 'utf8'));

    const assertSeedLeavesMatchDefaults = (defaults, values, path = 'voice') => {
      for (const [key, value] of Object.entries(values)) {
        const currentPath = `${path}.${key}`;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          assertSeedLeavesMatchDefaults(defaults?.[key] || {}, value, currentPath);
          continue;
        }
        expect(defaults?.[key], `seed ${currentPath} must match VOICE_DEFAULTS`).toEqual(value);
      }
    };

    assertSeedLeavesMatchDefaults(VOICE_DEFAULTS, seed.voice);
  });
});

it('persists retirement acknowledgement without removing customized TTS settings', async () => {
  const tts = { engine: 'piper', retiredEngine: 'kokoro', rate: 1.3, piper: { voice: 'custom', voicePath: '~/custom.onnx' } };
  await seedSettings({ voice: { enabled: true, tts } });
  const saved = await updateVoiceConfig({ tts: { retiredEngine: null } });
  expect(saved.tts).not.toHaveProperty('retiredEngine');
  expect(saved.tts).toMatchObject({ engine: 'piper', rate: 1.3, piper: tts.piper });
  expect(await readPersistedSettings()).toEqual({ voice: saved });
  expect(await getVoiceConfig()).toBe(saved);
});

it('strips the retired voice.trigger key on read and on save', async () => {
  await seedSettings({ voice: { enabled: true, trigger: 'hotword' } });
  expect(VOICE_DEFAULTS).not.toHaveProperty('trigger');
  expect(await getVoiceConfig()).not.toHaveProperty('trigger');
  invalidateVoiceConfigCache();
  const saved = await updateVoiceConfig({ trigger: 'vad', hotkey: 'F5' });
  expect(saved).not.toHaveProperty('trigger');
  expect(saved.hotkey).toBe('F5');
  expect((await readPersistedSettings()).voice).not.toHaveProperty('trigger');
});

it('preserves overlapping disjoint Voice patches in the committed config', async () => {
  await seedSettings({ theme: 'dark', voice: { hotkey: 'F5' } });
  const original = await getVoiceConfig();
  const [first, second] = await Promise.all([
    updateVoiceConfig({ stt: { engine: 'whisper' } }),
    updateVoiceConfig({ llm: { model: 'example-model' } }),
  ]);

  expect(first).toEqual({ ...original, stt: { ...original.stt, engine: 'whisper' } });
  expect(second).toEqual({ ...first, llm: { ...first.llm, model: 'example-model' } });
  expect(await readPersistedSettings()).toEqual({ theme: 'dark', voice: second });
  expect(await getVoiceConfig()).toBe(second);
  invalidateVoiceConfigCache();
  __resetSettingsCache();
  expect(await getVoiceConfig()).toEqual(second);
});

it('applies overlapping edits to the same Voice key in queue order', async () => {
  const [first, second] = await Promise.all([
    updateVoiceConfig({ llm: { model: 'first-model' } }),
    updateVoiceConfig({ llm: { model: 'second-model' } }),
  ]);

  expect(first.llm.model).toBe('first-model');
  expect(second.llm.model).toBe('second-model');
  expect(await readPersistedSettings()).toEqual({ voice: second });
  expect(await getVoiceConfig()).toBe(second);
});

it('refuses to save Voice config over malformed settings without caching the patch', async () => {
  const previous = await getVoiceConfig();
  const malformed = '{"voice":';
  await writeFile(settingsFile(), malformed);

  await expect(updateVoiceConfig({ hotkey: 'F5' })).rejects.toMatchObject({ code: 'SETTINGS_UNREADABLE' });
  expect(await readFile(settingsFile(), 'utf8')).toBe(malformed);
  expect(await getVoiceConfig()).toBe(previous);
});
