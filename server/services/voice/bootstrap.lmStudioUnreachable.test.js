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

const { whichFirst } = await import('../../lib/processEnv.js');
const { execFile } = await import('../../lib/childProcess.js');
const { VOICE_DEFAULTS } = await import('./config.js');
const { ensureToolCapableModel, preloadModel, listLmStudioModels } = await import('./bootstrap.js');

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

// `execFile` is promisified in bootstrap.js. Node's real child_process.execFile
// carries a promisify-custom symbol that resolves to a single `{stdout, stderr}`
// object; mimic that here (rather than the generic multi-arg-callback array
// behavior `util.promisify` falls back to) so the mock matches production shape.
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

it('listLmStudioModels returns [] on a 200 with an empty data array', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
  await expect(listLmStudioModels()).resolves.toEqual([]);
});

it('ensureToolCapableModel invokes no lms get when LM Studio is unreachable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  const result = await ensureToolCapableModel(toolCfg());
  expect(result).toEqual({ skipped: 'lmstudio-unreachable' });
  expect(execFile).not.toHaveBeenCalled();
});

it('preloadModel reports lmstudio-unreachable distinctly from no-models', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  const result = await preloadModel(toolCfg());
  expect(result).toEqual({ skipped: 'lmstudio-unreachable' });
});

it('ensureToolCapableModel aborts the remaining install chain on a connect-class lms get failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  respondWith('Error: Failed to start or connect to local LM Studio API server.');
  const result = await ensureToolCapableModel(toolCfg());
  expect(result).toEqual({ skipped: 'lmstudio-unreachable' });
  expect(execFile).toHaveBeenCalledTimes(1);
});

it('ensureToolCapableModel aborts the chain when the post-install health check loses contact with LM Studio', async () => {
  // The pre-loop snapshot succeeds (reachable, empty); `lms get` itself
  // reports an unrelated model-specific failure (no connect-error text);
  // the post-install re-check then fails to reach the API server at all.
  // The prior `after ?? []` coercion silently treated that as "0 new
  // models" and kept trying the rest of the chain against a dead server.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
    .mockRejectedValueOnce(new Error('ECONNREFUSED'));
  vi.stubGlobal('fetch', fetchMock);
  whichFirst.mockImplementation(async (bin) => (bin === 'lms' ? '/usr/local/bin/lms' : null));
  respondWith('Error: model not found on hub');
  const result = await ensureToolCapableModel(toolCfg());
  expect(result).toEqual({ skipped: 'lmstudio-unreachable' });
  expect(execFile).toHaveBeenCalledTimes(1);
});
