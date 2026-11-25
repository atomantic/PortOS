import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
const mocks = vi.hoisted(() => ({
  exec: vi.fn(), enabled: vi.fn(), supported: vi.fn(), exists: vi.fn(), read: vi.fn(), installLocked: vi.fn(),
  download: vi.fn(), mkdtemp: vi.fn(), remove: vi.fn().mockResolvedValue(), unlink: vi.fn().mockResolvedValue(),
}));
const staging = '/example/data/python/laya-mlx/runtime-test';
const archive = `${staging}/laya-mlx.zip`;
vi.mock('../lib/childProcess.js', () => ({ execFile: Object.assign(() => {}, { [promisify.custom]: mocks.exec }) }));
vi.mock('../lib/pythonSetup.js', () => ({ detectVenvBasePythonSync: () => '/example/python3', installLockedRuntime: mocks.installLocked }));
vi.mock('../lib/downloadPreflight.js', () => ({ streamResumableDownload: mocks.download }));
vi.mock('../lib/platform.js', () => ({ isAppleSilicon: mocks.supported }));
vi.mock('./instanceFeatures.js', () => ({ isInstanceFeatureEnabled: mocks.enabled }));
vi.mock('node:fs', () => ({ existsSync: mocks.exists }));
vi.mock('node:fs/promises', () => ({
  readFile: mocks.read, mkdir: vi.fn().mockResolvedValue(), mkdtemp: mocks.mkdtemp,
  writeFile: vi.fn().mockResolvedValue(), rename: vi.fn().mockResolvedValue(), unlink: mocks.unlink, rm: mocks.remove,
}));
import { layaMlxEvents } from './layaMlxEvents.js';
import { LAYA_MLX } from '../lib/layaMlx.js';
import { getLayaStatus, installLaya, scoreLaya } from './layaMlx.js';
const input = { premise: 'The invoice was paid twice.', instructions: 'Choose a department.', options: ['billing', 'sales'], minMargin: 0.15 };
const output = { answers: { decision: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, sales: 0.1 }, confidence: 0.53 } } };
let stdin;
const notifications = vi.fn();
afterEach(() => layaMlxEvents.removeAllListeners());
beforeEach(() => {
  vi.clearAllMocks();
  layaMlxEvents.on('updated', notifications);
  mocks.enabled.mockResolvedValue(true);
  mocks.supported.mockReturnValue(true);
  mocks.exists.mockReturnValue(true);
  mocks.read.mockResolvedValue(JSON.stringify(LAYA_MLX));
  stdin = { on: vi.fn(), end: vi.fn() };
  mocks.download.mockResolvedValue(undefined);
  mocks.mkdtemp.mockResolvedValue(staging);
  mocks.installLocked.mockReturnValue({ promise: Promise.resolve({ ok: true, code: 0 }), kill: vi.fn() });
  mocks.exec.mockImplementation(() => Object.assign(Promise.resolve({ stdout: JSON.stringify(output) }), { child: { stdin } }));
});
describe('Laya manual experiment workflow', () => {
  it('observes installation without starting Python and rejects unsupported installs', async () => {
    expect(await getLayaStatus()).toMatchObject({ ready: true, supported: true });
    mocks.supported.mockReturnValue(false);
    expect(await installLaya()).toEqual({ ok: false, code: 'laya-unsupported' });
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
  });
  it('gates disabled experiments before spawning and validates requests', async () => {
    mocks.enabled.mockResolvedValue(false);
    expect(await scoreLaya(input)).toMatchObject({ code: 'laya-disabled' });
    expect(await scoreLaya({ ...input, options: ['same', 'same'] })).toMatchObject({ code: 'laya-request-invalid' });
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
  });
  it('scores offline through stdin without leaking credentials or confusing confidence with entailment', async () => {
    vi.stubEnv('GH_TOKEN', 'test-secret');
    const result = await scoreLaya(input);
    expect(result).toMatchObject({ ok: true, choice: 'billing', abstained: false, entropyConfidence: 0.53 });
    const [, args, options] = mocks.exec.mock.calls[0];
    expect(args).not.toContain(input.premise);
    expect(options.env).toMatchObject({ HF_HUB_OFFLINE: '1', PYTHONNOUSERSITE: '1' });
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(stdin.end).toHaveBeenCalledWith(JSON.stringify(input));
    vi.unstubAllEnvs();
  });
  it('rejects malformed probabilities and propagates context rejection without private output', async () => {
    for (const raw of [{ answers: { decision: { ...output.answers.decision, probabilities: { billing: 1.2, sales: -0.2 } } } },
      { answers: { decision: { ...output.answers.decision, choice: 'other' } } }]) {
      mocks.exec.mockImplementationOnce(() => Object.assign(Promise.resolve({ stdout: JSON.stringify(raw) }), { child: { stdin } }));
      expect(await scoreLaya(input)).toMatchObject({ code: 'laya-response-invalid' });
    }
    mocks.exec.mockImplementationOnce(() => Object.assign(Promise.resolve({ stdout: '{"code":"laya-context-too-long"}' }), { child: { stdin } }));
    expect(await scoreLaya(input)).toMatchObject({ code: 'laya-context-too-long' });
  });
  it('abstains on low margins and ties, including when the requested floor is zero', async () => {
    expect(await scoreLaya({ ...input, minMargin: 0.9 })).toMatchObject({ ok: true, abstained: true, choice: null });
    mocks.exec.mockImplementationOnce(() => Object.assign(Promise.resolve({ stdout: JSON.stringify({ answers: { decision: { ...output.answers.decision, probabilities: { billing: 0.5, sales: 0.5 } } } }) }), { child: { stdin } }));
    expect(await scoreLaya({ ...input, minMargin: 0 })).toMatchObject({ ok: true, abstained: true, choice: null });
  });
  it('prevents overlapping model loads and releases the guard after child failure', async () => {
    let reject;
    mocks.exec.mockImplementationOnce(() => Object.assign(new Promise((_, fail) => { reject = fail; }), { child: { stdin } }));
    const first = scoreLaya(input);
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalled());
    expect(await scoreLaya(input)).toMatchObject({ code: 'laya-busy' });
    expect(await installLaya()).toMatchObject({ code: 'laya-busy' });
    reject(new Error('private traceback'));
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(await first).toEqual({ ok: false, code: 'laya-scoring-failed' });
    expect(notifications).toHaveBeenCalledTimes(2);
    expect(await getLayaStatus()).toMatchObject({ scoring: false });
    expect(await scoreLaya(input)).toMatchObject({ ok: true });
  });
});

it('installs only on request, pins runtime and weights, and reports bounded setup failures', async () => {
  expect(await installLaya()).toEqual({ ok: true, installing: true });
  await vi.waitFor(async () => expect((await getLayaStatus()).installing).toBe(false));
  expect(notifications).toHaveBeenLastCalledWith({});
  expect(notifications).toHaveBeenCalledTimes(6);
  expect(LAYA_MLX.runtimeArchiveSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({
    url: `https://codeload.github.com/mizorewww/laya-mlx/zip/${LAYA_MLX.runtimeRevision}`,
    destPath: archive,
    expectedSha256: LAYA_MLX.runtimeArchiveSha256,
  }));
  expect(mocks.installLocked).toHaveBeenCalledWith(expect.stringMatching(/venv\/bin\/python3$/), 'laya-mlx', expect.any(Function), expect.objectContaining({
    preferUv: true,
    sourceInstalls: [['install', '--force-reinstall', '--no-index', '--no-deps', '--no-build-isolation', archive]],
  }));
  expect(mocks.remove).toHaveBeenCalledWith(staging, { recursive: true, force: true });
  expect(mocks.exec.mock.calls.some(([, args]) => args.includes('pip'))).toBe(false);
  expect(mocks.exec.mock.calls.some(([, args]) => args.includes(LAYA_MLX.revision) && args.includes(LAYA_MLX.repository))).toBe(true);
  notifications.mockClear();
  mocks.exec.mockRejectedValueOnce(new Error('private Python diagnostic'));
  await installLaya();
  await vi.waitFor(async () => expect(await getLayaStatus()).toMatchObject({ installing: false, installError: 'laya-install-python-failed' }));
  expect(notifications).toHaveBeenCalledTimes(3);
  expect(notifications).toHaveBeenLastCalledWith({});
});

it('stops before downloading weights when the locked runtime install fails', async () => {
  mocks.installLocked.mockReturnValue({ promise: Promise.resolve({ ok: false, code: 1 }), kill: vi.fn() });
  await installLaya();
  await vi.waitFor(async () => expect(await getLayaStatus()).toMatchObject({ installing: false, installError: 'laya-install-runtime-failed' }));
  expect(mocks.exec.mock.calls.some(([, args]) => args.includes(LAYA_MLX.repository))).toBe(false);
  expect(mocks.remove).toHaveBeenCalledWith(staging, { recursive: true, force: true });
});

it('preserves the existing runtime and skips package installation and weights on a digest mismatch', async () => {
  mocks.download.mockRejectedValueOnce(Object.assign(new Error('SHA-256 mismatch'), { code: 'DOWNLOAD_HASH_MISMATCH' }));
  await installLaya();
  await vi.waitFor(async () => expect(await getLayaStatus()).toMatchObject({ installing: false, installError: 'laya-install-runtime-failed' }));
  expect(mocks.exec).toHaveBeenCalledExactlyOnceWith('/example/python3', ['-c', expect.any(String)], expect.any(Object));
  expect(mocks.unlink).not.toHaveBeenCalled();
  expect(mocks.installLocked).not.toHaveBeenCalled();
  expect(mocks.remove).toHaveBeenCalledWith(staging, { recursive: true, force: true });
});
