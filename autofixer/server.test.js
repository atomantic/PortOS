import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile, rename } from 'fs/promises';

const harness = vi.hoisted(() => ({
  apps: vi.fn(), sweep: vi.fn(), validate: vi.fn(), pm2: vi.fn(), list: vi.fn(), provider: vi.fn(),
}));
vi.mock('./shared.js', () => ({
  DATA_DIR: '/example/data', AUTOFIXER_DIR: '/example/autofixer', INDEX_FILE: '/example/index.json',
  loadApps: harness.apps, execPm2: harness.pm2, listProcessesStrict: harness.list,
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async file => file.endsWith('index.json') ? '[]' : '{}'),
  writeFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}), access: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
}));
vi.mock('../server/lib/agentGuard/index.js', () => ({ agentGuardEnv: () => ({}) }));
vi.mock('../server/lib/cliProviderRun.js', () => ({
  pickCliProvider: () => ({ provider: { id: 'example-cli' } }),
  runCliProviderPrompt: harness.provider,
}));
vi.mock('./sandbox.js', () => ({
  sanitizeChildEnv: () => ({}), collectSecretEnvValues: () => [],
  buildFixPrompt: ({ errorLogs, outputLogs }) => JSON.stringify({ errorLogs, outputLogs }),
  restrictedToolArgs: () => [], isGitRepo: async () => true,
  createDisposableWorktree: async () => ({ path: '/example/worktree' }),
  collectWorktreeDiff: async () => '', removeWorktree: vi.fn(),
  sweepStaleWorktrees: harness.sweep,
  validateProposedDiff: harness.validate,
  applyDiffToLive: vi.fn(), revertDiffFromLive: vi.fn(), runVerifyCommand: vi.fn(),
}));

let errorLog;
let progressLog;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(process, 'on').mockReturnValue(process);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  progressLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  harness.apps.mockReset().mockResolvedValue([{ id: 'example', name: 'Example app', repoPath: '/example/repo', pm2ProcessNames: ['example-process'] }]);
  harness.list.mockReset().mockResolvedValue([{ name: 'example-process', pm2_env: { status: 'errored' } }]);
  harness.validate.mockReset().mockReturnValue({ ok: false, reason: 'No changes', files: [] });
  harness.sweep.mockReset().mockResolvedValue([]);
  harness.pm2.mockReset().mockResolvedValue({ stdout: '' });
  harness.provider.mockReset().mockResolvedValue({ error: 'Example agent stopped', exitCode: 1 });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const start = async () => {
  await import('./server.js');
  await vi.advanceTimersByTimeAsync(0);
};
const nextCycle = () => vi.advanceTimersByTimeAsync(15 * 60 * 1000);

describe('Autofixer daemon repair input boundary', () => {
  it.each(['--err', '--out'])('refuses repair after failed %s collection and recovers next cycle', async stream => {
    harness.pm2.mockImplementation(async args => {
      if (args.includes(stream)) throw new Error('private command output and path');
      return { stdout: '' };
    });
    await start();
    expect(harness.provider).not.toHaveBeenCalled();
    const diagnostic = errorLog.mock.calls.flat().join('\n');
    expect(diagnostic).toContain(`PM2 ${stream === '--err' ? 'stderr' : 'stdout'} logs unavailable for example-process`);
    expect(diagnostic).not.toContain('private command output and path');
    harness.pm2.mockResolvedValue({ stdout: '' });
    await nextCycle();
    expect(harness.provider).toHaveBeenCalledOnce();
    expect(JSON.parse(harness.provider.mock.calls[0][0].prompt)).toEqual({ errorLogs: '', outputLogs: '' });
  });

  it('reports registry failure without a false empty-installation message and retries', async () => {
    harness.apps.mockRejectedValueOnce(Object.assign(new Error('App registry unavailable'), { code: 'APPS_UNAVAILABLE' }));
    await start();
    expect(errorLog.mock.calls.flat().join('\n')).toContain('App registry unavailable');
    expect(progressLog.mock.calls.flat().join('\n')).not.toContain('No apps registered');
    expect(harness.pm2).not.toHaveBeenCalled();
    expect(harness.provider).not.toHaveBeenCalled();
    await nextCycle();
    expect(harness.provider).toHaveBeenCalledOnce();
  });

  it('treats a successfully empty registry as an empty installation', async () => {
    harness.apps.mockResolvedValue([]);
    await start();
    expect(progressLog.mock.calls.flat().join('\n')).toContain('No apps registered');
    expect(errorLog).not.toHaveBeenCalled();
    expect(harness.list).not.toHaveBeenCalled();
    expect(harness.provider).not.toHaveBeenCalled();
  });

  it('records an interrupted session for each worktree swept at startup', async () => {
    harness.apps.mockResolvedValue([]);
    harness.sweep.mockResolvedValue(['autofixer_example-process_1700000000000_abc123']);
    await start();
    const meta = writeFile.mock.calls.find(([f]) => String(f).endsWith('metadata.json'));
    expect(JSON.parse(meta[1])).toMatchObject({ processName: 'example-process', interrupted: true, success: false });
  });

  it('writes the history index via temp file + rename', async () => {
    await start();
    const tmpWrite = writeFile.mock.calls.findIndex(([f]) => f === '/example/index.json.tmp');
    expect(tmpWrite).toBeGreaterThanOrEqual(0);
    expect(rename).toHaveBeenCalledWith('/example/index.json.tmp', '/example/index.json');
  });

  it('still cools the process down when persisting the session fails', async () => {
    harness.provider.mockResolvedValue({ exitCode: 0 });
    harness.validate.mockReturnValue({ ok: true, files: ['a.js'] });
    writeFile.mockImplementation(async (f) => { if (String(f).endsWith('prompt.txt')) throw new Error('disk full'); });
    await start();
    await nextCycle();
    expect(harness.provider).toHaveBeenCalledOnce();
  });
});
