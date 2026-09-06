import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
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
});

it('persists a successful Artificial Analysis key and reuses it without a request key', async () => {
  vi.doMock('./modelComparison.js', () => ({ importModelComparison: vi.fn(async () => ({ observations: [] })) }));
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'example', name: 'Example Model', slug: 'example-model', model_creator: { name: 'Example' }, evaluations: { artificial_analysis_intelligence_index: 40 } }], pagination: { has_more: false } }) }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('ARTIFICIAL_ANALYSIS_API_KEY', 'example-env');
  const { syncArtificialAnalysisCatalog } = await import('./artificialAnalysis.js');
  await syncArtificialAnalysisCatalog({ apiKey: 'example-saved' });
  settings.__resetSettingsCache();
  await syncArtificialAnalysisCatalog();
  expect(fetchMock.mock.calls[1][1].headers['x-api-key']).toBe('example-saved');
  fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
  await expect(syncArtificialAnalysisCatalog({ apiKey: 'example-invalid' })).rejects.toThrow();
  expect((await settings.getSettings()).secrets.artificialAnalysis.apiKey).toBe('example-saved');
});

it('refuses a corrupt private store without overwriting keys or exposing parser input', async () => {
  await settings.updateSettings({ civitai: { apiKey: 'example-key' } });
  await writeFile(join(directory, 'private/api-keys.json'), 'example-secret-invalid-json');
  settings.__resetSettingsCache();
  await expect(settings.getSettings()).rejects.toThrow('unsupported format');
  await expect(settings.updateSettings({ theme: 'light' })).rejects.toThrow('unsupported format');
  expect(await readFile(join(directory, 'private/api-keys.json'), 'utf8')).toBe('example-secret-invalid-json');
});
