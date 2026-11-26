import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const context = vi.hoisted(() => ({ data: '' }));
vi.mock('../lib/paths.js', async importActual => {
  const actual = await importActual();
  return { ...actual, PATHS: { ...actual.PATHS, get data() { return context.data; } } };
});
vi.mock('./userActions.js', () => ({ recordUserAction: vi.fn() }));
let settings;
let directory;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'private-keys-test-'));
  context.data = directory;
  vi.resetModules();
  settings = await import('./settings.js');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('keeps newly written and legacy settings owner-only', async () => {
  const file = join(directory, 'settings.json');
  await settings.updateSettings({ theme: 'dark' });
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  await chmod(file, 0o644);
  await settings.updateSettings({ notifications: false });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ theme: 'dark', notifications: false });
});

it('moves legacy keys out of settings, preserves unrelated data, and resolves after restart and clear', async () => {
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    imageGen: { hfToken: 'hf_example', mode: 'local' },
    civitai: { apiKey: 'example-civitai' },
    videoGen: { fal: { apiKey: 'example-fal', model: 'example' }, reactor: { apiKey: 'example-reactor' } },
  }));
  await settings.updateSettings({ theme: 'dark' });
  const disk = await readFile(join(directory, 'settings.json'), 'utf8');
  expect(disk).not.toMatch(/hf_example|example-civitai|example-fal|example-reactor/);
  expect(JSON.parse(disk)).toMatchObject({ imageGen: { mode: 'local' }, videoGen: { fal: { model: 'example' } } });
  if (process.platform !== 'win32') {
    expect((await stat(join(directory, 'private'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'private/api-keys.json'))).mode & 0o777).toBe(0o600);
  }
  settings.__resetSettingsCache();
  expect((await settings.getSettings()).videoGen.reactor.apiKey).toBe('example-reactor');
  await settings.updateSettingsWith(current => ({ ...current, civitai: { apiKey: '' } }));
  settings.__resetSettingsCache();
  expect((await settings.getSettings()).civitai.apiKey).toBe('');
  expect((await settings.getSettings()).videoGen.fal.apiKey).toBe('example-fal');
  await settings.updateSettingsWith(current => {
    delete current.imageGen.hfToken;
    return current;
  });
  settings.__resetSettingsCache();
  expect((await settings.getSettings()).imageGen.hfToken).toBe('');
  expect((await settings.getSettings()).videoGen.fal.apiKey).toBe('example-fal');
});

it('boots and saves cleanly with a retired credential key left on disk, leaving it untouched', async () => {
  await mkdir(join(directory, 'private'), { recursive: true });
  await writeFile(join(directory, 'private/api-keys.json'), JSON.stringify({
    schemaVersion: 1,
    keys: { 'artificial-analysis': 'example-retired', civitai: 'example-civitai' },
  }));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    theme: 'dark', secrets: { retiredCatalog: { apiKey: 'example-legacy' } },
  }));
  settings.__resetSettingsCache();
  const loaded = await settings.getSettings();
  expect(loaded.civitai.apiKey).toBe('example-civitai');
  expect(JSON.stringify(loaded)).not.toContain('example-retired');
  await settings.updateSettings({ theme: 'light' });
  const keys = JSON.parse(await readFile(join(directory, 'private/api-keys.json'), 'utf8')).keys;
  expect(keys).toEqual({ 'artificial-analysis': 'example-retired', civitai: 'example-civitai' });
});

it('refuses a corrupt private store without overwriting keys or exposing parser input', async () => {
  await settings.updateSettings({ civitai: { apiKey: 'example-key' } });
  await writeFile(join(directory, 'private/api-keys.json'), 'example-secret-invalid-json');
  settings.__resetSettingsCache();
  await expect(settings.getSettings()).rejects.toThrow('unsupported format');
  await expect(settings.updateSettings({ theme: 'light' })).rejects.toThrow('unsupported format');
  expect(await readFile(join(directory, 'private/api-keys.json'), 'utf8')).toBe('example-secret-invalid-json');
});

it('routes secrets.telegram.token to the private key store and writes a tombstone on clear', async () => {
  await settings.updateSettingsWith(current => ({
    ...current,
    secrets: { ...current.secrets, telegram: { token: 'example-telegram-token' } },
    telegram: { ...current.telegram, chatId: '12345' },
  }));
  const disk = await readFile(join(directory, 'settings.json'), 'utf8');
  expect(disk).not.toContain('example-telegram-token');
  expect(JSON.parse(disk).secrets?.telegram?.token).toBeUndefined();
  expect(JSON.parse(disk).telegram?.chatId).toBe('12345');

  const keys = JSON.parse(await readFile(join(directory, 'private/api-keys.json'), 'utf8')).keys;
  expect(keys.telegram).toBe('example-telegram-token');
  if (process.platform !== 'win32') {
    expect((await stat(join(directory, 'private'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'private/api-keys.json'))).mode & 0o777).toBe(0o600);
  }

  settings.__resetSettingsCache();
  expect((await settings.getSettings()).secrets.telegram.token).toBe('example-telegram-token');

  await settings.updateSettingsWith(current => ({
    ...current,
    telegram: null,
    secrets: { ...current.secrets, telegram: undefined },
  }));
  const clearedKeys = JSON.parse(await readFile(join(directory, 'private/api-keys.json'), 'utf8')).keys;
  expect(clearedKeys.telegram).toBe('');

  // Even if a legacy copy sits in settings.json, the empty tombstone wins on restart.
  const currentDisk = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    ...currentDisk,
    secrets: { ...currentDisk.secrets, telegram: { token: 'example-legacy-token' } },
  }));
  settings.__resetSettingsCache();
  expect((await settings.getSettings()).secrets.telegram.token).toBe('');
});
