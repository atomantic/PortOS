import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, writeFile, rename, readdir, rm } from 'node:fs/promises';

const harness = vi.hoisted(() => ({
  apps: vi.fn(), sweep: vi.fn(), index: null, metadataExists: false, validate: vi.fn(), pm2: vi.fn(), list: vi.fn(), provider: vi.fn(),
  settings: {}, isGit: vi.fn(), startUi: vi.fn(), verify: vi.fn(), apply: vi.fn(), sessionMetadata: {},
  diff: '',
}));
vi.mock('./ui.js', () => ({ startAutofixerUi: harness.startUi }));
vi.mock('./shared.js', () => ({
  DATA_DIR: '/example/data', AUTOFIXER_DIR: '/example/autofixer', INDEX_FILE: '/example/index.json',
  loadApps: harness.apps, execPm2: harness.pm2, listProcessesStrict: harness.list,
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async file => {
    if (file.endsWith('index.json')) return harness.index ?? '[]';
    if (file.endsWith('settings.json')) return JSON.stringify(harness.settings);
    if (file.endsWith('metadata.json')) return JSON.stringify(harness.sessionMetadata[file] ?? {});
    return '{}';
  }),
  writeFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}),
  chmod: vi.fn(async () => {}),
  // Session metadata exists only when a test marks it recorded (shutdown ran first).
  access: vi.fn(async file => { if (String(file).endsWith('metadata.json') && !harness.metadataExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
  rename: vi.fn(async () => {}),
  lstat: vi.fn(async () => ({ isDirectory: () => true })),
  readdir: vi.fn(),
  rm: vi.fn(async () => {}),
}));
vi.mock('../server/lib/agentGuard/index.js', () => ({ agentGuardEnv: () => ({}) }));
vi.mock('../server/lib/cliProviderRun.js', async importOriginal => ({
  ...await importOriginal(),
  runCliProviderPrompt: harness.provider,
}));
vi.mock('./sandbox.js', async importOriginal => ({
  buildFixPrompt: (await importOriginal()).buildFixPrompt,
  sanitizeChildEnv: () => ({}), collectSecretEnvValues: () => [],
  pickRepairProvider: () => ({ provider: { id: 'example-cli' }, mode: 'claude-disallowed-tools' }), isGitRepo: (...args) => harness.isGit(...args),
  repairWorkspaceHold: async () => null,
  createDisposableWorktree: async () => ({ path: '/example/worktree' }),
  collectWorktreeDiff: async () => harness.diff, removeWorktree: vi.fn(),
  sweepStaleWorktrees: harness.sweep,
  validateProposedDiff: harness.validate,
  applyDiffToLive: harness.apply, revertDiffFromLive: vi.fn(), runVerifyCommand: harness.verify,
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
  harness.settings = {};
  harness.isGit.mockReset().mockResolvedValue(true);
  harness.diff = '';
  harness.startUi.mockReset().mockResolvedValue(vi.fn());
  harness.index = null;
  harness.metadataExists = false;
  harness.sessionMetadata = {};
  readdir.mockReset().mockResolvedValue([]);
  writeFile.mockReset().mockResolvedValue(undefined);
  rename.mockReset().mockResolvedValue(undefined);
  rm.mockClear();
  harness.verify.mockReset();
  harness.apply.mockReset();
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
const indexFile = '/example/index.json';
const sessionsDir = '/example/autofixer/sessions';
const directory = name => ({ name, isDirectory: () => true });

describe('Autofixer daemon repair input boundary', () => {
  it('starts the dashboard with the shared staged-fix store before scanning PM2', async () => {
    await start();
    expect(harness.startUi).toHaveBeenCalledWith(expect.objectContaining({
      mutate: expect.any(Function), serialize: expect.any(Function),
    }));
    expect(harness.startUi.mock.invocationCallOrder[0]).toBeLessThan(harness.list.mock.invocationCallOrder[0]);
  });

  it('keeps scanning and retries the dashboard after a listener failure', async () => {
    harness.startUi.mockRejectedValueOnce(Object.assign(new Error('Example port in use'), { code: 'EADDRINUSE' }));
    await start();
    expect(errorLog.mock.calls.flat().join('\n')).toContain('Dashboard startup failed');
    expect(harness.list).toHaveBeenCalledOnce();
    await nextCycle();
    expect(harness.startUi).toHaveBeenCalledTimes(2);
    expect(harness.list).toHaveBeenCalledTimes(2);
  });

  it('refuses a non-git checkout without logging the host repoPath', async () => {
    harness.isGit.mockResolvedValue(false);
    await start();
    const logged = [...errorLog.mock.calls, ...progressLog.mock.calls].flat().join('\n');
    expect(logged).toContain('app checkout is not a git repository');
    expect(logged).not.toContain('/example/repo');
  });

  it('never tries to repair the combined watchdog itself', async () => {
    harness.apps.mockResolvedValue([{ pm2ProcessNames: ['portos-autofixer'] }]);
    harness.list.mockResolvedValue([{ name: 'portos-autofixer', pm2_env: { status: 'errored' } }]);
    await start();
    expect(harness.provider).not.toHaveBeenCalled();
  });

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
    const { prompt } = harness.provider.mock.calls[0][0];
    expect(prompt).toContain('(no error logs available)');
    expect(prompt).toContain('(no output logs available)');
  });

  it('sends and stores scrubbed crash evidence and keeps repair artifacts private', async () => {
    const err = 'crash at file:///Users/example-user/app.js:8 with Bearer fake-token-only-for-tests';
    const out = 'connected to example-machine.tailnet.ts.net for example@example.com at 202-555-0147';
    const transcriptToken = 'ghp_fakeTokenForAutofixerTestsOnly';
    harness.pm2.mockImplementation(async args => ({ stdout: args.includes('--err') ? err : out }));
    harness.diff = 'example validated patch';
    harness.validate.mockReturnValue({ ok: true, files: ['example.js'] });
    harness.provider.mockImplementation(async ({ onData }) => {
      onData(`transcript ${transcriptToken}`, 'stdout');
      return { exitCode: 0, partial: false };
    });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    harness.index = JSON.stringify([{ sessionId: 'legacy', promptPreview: 'old preview' }]);

    await start();

    expect(harness.provider).toHaveBeenCalledOnce();
    const { prompt } = harness.provider.mock.calls[0][0];
    expect(prompt).toContain('crash at file:///Users/<user>/app.js:8 with [REDACTED]');
    expect(prompt).toContain('connected to <host> for <email> at <phone>');
    for (const original of ['example-user', 'fake-token-only-for-tests', 'example-machine', 'example@example.com', '202-555-0147']) {
      expect(prompt).not.toContain(original);
    }
    const artifact = (name) => writeFile.mock.calls.find(([path]) => path.endsWith(`/${name}`));
    expect(artifact('prompt.txt')[1]).toBe(prompt);
    expect(artifact('output.txt')[1]).toBe('transcript [REDACTED]');
    expect(artifact('fix.patch')[1]).toBe(harness.diff);
    const rows = JSON.parse(artifact('index.json.tmp')[1]);
    expect(rows).toEqual([expect.objectContaining({ staged: true, outputSize: 'transcript [REDACTED]'.length }), { sessionId: 'legacy' }]);
    expect(rows[0]).not.toHaveProperty('promptPreview');
    for (const name of ['prompt.txt', 'output.txt', 'fix.patch', 'metadata.json.tmp', 'index.json.tmp']) {
      const [path, , options] = artifact(name);
      expect(options.mode).toBe(0o600);
      expect(chmod).toHaveBeenCalledWith(path, 0o600);
      const chmodCalls = chmod.mock.calls.flatMap((args, i) =>
        args[0] === path ? [chmod.mock.invocationCallOrder[i]] : []);
      const writeCall = writeFile.mock.invocationCallOrder[writeFile.mock.calls.indexOf(artifact(name))];
      expect(chmodCalls[0]).toBeLessThan(writeCall);
      if (name.endsWith('.tmp')) {
        const renameCall = rename.mock.calls.findIndex(([source]) => source === path);
        expect(chmodCalls.at(-1)).toBeLessThan(rename.mock.invocationCallOrder[renameCall]);
      }
    }
    const sessions = '/example/autofixer/sessions';
    expect(mkdir).toHaveBeenCalledWith(sessions, { recursive: true, mode: 0o700 });
    expect(mkdir).toHaveBeenCalledWith(`${sessions}/${rows[0].sessionId}`, { recursive: true, mode: 0o700 });
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
    const meta = writeFile.mock.calls.find(([f]) => String(f).endsWith('metadata.json.tmp'));
    expect(JSON.parse(meta[1])).toMatchObject({ processName: 'example-process', interrupted: true, success: false });
  });

  it('keeps the shutdown record when the boot sweep finds the same worktree', async () => {
    const sessionId = 'autofixer_example-process_1700000000000_abc123';
    harness.apps.mockResolvedValue([]);
    harness.sweep.mockResolvedValue([sessionId]);
    harness.metadataExists = true;
    await start();
    const sessionWrites = writeFile.mock.calls.filter(([f]) => String(f).includes(sessionId));
    expect(sessionWrites).toEqual([]);
  });

  it('records a crashed repair once and leaves a single history row for its session', async () => {
    const sessionId = 'autofixer_example-process_1700000000000_abc123';
    harness.apps.mockResolvedValue([]);
    harness.sweep.mockResolvedValue([sessionId]);
    harness.index = JSON.stringify([{ sessionId, startTime: '2023-11-14T22:13:20.000Z' }]);
    await start();
    const tmpWrite = writeFile.mock.calls.find(([f]) => f === '/example/index.json.tmp');
    const rows = JSON.parse(tmpWrite[1]).filter(row => row.sessionId === sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ success: false, processName: 'example-process' });
    expect(Date.parse(rows[0].startTime)).toBeGreaterThan(Date.parse('2023-11-14T22:13:20.000Z'));
  });

  it('writes the history index via temp file + rename', async () => {
    await start();
    const tmpWrite = writeFile.mock.calls.findIndex(([f]) => f === '/example/index.json.tmp');
    expect(tmpWrite).toBeGreaterThanOrEqual(0);
    expect(rename).toHaveBeenCalledWith('/example/index.json.tmp', '/example/index.json');
  });

  it('creates a missing history index exclusively with private permissions', async () => {
    harness.apps.mockResolvedValue([]);
    let indexCreated = false;
    chmod.mockImplementation(async path => {
      if (path === '/example/index.json' && !indexCreated) {
        indexCreated = true;
        throw Object.assign(new Error('missing index'), { code: 'ENOENT' });
      }
    });
    await start();
    expect(writeFile).toHaveBeenCalledExactlyOnceWith('/example/index.json', '[]', { flag: 'wx', mode: 0o600 });
    expect(rename).not.toHaveBeenCalled();
    expect(harness.startUi).toHaveBeenCalledOnce();
  });

  it.each([true, false])('removes evicted sessions only after a successful index commit (%s)', async commitSucceeds => {
    harness.index = JSON.stringify([
      ...Array.from({ length: 99 }, (_, i) => ({ sessionId: `autofixer_recent_${i}` })),
      { sessionId: 'autofixer_pending' },
      { sessionId: 'autofixer_discarded', staged: true },
      { sessionId: 'autofixer_retired' },
      { sessionId: 'autofixer_recent_0' },
      { sessionId: 'autofixer_../../outside' },
    ]);
    harness.sessionMetadata[`${sessionsDir}/autofixer_pending/metadata.json`] = { staged: true };
    if (!commitSucceeds) {
      rename.mockImplementation(async (_, destination) => {
        if (destination === indexFile) throw new Error('Index rename failed');
      });
    }
    await start();
    const indexWrite = writeFile.mock.calls.find(([file]) => file === `${indexFile}.tmp`);
    const rows = JSON.parse(indexWrite[1]);
    expect(rows).toHaveLength(101);
    expect(rows.at(-1).sessionId).toBe('autofixer_pending');
    if (commitSucceeds) {
      expect(rm.mock.calls).toEqual(['autofixer_discarded', 'autofixer_retired'].map(id => [
        `${sessionsDir}/${id}`, { recursive: true, force: true },
      ]));
      const indexRename = rename.mock.calls.findIndex(([, destination]) => destination === indexFile);
      expect(rename.mock.invocationCallOrder[indexRename]).toBeLessThan(rm.mock.invocationCallOrder[0]);
    } else {
      expect(rm).not.toHaveBeenCalled();
    }
  });

  it('sweeps only unindexed, unstaged session directories before starting the dashboard', async () => {
    harness.apps.mockResolvedValue([]);
    harness.index = JSON.stringify([{ sessionId: 'autofixer_indexed' }]);
    harness.sessionMetadata[`${sessionsDir}/autofixer_pending/metadata.json`] = { staged: true };
    readdir.mockResolvedValue([
      directory('autofixer_indexed'), directory('autofixer_pending'), directory('autofixer_orphan'),
      directory('other_directory'), { name: 'autofixer_link', isDirectory: () => false },
    ]);
    await start();
    expect(rm).toHaveBeenCalledExactlyOnceWith(`${sessionsDir}/autofixer_orphan`, { recursive: true, force: true });
    expect(rm.mock.invocationCallOrder[0]).toBeLessThan(harness.startUi.mock.invocationCallOrder[0]);
  });

  it('skips startup pruning when the history index is corrupt', async () => {
    harness.apps.mockResolvedValue([]);
    harness.index = '[null]';
    readdir.mockResolvedValue([directory('autofixer_orphan')]);
    await start();
    expect(rm).not.toHaveBeenCalled();
    expect(harness.startUi).toHaveBeenCalledOnce();
  });

  it('refuses partial edits from a repair process that exited unsuccessfully', async () => {
    harness.provider.mockResolvedValue({ text: 'partially repaired', partial: true, exitCode: 1 });
    await start();
    expect(harness.validate).not.toHaveBeenCalled();
    const meta = writeFile.mock.calls.find(([f]) => String(f).endsWith('metadata.json.tmp'));
    expect(JSON.parse(meta[1])).toMatchObject({ success: false, diffValid: false, promoted: false, staged: false });
  });

  it('validates edits only after a complete successful repair process', async () => {
    harness.provider.mockResolvedValue({ text: 'repaired', partial: false, exitCode: 0 });
    await start();
    expect(harness.validate).toHaveBeenCalledOnce();
  });

  it('blocks staging and promotion when the configured verifier has no supported containment', async () => {
    harness.settings = { autofixer: { autoPromote: true, verifyCommand: 'npm test' } };
    harness.provider.mockResolvedValue({ text: 'repaired', partial: false, exitCode: 0 });
    harness.validate.mockReturnValue({ ok: true, files: ['a.js'] });
    harness.verify.mockResolvedValue({ ok: false, contained: false, code: -1, output: 'verification refused: no descendant containment' });
    await start();
    expect(harness.verify).toHaveBeenCalledOnce();
    expect(harness.apply).not.toHaveBeenCalled();
    const meta = writeFile.mock.calls.find(([f]) => String(f).endsWith('metadata.json.tmp'));
    expect(JSON.parse(meta[1])).toMatchObject({ success: false, promoted: false, staged: false,
      verify: { ok: false, contained: false, exitCode: -1 } });
  });

  it('promotes a fix the Docker-contained verifier passed, and only when the operator opted in', async () => {
    harness.settings = {
      autofixer: { autoPromote: true, verifyCommand: 'npm test' },
      instanceFeatures: { 'docker-containment': { enabled: true } },
      dockerContainment: { limits: { cpus: 1 } },
    };
    harness.provider.mockResolvedValue({ text: 'repaired', partial: false, exitCode: 0 });
    harness.validate.mockReturnValue({ ok: true, files: ['a.js'] });
    harness.verify.mockResolvedValue({ ok: true, contained: true, code: 0, output: 'ok', mechanism: 'docker' });
    harness.apply.mockResolvedValue({ ok: true });
    await start();
    expect(harness.verify.mock.calls[0][2]).toMatchObject({ docker: { enabled: true, settings: { limits: { cpus: 1 } } } });
    expect(harness.apply).toHaveBeenCalledOnce();

    harness.settings = { autofixer: { verifyCommand: 'npm test' } };
    harness.verify.mockClear();
    vi.resetModules();
    await start();
    expect(harness.verify.mock.calls[0][2].docker).toEqual({ enabled: false, settings: {} });
  });

  it('still cools the process down when persisting the session fails', async () => {
    harness.provider.mockResolvedValue({ exitCode: 0, partial: false });
    harness.validate.mockReturnValue({ ok: true, files: ['a.js'] });
    writeFile.mockImplementation(async (f) => { if (String(f).endsWith('prompt.txt')) throw new Error('disk full'); });
    await start();
    await nextCycle();
    expect(harness.provider).toHaveBeenCalledOnce();
  });
});

describe('Autofixer daemon shutdown', () => {
  const shutdown = () => {
    const handle = process.on.mock.calls.find(([signal]) => signal === 'SIGTERM')[1];
    return handle();
  };
  const permitPromotion = () => {
    harness.settings = { autofixer: { autoPromote: true } };
    harness.provider.mockResolvedValue({ partial: false, exitCode: 0 });
    harness.validate.mockReturnValue({ ok: true, files: ['example.js'] });
  };
  const never = () => new Promise(() => {});

  it('forces exit after 15 seconds when a non-patch mutation drain stalls', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    harness.apps.mockResolvedValue([]);
    await start();
    const [store] = harness.startUi.mock.calls[0];
    void store.serialize(never);
    await vi.advanceTimersByTimeAsync(0);

    void shutdown();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('records the interrupted repair and escalates only groups still tracked at five seconds', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const stopped = Object.assign(new EventEmitter(), { pid: 1234 });
    const stubborn = Object.assign(new EventEmitter(), { pid: 5678 });
    harness.provider.mockImplementation(async () => {
      const { trackDetachedGroup } = await import('../server/lib/detachedProcessGroups.js');
      trackDetachedGroup(stopped, true);
      trackDetachedGroup(stubborn, true);
      return never();
    });
    await start();
    // The provider double imports the same registry as the daemon.
    await vi.dynamicImportSettled();

    const done = shutdown();
    await shutdown();
    expect(kill.mock.calls).toEqual([[-1234, 'SIGTERM'], [-5678, 'SIGTERM']]);
    stopped.emit('close');
    await vi.advanceTimersByTimeAsync(4_999);
    const meta = writeFile.mock.calls.find(([file]) => file.endsWith('metadata.json.tmp'));
    expect(JSON.parse(meta[1])).toMatchObject({ interrupted: true, processName: 'example-process' });
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(kill.mock.calls.at(-1)).toEqual([-5678, 'SIGKILL']);
    expect(kill).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a live patch time to finish and then bounds the remaining drain to 15 seconds', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const apply = Promise.withResolvers();
    const uiDrain = vi.fn(never);
    harness.startUi.mockResolvedValue(uiDrain);
    permitPromotion();
    harness.apply.mockReturnValue(apply.promise);
    await start();

    void shutdown();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(exit).not.toHaveBeenCalled();
    apply.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(harness.pm2).toHaveBeenCalledWith(['restart', 'example-process']);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit before PM2 does when a live patch cannot finish', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    permitPromotion();
    harness.apply.mockImplementation(never);
    await start();

    void shutdown();
    await vi.advanceTimersByTimeAsync(248_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
