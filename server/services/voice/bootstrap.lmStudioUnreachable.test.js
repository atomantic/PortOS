// Every case here arrived with the LM-Studio-only fix for #7541 and is kept
// verbatim in intent after the provisioning layer became provider-agnostic.
// It now drives the REAL LM Studio provisioner through bootstrap (rather than
// bootstrap's own former `listLmStudioModels`), so it still pins the same
// behaviour end to end: an unreachable local API server must cost one message,
// not one multi-GB `lms get` attempt per entry in the install chain.
//
// The unreachable verdict is now `{ skipped: 'backend-unreachable', backend }`
// — the same state, named for the backend that reported it rather than for
// LM Studio specifically.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn(async () => null) }));
vi.mock('../pm2.js', () => ({ execPm2: vi.fn(async () => ({})), getAppStatus: vi.fn(async () => null) }));
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn(async () => ({})) }));
vi.mock('net', () => ({ createServer: vi.fn(() => ({})) }));
vi.mock('./llm.js', () => ({ isToolCapable: vi.fn(() => false), isReasoningModel: vi.fn(() => false) }));
vi.mock('../providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../ollamaManager.js', () => ({
  getInstalledModels: vi.fn(async () => []),
  getLastInstalledModelsError: vi.fn(() => null),
  getModelCapabilities: vi.fn(async () => null),
  getLoadedModels: vi.fn(async () => []),
  pullModel: vi.fn(),
  ensureRunning: vi.fn(),
  warmModel: vi.fn(),
}));

const { whichFirst } = await import('../../lib/processEnv.js');
const { execFile } = await import('../../lib/childProcess.js');
const { VOICE_DEFAULTS } = await import('./config.js');
const { getVoiceProvisioner } = await import('./modelProvisioners.js');
const { ensureToolCapableModel, preloadModel } = await import('./bootstrap.js');

const listLmStudioModels = () => getVoiceProvisioner('lmstudio').listModels();
const UNREACHABLE = { skipped: 'backend-unreachable', backend: 'lmstudio' };

const toolCfg = () => ({
  ...VOICE_DEFAULTS,
  enabled: true,
  llm: {
    ...VOICE_DEFAULTS.llm,
    provider: 'lmstudio',
    model: 'auto',
    tools: { ...VOICE_DEFAULTS.llm.tools, enabled: true },
  },
});

// `execFile` is promisified in the provisioner. Node's real
// child_process.execFile carries a promisify-custom symbol that resolves to a
// single `{stdout, stderr}` object; mimic that here (rather than the generic
// multi-arg-callback array behavior `util.promisify` falls back to) so the
// mock matches production shape.
const respondWith = (stderr) => execFile.mockImplementation((...args) => {
  const callback = args[args.length - 1];
  callback(null, { stdout: '', stderr });
});

beforeEach(() => {
  vi.clearAllMocks();
  whichFirst.mockImplementation(async () => null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('listLmStudioModels returns null when the API server cannot be reached', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  await expect(listLmStudioModels()).resolves.toBeNull();
});

it('listLmStudioModels returns null when the API server answers non-OK', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
  await expect(listLmStudioModels()).resolves.toBeNull();
});

it('listLmStudioModels returns null on a 200 whose body is not the OpenAI shape', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => '<html>gateway</html>' })));
  await expect(listLmStudioModels()).resolves.toBeNull();
});

it('listLmStudioModels returns [] on a 200 with an empty data array', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
  await expect(listLmStudioModels()).resolves.toEqual([]);
});

it('ensureToolCapableModel invokes no lms get when LM Studio is unreachable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  const result = await ensureToolCapableModel(toolCfg());
  expect(result).toEqual(UNREACHABLE);
  expect(execFile).not.toHaveBeenCalled();
});

it('preloadModel reports an unreachable backend distinctly from no-models', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  const result = await preloadModel(toolCfg());
  expect(result).toEqual(UNREACHABLE);
});

it('ensureToolCapableModel aborts the chain when the post-install health check loses contact', async () => {
  // The pre-loop snapshot succeeds (reachable, empty); `lms get` reports a
  // model-specific failure; the post-install re-check then fails to reach the
  // API server at all. The original `after ?? []` coercion silently treated
  // that as "0 new models" and kept trying the rest of the chain against a
  // dead server — one attempt, then stop, is the contract.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
    .mockRejectedValueOnce(new Error('ECONNREFUSED'));
  vi.stubGlobal('fetch', fetchMock);
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  respondWith('Error: model not found on hub');
  const result = await ensureToolCapableModel(toolCfg());
  expect(result).toEqual(UNREACHABLE);
  expect(execFile).toHaveBeenCalledTimes(1);
});

// The connect-class `lms get` failure that motivated the original fix. The
// provider-agnostic orchestrator detects it through the post-install re-list
// (which returns null for exactly this cause) rather than regex-matching
// LM Studio's wording, so the guard also covers a backend with other phrasing.
it('ensureToolCapableModel aborts on a connect-class lms get failure', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
    .mockRejectedValue(new Error('ECONNREFUSED'));
  vi.stubGlobal('fetch', fetchMock);
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  respondWith('Error: Failed to start or connect to local LM Studio API server.');
  const result = await ensureToolCapableModel(toolCfg());
  expect(result).toEqual(UNREACHABLE);
  expect(execFile).toHaveBeenCalledTimes(1);
});
