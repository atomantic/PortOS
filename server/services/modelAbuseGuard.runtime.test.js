import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MODEL_ABUSE_GUARD_PYTHON_PACKAGES } from '../lib/modelAbuseGuard.js';

const mock = vi.hoisted(() => ({
  spawn: vi.fn(), execFile: vi.fn(), createVenv: vi.fn(), installPackages: vi.fn(),
  downloadHfRepo: vi.fn(), verdict: null,
}));
vi.mock('../lib/childProcess.js', () => ({ spawn: mock.spawn, execFile: mock.execFile }));
vi.mock('node:fs', async (original) => ({ ...await original(), existsSync: () => true }));
vi.mock('../lib/fileUtils.js', async (original) => ({ ...await original(), ensureDir: vi.fn() }));
vi.mock('../lib/pythonSetup.js', () => ({
  detectVenvBasePythonSync: () => '/example/python3', createVenv: mock.createVenv, installPackages: mock.installPackages,
}));
vi.mock('../lib/hfCache.js', () => ({
  findCachedRepoFiles: async () => ['/example/model/config.json'], getHfCacheRoot: () => '/example/cache',
}));
vi.mock('./hfToken.js', () => ({ getHfToken: async () => 'example-read-token' }));
vi.mock('./hfDownload.js', () => ({ downloadHfRepo: mock.downloadHfRepo }));
vi.mock('./localLlm.js', () => ({ listModels: vi.fn() }));
vi.mock('./ollamaManager.js', () => ({ getModelCapabilities: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.verdict = { schemaVersion: 1, complete: true, tokenCount: 4, chunks: [{ index: 0, label: 'BENIGN', score: 0.99, tokenStart: 0, tokenEnd: 4 }] };
  mock.execFile.mockImplementation((...args) => args.at(-1)(null, { stdout: args[1][1].startsWith('import sys;') ? 'supported' : '{"ready":true}', stderr: '' }));
  mock.createVenv.mockResolvedValue('/example/venv/bin/python3');
  mock.installPackages.mockReturnValue({ promise: Promise.resolve({ ok: true }), kill: vi.fn() });
  mock.downloadHfRepo.mockReturnValue({ promise: Promise.resolve({ ok: true }), kill: vi.fn() });
  mock.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = vi.fn();
    child.stdin.end = () => queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify(mock.verdict));
      child.emit('close', 0);
    });
    return child;
  });
});

describe('Prompt Guard runtime lifecycle', () => {
  it('checks status without inference, installation, or network downloads', async () => {
    const { getModelAbuseGuardStatus } = await import('./modelAbuseGuard.js');
    await expect(getModelAbuseGuardStatus()).resolves.toMatchObject({ ready: true, setupState: 'ready', classifierMode: 'required' });
    expect(mock.execFile).toHaveBeenCalledTimes(2);
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.installPackages).not.toHaveBeenCalled();
    expect(mock.downloadHfRepo).not.toHaveBeenCalled();
  });

  it('installs the dedicated versioned packages and verifies the full runner only on request', async () => {
    const { installModelAbuseGuard } = await import('./modelAbuseGuard.js');
    await expect(installModelAbuseGuard()).resolves.toMatchObject({ ok: true, ready: true });
    expect(mock.installPackages).toHaveBeenCalledWith('/example/venv/bin/python3', [...MODEL_ABUSE_GUARD_PYTHON_PACKAGES], expect.any(Function));
    expect(mock.downloadHfRepo).toHaveBeenCalledWith(expect.objectContaining({ revision: expect.stringMatching(/^[a-f0-9]{40}$/), only: expect.not.arrayContaining(['modeling.py']) }));
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it('rejects a successful subprocess that omitted part of the classified input', async () => {
    mock.verdict.tokenCount = 700;
    mock.verdict.chunks[0].tokenEnd = 510;
    const { runModelAbuseScan, buildModelAbuseGuardEnv } = await import('./modelAbuseGuard.js');
    await expect(runModelAbuseScan({ content: 'Fix the empty import dialog.' })).resolves.toMatchObject({ ok: false, passed: false, code: 'security-guard-verdict-invalid' });
    expect(buildModelAbuseGuardEnv({ PATH: '/example/bin', GH_TOKEN: 'secret', API_KEY: 'secret', PYTHONPATH: '/untrusted' })).toMatchObject({ PATH: '/example/bin', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' });
    expect(buildModelAbuseGuardEnv({ GH_TOKEN: 'secret', API_KEY: 'secret', PYTHONPATH: '/untrusted' })).not.toHaveProperty('GH_TOKEN');
    expect(mock.spawn.mock.calls[0][2].cwd).toMatch(/venv-prompt-guard[/\\](?:bin|Scripts)$/);
  });

  it('keeps a failed install self-test blocked during later status and optional scans', async () => {
    mock.verdict.complete = false;
    const { installModelAbuseGuard, getModelAbuseGuardStatus, runModelAbuseScan } = await import('./modelAbuseGuard.js');
    await expect(installModelAbuseGuard()).resolves.toMatchObject({ ok: false, code: 'security-guard-self-test-failed' });
    await expect(getModelAbuseGuardStatus()).resolves.toMatchObject({ ready: false, selfTestFailed: true, setupState: 'incomplete' });
    await expect(runModelAbuseScan({ content: 'A routine issue.', classifierMode: 'optional' })).resolves.toMatchObject({ ok: false, code: 'security-guard-not-ready' });
    expect(mock.spawn).toHaveBeenCalledOnce();
  });
});
