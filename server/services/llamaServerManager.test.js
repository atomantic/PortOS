import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getLlamaServerStatus,
  startLlamaServer,
  stopLlamaServer,
  relaunchLlamaServerWithTuning,
  relaunchLlamaServerWithAlias,
  captureLlamaServerConfig,
  restoreLlamaServerConfig,
  installLlamaServer,
  getLlamaServerUpdateStatus,
  upgradeLlamaServer,
  _resetLlamaServerStateForTests,
  LLAMA_APP,
} from './llamaServerManager.js';
import * as processEnv from '../lib/processEnv.js';
import * as commandExistsModule from '../lib/commandExists.js';
import * as childProcess from '../lib/childProcess.js';
import * as platform from '../lib/platform.js';
import * as openAiModelsProbe from '../lib/openAiModelsProbe.js';
import * as pm2Module from './pm2.js';
import * as bufferedSpawnModule from '../lib/bufferedSpawn.js';
import * as streamingSpawnModule from '../lib/streamingSpawn.js';
import { PORTS } from '../lib/ports.js';
import { EventEmitter } from 'events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

function fakeSpawnProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A real child emits 'exit' and then 'close' (once stdio has flushed). Mirror
// both so the mocks stay honest for either listener: `brew install` is awaited
// on 'exit', while the `brew link` step waits for 'close' to capture output.
function endProcess(child, code) {
  child.emit('exit', code);
  child.emit('close', code);
}

const FAST_TIMING = {
  startupWaitTimeout: 50,
  startupPollDelay: 0,
  relaunchReadyTimeout: 50,
  relaunchPollDelay: 0,
  pm2ReadRetryDelay: 0,
};

const resetForTest = (overrides = {}) => {
  _resetLlamaServerStateForTests({ ...FAST_TIMING, ...overrides });
};

const brewInfoJson = ({ installedVersion = 'build-100', latestVersion = '0.3.0', outdated = true, pinned = false, linkedKeg = 'build-100' } = {}) => JSON.stringify({
  formulae: [{
    name: 'llama.cpp',
    versions: { stable: latestVersion },
    installed: [{ version: installedVersion }],
    outdated,
    pinned,
    linked_keg: linkedKeg,
  }],
});

describe('llamaServerManager', () => {
  // startLlamaServer refuses to spawn for a GGUF that is not on disk, so the
  // lifecycle tests need real files to point at.
  let modelDir;
  let modelPath;
  let draftPath;
  let homebrewBinaryPath;
  let homebrewPrefix;
  let pm2State = null;
  let execPm2Calls = [];
  // Failed PM2 reads, on demand. `getAppStatusStrict` answers `null` for a read
  // that FAILED — distinct from a successful read that found no process — and
  // several paths must not mistake that for "not PortOS's". Set `failures` to
  // the number of reads to fail, or `Infinity` for a PM2 that never answers
  // again; `count` is what a retry assertion reads.
  let pm2Reads = { failures: 0, count: 0 };

  beforeAll(async () => {
    modelDir = await mkdtemp(join(tmpdir(), 'portos-llama-'));
    modelPath = join(modelDir, 'model.gguf');
    draftPath = join(modelDir, 'draft.gguf');
    await writeFile(modelPath, 'gguf');
    await writeFile(draftPath, 'gguf');
    const homebrewRoot = join(modelDir, 'homebrew');
    const cellarRoot = join(homebrewRoot, 'Cellar', 'llama.cpp', 'build-100');
    homebrewPrefix = join(homebrewRoot, 'opt', 'llama.cpp');
    homebrewBinaryPath = join(homebrewRoot, 'bin', 'llama-server');
    await mkdir(join(cellarRoot, 'bin'), { recursive: true });
    await mkdir(join(homebrewRoot, 'bin'), { recursive: true });
    await mkdir(join(homebrewRoot, 'opt'), { recursive: true });
    await writeFile(join(cellarRoot, 'bin', 'llama-server'), 'binary');
    await symlink(cellarRoot, homebrewPrefix);
    await symlink(join(homebrewPrefix, 'bin', 'llama-server'), homebrewBinaryPath);
  });

  afterAll(async () => {
    await rm(modelDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Zero retry delay: the paths that re-read an unreadable PM2 are asserted
    // here, and a suite must not sit through the production backoff to see them.
    resetForTest();
    vi.restoreAllMocks();
    pm2State = null;
    execPm2Calls = [];
    pm2Reads = { failures: 0, count: 0 };

    // The host may have an unrelated listener on the requested port (8080 is
    // especially common), so lifecycle tests pin the port-discovery result.
    vi.spyOn(platform, 'isPortInUse').mockResolvedValue(false);
    // Same reason, one layer up: `startLlamaServer` refuses to spawn when an
    // OpenAI-compatible server already ANSWERS on the endpoint, and it probes
    // over the real network. A developer with llama.cpp actually running on
    // PortOS's own extension port failed five of these for reasons that have
    // nothing to do with the code under test, so pin the probe too. Tests that
    // need a reachable endpoint re-mock this with `{ reachable: true }`.
    vi.spyOn(openAiModelsProbe, 'probeOpenAiModels')
      .mockImplementation(async () => ({ reachable: pm2State?.status === 'online', models: [] }));

    // `createDaemonWatcher` reads the saved boot list on every status read, and
    // the dump is a real file on the developer's machine — pin it so these tests
    // are about this code, not their PM2 state. (Its twin in
    // mtplxServerManager.test.js pins it for the same reason.)
    vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue([]);

    vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
      execPm2Calls.push(args);
      const action = args[0];
      if (action === 'start') {
        const nameIdx = args.indexOf('--name');
        const name = nameIdx !== -1 ? args[nameIdx + 1] : args[1];
        const dashIdx = args.indexOf('--');
        const procArgs = dashIdx !== -1 ? args.slice(dashIdx + 1) : [];
        pm2State = { name, status: 'online', pid: 12345, args: procArgs };
        return { stdout: '', stderr: '' };
      }
      if (action === 'delete') {
        pm2State = null;
        return { stdout: '', stderr: '' };
      }
      if (action === 'logs') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    vi.spyOn(pm2Module, 'getAppStatus').mockImplementation(async (name) => {
      if (pm2State && pm2State.name === name) return pm2State;
      return { name, status: 'not_found', pm2_env: null };
    });

    vi.spyOn(pm2Module, 'getAppStatusStrict').mockImplementation(async (name) => {
      pm2Reads.count += 1;
      if (pm2Reads.failures > 0) {
        // `Infinity - 1` is still `Infinity`, so a permanent outage needs no
        // special case here.
        pm2Reads.failures -= 1;
        return null;
      }
      if (pm2State && pm2State.name === name) return pm2State;
      return { name, status: 'not_found', pm2_env: null };
    });
  });

  afterEach(() => {
    _resetLlamaServerStateForTests();
    vi.restoreAllMocks();
  });

  it('reports installed: false when binary is not found on PATH', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    const status = await getLlamaServerStatus();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.managed).toBe(false);
  });

  it('reports installed: true when binary is found on PATH', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/opt/homebrew/bin/llama-server');
    const execProbe = vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);

    const status = await getLlamaServerStatus();
    expect(status.installed).toBe(true);
    // Regression: the binary must never be executed to answer
    // "installed?". llama.cpp initializes its ggml/Metal backends at launch, so
    // a cold run right after `brew link` blew past commandExists' 5s bound and
    // reported an installed, working binary as missing.
    expect(execProbe).not.toHaveBeenCalled();
  });

  it('reports the binary version and Homebrew update metadata', async () => {
    const binaryPath = homebrewBinaryPath;
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(binaryPath);
    const buffered = vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockImplementation(async (command, args) => ({
      success: true,
      code: 0,
      stdout: command === 'brew' && args[0] === '--prefix'
        ? `${homebrewPrefix}\n`
        : command === 'brew' ? brewInfoJson() : 'version: 0.1.1-dev (build 100, commit abc123)',
      stderr: '',
      timedOut: false,
    }));

    const status = await getLlamaServerUpdateStatus();

    expect(status).toMatchObject({
      version: '0.1.1-dev',
      latestVersion: '0.3.0',
      updateAvailable: true,
      canUpgrade: true,
    });
    expect(buffered).toHaveBeenCalledWith(binaryPath, ['--version'], { timeoutMs: 5000, shell: false });
    expect(buffered).toHaveBeenCalledWith(
      'brew',
      ['info', '--json=v2', '--formula', 'llama.cpp'],
      { timeoutMs: 15_000, shell: false },
    );
  });

  it('does not offer an automatic update for a pinned Homebrew formula', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(homebrewBinaryPath);
    vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockImplementation(async (command, args) => ({
      success: true,
      code: 0,
      stdout: command === 'brew' && args[0] === '--prefix'
        ? `${homebrewPrefix}\n`
        : command === 'brew' ? brewInfoJson({ pinned: true }) : 'version: 0.1.1-dev',
      stderr: '',
      timedOut: false,
    }));

    await expect(getLlamaServerUpdateStatus()).resolves.toMatchObject({
      updateAvailable: true,
      canUpgrade: false,
      latestVersion: '0.3.0',
    });
  });

  it('keeps a custom llama-server build updateable by manual means only', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockImplementation(async (command) => ({
      success: command !== 'brew',
      code: command === 'brew' ? 1 : 0,
      stdout: command === 'brew' ? '' : 'version: custom-build',
      stderr: command === 'brew' ? 'Error: No available formula' : '',
      timedOut: false,
    }));

    await expect(getLlamaServerUpdateStatus()).resolves.toMatchObject({
      version: 'custom-build',
      latestVersion: null,
      updateAvailable: false,
      canUpgrade: false,
    });
  });

  it('keeps the Homebrew update manual when a source build is first on PATH', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockImplementation(async (command, args) => ({
      success: true,
      code: 0,
      stdout: command === 'brew' && args[0] === '--prefix'
        ? `${homebrewPrefix}\n`
        : command === 'brew' ? brewInfoJson() : 'version: custom-build',
      stderr: '',
      timedOut: false,
    }));

    await expect(getLlamaServerUpdateStatus()).resolves.toMatchObject({
      version: 'custom-build',
      latestVersion: '0.3.0',
      updateAvailable: true,
      canUpgrade: false,
    });
  });

  it('rejects start when binary is missing', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    await expect(startLlamaServer({ model: modelPath })).rejects.toThrow(
      /llama-server binary was not found/i
    );
  });

  it('spawns llama-server with draftModel and specType arguments under PM2', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    const result = await startLlamaServer({
      model: modelPath,
      draftModel: draftPath,
      specType: 'draft-dflash',
      port: 8080,
      host: '127.0.0.1',
      alias: 'dflash',
    });

    expect(result.success).toBe(true);
    expect(result.pid).toBe(12345);
    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall[1]).toBe('/usr/local/bin/llama-server');
    expect(startCall.slice(2, 8)).toEqual([
      '--name', LLAMA_APP,
      '--interpreter', 'none',
      '--no-autorestart',
      '--',
    ]);
    expect(startCall.slice(8)).toEqual([
      '-m', modelPath,
      '--model-draft', draftPath,
      '--spec-type', 'draft-dflash',
      '--port', '8080',
      '--host', '127.0.0.1',
      '--ctx-size', '32768',
      '-ngl', '99',
      '--parallel', '1',
      '--alias', 'dflash',
    ]);

    const status = await getLlamaServerStatus();
    expect(status.running).toBe(true);
    expect(status.managed).toBe(true);
    expect(status.pid).toBe(12345);
    expect(status.config.parallel).toBe(1);
  });

  it('starts an ngram spec type with no drafter model at all', async () => {
    // `ngram-*` implementations draft from the tokens already in context, so a
    // drafter GGUF is not just optional — there is nothing to download.
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath, specType: 'ngram-map-k' });

    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall).not.toContain('--model-draft');
    expect(startCall.slice(startCall.indexOf('--spec-type'), startCall.indexOf('--spec-type') + 2))
      .toEqual(['--spec-type', 'ngram-map-k']);
  });

  it('passes a combined drafter + ngram spec type through as one comma-separated flag', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath, draftModel: draftPath, specType: 'draft-dflash, ngram-map-k' });

    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall[startCall.indexOf('--spec-type') + 1]).toBe('draft-dflash,ngram-map-k');
  });

  it('drops only the drafter-based half of a combined spec type when no drafter is set', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath, specType: 'draft-dflash,ngram-map-k' });

    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall[startCall.indexOf('--spec-type') + 1]).toBe('ngram-map-k');
    const status = await getLlamaServerStatus();
    // The card reports what is running, not what was asked for.
    expect(status.config.specType).toBe('ngram-map-k');
  });

  it('ignores a preset drafter path when only ngram spec types were requested', async () => {
    // The launcher card seeds BOTH fields from a preset, so switching Spec Type
    // to an ngram implementation leaves the drafter path behind — loading it
    // would cost VRAM the run can't use, and a preset GGUF that was never
    // downloaded would fail the existence check and block Start outright.
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath, draftModel: draftPath, specType: 'ngram-map-k' });

    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall).not.toContain('--model-draft');
    expect(startCall[startCall.indexOf('--spec-type') + 1]).toBe('ngram-map-k');
    const status = await getLlamaServerStatus();
    expect(status.config.draftModel).toBeNull();
  });

  it('keeps a drafter when no spec type is set at all — llama.cpp drafts off --model-draft alone', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath, draftModel: draftPath, specType: '' });

    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall[startCall.indexOf('--model-draft') + 1]).toBe(draftPath);
    expect(startCall).not.toContain('--spec-type');
  });

  it('omits --spec-type entirely when the only requested type needs an absent drafter', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath, specType: 'draft-dspark' });

    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall).not.toContain('--spec-type');
  });

  it('honours an explicit parallel slot count', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath, parallel: 4 });

    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall.slice(startCall.indexOf('--parallel'), startCall.indexOf('--parallel') + 2))
      .toEqual(['--parallel', '4']);
  });

  it('uses PortOS\'s extension port when no port is supplied', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    const result = await startLlamaServer({ model: modelPath });

    expect(result.endpoint).toBe(`http://127.0.0.1:${PORTS.LLAMA_SERVER}/v1`);
    const startCall = execPm2Calls.find((c) => c[0] === 'start');
    expect(startCall).toContain('--port');
    expect(startCall).toContain(String(PORTS.LLAMA_SERVER));
  });

  it('rejects before spawning when the requested port is occupied by another process', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    vi.spyOn(platform, 'isPortInUse').mockResolvedValue(true);

    await expect(startLlamaServer({ model: modelPath, port: 49876 })).rejects.toMatchObject({
      code: 'LLAMA_SERVER_PORT_IN_USE',
      status: 409,
      message: expect.stringContaining('Choose a different port'),
    });
    expect(execPm2Calls.filter((c) => c[0] === 'start')).toHaveLength(0);
  });

  it('refuses to start when the GGUF the launch line names is not on disk', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await expect(startLlamaServer({ model: join(modelDir, 'absent.gguf') })).rejects.toThrow(
      /base model was not found/i
    );
    await expect(startLlamaServer({ model: modelPath, draftModel: join(modelDir, 'absent.gguf') })).rejects.toThrow(
      /drafter model was not found/i
    );
    // The weights are a separate multi-gigabyte download; spawning anyway just
    // buries that in a server log.
    expect(execPm2Calls.filter((c) => c[0] === 'start')).toHaveLength(0);
  });

  it('reports a failure — not a PID — when llama-server exits during startup', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
      if (args[0] === 'logs') return { stdout: '', stderr: 'error: unknown spec type' };
      return { stdout: '', stderr: '' };
    });
    vi.spyOn(pm2Module, 'getAppStatusStrict').mockResolvedValue({ name: LLAMA_APP, status: 'errored' });

    await expect(startLlamaServer({ model: modelPath, specType: 'draft-nope' })).rejects.toThrow(
      /llama-server exited immediately/i
    );
  });

  it('stops managed process cleanly', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    await startLlamaServer({ model: modelPath });
    const stopResult = await stopLlamaServer();
    expect(stopResult.success).toBe(true);

    const status = await getLlamaServerStatus();
    expect(status.managed).toBe(false);
  });

  it('recovers launch configuration from PM2 args after server restarts', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    pm2State = {
      name: LLAMA_APP,
      status: 'online',
      pid: 98765,
      args: ['-m', modelPath, '--model-draft', draftPath, '--port', '8090', '--host', '127.0.0.1', '--parallel', '4'],
    };

    const status = await getLlamaServerStatus();
    expect(status.managed).toBe(true);
    expect(status.pid).toBe(98765);
    expect(status.port).toBe(8090);
    expect(status.endpoint).toBe('http://127.0.0.1:8090/v1');
    expect(status.config?.model).toBe(modelPath);
    expect(status.config?.draftModel).toBe(draftPath);
    expect(status.config?.parallel).toBe(4);
  });

  it('surfaces unknown/degraded state when PM2 read fails', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/opt/homebrew/bin/llama-server');
    vi.spyOn(pm2Module, 'getAppStatusStrict').mockResolvedValue(null);

    const status = await getLlamaServerStatus();
    expect(status.managed).toBeNull();
    expect(status.lastExitError).toBe('Failed to read PM2 status');
  });

  // `managed: null` exists to say "could not tell", but nulling `config` on the
  // same failed read handed every caller guarding on `!managed ||
  // !config?.model` the same answer as "somebody else started it".
  it('keeps the last known launch line when the PM2 read fails', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    await startLlamaServer({ model: modelPath, port: PORTS.LLAMA_SERVER });

    pm2Reads.failures = Infinity;
    const status = await getLlamaServerStatus();

    expect(status.managed).toBeNull();
    expect(status.config?.model).toBe(modelPath);
  });

  // A read that SUCCEEDED and found nothing is real evidence: there is no
  // launch line, and reporting a stale one would be a lie in the other
  // direction.
  it('reports no launch line when the PM2 read succeeds and finds nothing', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    await startLlamaServer({ model: modelPath, port: PORTS.LLAMA_SERVER });
    pm2State = null;

    const status = await getLlamaServerStatus();
    expect(status.managed).toBe(false);
    expect(status.config).toBeNull();
  });

  it('propagates error when stopping PM2 process fails', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    pm2State = { name: LLAMA_APP, status: 'online', pid: 12345 };

    vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
      if (args[0] === 'delete') throw new Error('PM2 daemon down');
      return { stdout: '', stderr: '' };
    });

    await expect(stopLlamaServer()).rejects.toThrow(/Failed to stop llama-server: PM2 daemon down/);
  });

  it('installs llama.cpp via Homebrew when brew is available', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => true);
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/opt/homebrew/bin/llama-server');

    const fakeChild = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      setTimeout(() => endProcess(fakeChild, 0), 10);
      return fakeChild;
    });

    const result = await installLlamaServer();
    expect(result.success).toBe(true);
  });

  it('rejects install when Homebrew is missing', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(false);

    await expect(installLlamaServer()).rejects.toThrow(/Homebrew was not found/i);
  });

  it('links an already-installed-but-unlinked keg after `brew install` exits 0', async () => {
    // brew is present; llama-server is NOT on PATH until after the link step.
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    const findSpy = vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    const installChild = fakeSpawnProcess();
    const linkChild = fakeSpawnProcess();
    const spawnCalls = [];
    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      spawnCalls.push({ cmd, args });
      const child = args[0] === 'install' ? installChild : linkChild;
      // The binary shows up on PATH because `brew link` ran — key the mock off
      // that spawn, not a wall-clock timer. A timer races the install child's
      // own exit handler, and on a loaded runner it can fire first, making the
      // binary look already-linked so the link step never happens (#4642).
      if (args[0] === 'link') findSpy.mockReturnValue('/opt/homebrew/bin/llama-server');
      setTimeout(() => endProcess(child, 0), 10);
      return child;
    });

    const result = await installLlamaServer();
    expect(result.success).toBe(true);
    expect(spawnCalls).toEqual([
      { cmd: 'brew', args: ['install', 'llama.cpp'] },
      { cmd: 'brew', args: ['link', '--overwrite', 'llama.cpp'] },
    ]);
  });

  it('surfaces brew link output when the link step fails', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      const child = fakeSpawnProcess();
      setTimeout(() => {
        if (args[0] === 'link') {
          child.stderr.emit('data', Buffer.from('Error: Could not symlink bin/llama-server'));
          endProcess(child, 1);
        } else {
          endProcess(child, 0);
        }
      }, 10);
      return child;
    });

    await expect(installLlamaServer()).rejects.toThrow(/Could not symlink bin\/llama-server/);
  });

  it('rejects instead of hanging when the link spawn throws synchronously', async () => {
    // The exit listener is async and lives inside a Promise executor, so an
    // unguarded throw would escape as an unhandled rejection while the install
    // request never settled.
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      if (args[0] === 'link') throw new Error('spawn EACCES');
      const child = fakeSpawnProcess();
      setTimeout(() => endProcess(child, 0), 10);
      return child;
    });

    await expect(installLlamaServer()).rejects.toThrow(/Failed to verify the llama\.cpp install: spawn EACCES/);
  });

  it('rejects with a `brew link` hint when linking does not resolve the binary', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      const child = fakeSpawnProcess();
      setTimeout(() => endProcess(child, 0), 10);
      return child;
    });

    await expect(installLlamaServer()).rejects.toThrow(/brew link --overwrite llama\.cpp/i);
  });

  describe('upgradeLlamaServer', () => {
    const stubBrewInfo = (options) => vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockImplementation(async (_command, args) => ({
      success: true,
      code: 0,
      stdout: args[0] === '--prefix' ? `${homebrewPrefix}\n` : brewInfoJson(options),
      stderr: '',
      timedOut: false,
    }));

    it('updates an idle installation through Homebrew without starting it', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(homebrewBinaryPath);
      stubBrewInfo();
      const progress = vi.fn();
      const stream = vi.spyOn(streamingSpawnModule, 'runStreamingCommand').mockImplementation(async (_cmd, _args, onLine) => {
        onLine('Updated llama.cpp');
        return { success: true };
      });

      const result = await upgradeLlamaServer({ onProgress: progress });

      expect(result).toMatchObject({ success: true });
      expect(stream).toHaveBeenCalledWith(
        'brew',
        ['upgrade', 'llama.cpp'],
        expect.any(Function),
        { timeoutMs: 30 * 60 * 1000 },
      );
      expect(progress).toHaveBeenCalledWith({ event: 'progress', message: 'Updating llama.cpp via Homebrew…' });
      expect(progress).toHaveBeenCalledWith({ event: 'progress', message: 'Updated llama.cpp' });
      expect(execPm2Calls.some((args) => args[0] === 'start' || args[0] === 'delete')).toBe(false);
    });

    it('restarts a managed server with its recovered launch configuration', async () => {
      const binaryPath = homebrewBinaryPath;
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(binaryPath);
      stubBrewInfo();
      pm2State = {
        name: LLAMA_APP,
        status: 'online',
        pid: 321,
        args: ['-m', modelPath, '--port', String(PORTS.LLAMA_SERVER), '--alias', 'example-model'],
      };
      openAiModelsProbe.probeOpenAiModels.mockImplementation(async () => ({ reachable: pm2State?.status === 'online' }));
      vi.spyOn(streamingSpawnModule, 'runStreamingCommand').mockResolvedValue({ success: true });

      const result = await upgradeLlamaServer();

      expect(result).toMatchObject({ success: true });
      expect(execPm2Calls.some((args) => args[0] === 'delete')).toBe(true);
      const startCall = execPm2Calls.find((args) => args[0] === 'start');
      expect(startCall).toContain(modelPath);
      expect(startCall).toContain('--alias');
      expect(startCall).toContain('example-model');
    });

    it('restarts a managed server with the current saved idle window', async () => {
      const binaryPath = homebrewBinaryPath;
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(binaryPath);
      stubBrewInfo();
      pm2State = {
        name: LLAMA_APP,
        status: 'online',
        pid: 321,
        args: ['-m', modelPath, '--port', String(PORTS.LLAMA_SERVER), '--sleep-idle-seconds', '0'],
      };
      openAiModelsProbe.probeOpenAiModels.mockImplementation(async () => ({ reachable: pm2State?.status === 'online' }));
      vi.spyOn(childProcess, 'execFile').mockImplementation((_bin, _args, _opts, cb) => {
        cb(null, '--sleep-idle-seconds SECONDS', '');
        return fakeSpawnProcess();
      });
      vi.spyOn(streamingSpawnModule, 'runStreamingCommand').mockResolvedValue({ success: true });
      resetForTest({ sleepIdleMinutes: 30 });

      const result = await upgradeLlamaServer();

      expect(result).toMatchObject({ success: true });
      const startCall = execPm2Calls.find((args) => args[0] === 'start');
      const idleFlagIndex = startCall.indexOf('--sleep-idle-seconds');
      expect(startCall[idleFlagIndex + 1]).toBe('1800');
    });

    it('refuses to update when PM2 ownership cannot be determined', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(homebrewBinaryPath);
      stubBrewInfo();
      pm2Reads.failures = Infinity;
      const stream = vi.spyOn(streamingSpawnModule, 'runStreamingCommand');

      await expect(upgradeLlamaServer()).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/could not read PM2/i),
      });
      expect(stream).not.toHaveBeenCalled();
    });

    it('refuses an automatic update when a source build owns the active binary', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
      stubBrewInfo();
      const stream = vi.spyOn(streamingSpawnModule, 'runStreamingCommand');

      await expect(upgradeLlamaServer()).resolves.toMatchObject({
        success: false,
        manualUpdateRequired: true,
        error: expect.stringMatching(/active llama-server is not the linked Homebrew/i),
      });
      expect(stream).not.toHaveBeenCalled();
    });

    it('does not report success when a managed restart never becomes ready', async () => {
      const binaryPath = homebrewBinaryPath;
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(binaryPath);
      stubBrewInfo();
      pm2State = {
        name: LLAMA_APP,
        status: 'online',
        pid: 321,
        args: ['-m', modelPath, '--port', String(PORTS.LLAMA_SERVER), '--alias', 'example-model'],
      };
      openAiModelsProbe.probeOpenAiModels.mockResolvedValue({ reachable: false });
      vi.spyOn(streamingSpawnModule, 'runStreamingCommand').mockResolvedValue({ success: true });
      resetForTest({ startupWaitTimeout: 0, relaunchReadyTimeout: 0 });

      const result = await upgradeLlamaServer();

      expect(result).toMatchObject({
        success: false,
        updated: true,
        error: expect.stringMatching(/could not be restarted/i),
      });
      expect(execPm2Calls.filter((args) => args[0] === 'delete').length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---- tuning relaunch ----------------------------------------------------
  // The sweep half of measured assessments: put new flags on the launch line
  // between runs. Every failure mode here has to leave the daemon USABLE — it
  // fronts the `llama` provider for the whole install.
  describe('relaunchLlamaServerWithAlias', () => {
    const startedAs = async (alias) => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels')
        .mockImplementation(async () => ({ reachable: pm2State?.status === 'online' }));
      await startLlamaServer({ model: modelPath, port: PORTS.LLAMA_SERVER, alias });
    };
    const lastStartArgs = () => {
      const start = [...execPm2Calls].reverse().find((c) => c[0] === 'start') || [];
      const dash = start.indexOf('--');
      return dash === -1 ? [] : start.slice(dash + 1);
    };

    // The mismatch this whole feature exists for: llama.cpp answers under the
    // `--alias` its launch line set, so pointing the daemon at the id the
    // provider sends is a rename of the weights already loaded.
    it('relaunches the SAME weights under the requested id', async () => {
      await startedAs('dflash');
      execPm2Calls = [];

      const result = await relaunchLlamaServerWithAlias('qwen3.8-27b-dflash2');

      expect(result.applied).toBe(true);
      expect(result.reason).toBeNull();
      const args = lastStartArgs();
      expect(args[args.indexOf('--alias') + 1]).toBe('qwen3.8-27b-dflash2');
      // The weights never move — that is what makes this cheap.
      expect(args[args.indexOf('-m') + 1]).toBe(modelPath);
    });

    // `null`, not `true`: nothing was restarted, and a toast claiming a restart
    // would have the user waiting for a reload that never happened.
    it('does not bounce a daemon that already answers under that id', async () => {
      await startedAs('dflash');
      execPm2Calls = [];

      const result = await relaunchLlamaServerWithAlias('dflash');

      expect(result.applied).toBeNull();
      expect(execPm2Calls.some((c) => c[0] === 'start' || c[0] === 'delete')).toBe(false);
    });

    // An externally-launched llama-server belongs to whoever ran it. Refuse with
    // the flag they can add themselves rather than killing their process.
    it('refuses — and names the flag — when PortOS did not start the daemon', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
      const result = await relaunchLlamaServerWithAlias('qwen3.8-27b-dflash2');
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/--alias qwen3\.8-27b-dflash2/);
      expect(execPm2Calls.some((c) => c[0] === 'start' || c[0] === 'delete')).toBe(false);
    });

    // The regression this pins: an untuned assessment RELAUNCHES the pre-tuning
    // baseline. If that baseline keeps the old alias, it silently renames the
    // daemon back and re-breaks the provider the rename just fixed.
    it('carries the new id into the pre-tuning baseline a later untune restores', async () => {
      await startedAs('dflash');
      await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      await relaunchLlamaServerWithAlias('qwen3.8-27b-dflash2');
      execPm2Calls = [];

      // The untuned measurement: puts the pre-tuning launch line back.
      await relaunchLlamaServerWithTuning({});

      const args = lastStartArgs();
      expect(args[args.indexOf('--alias') + 1]).toBe('qwen3.8-27b-dflash2');
      // ...and it is still a genuine untune: the tuning flag is gone.
      expect(args).not.toContain('-ub');
    });

    // A rejected rename leaves the ORIGINAL alias on the port, so the baseline
    // must stay exactly as captured or the untune would rename to an id nothing
    // ever served.
    it('leaves the baseline alone when the rename never takes', async () => {
      await startedAs('dflash');
      await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      // Fail only the renamed launch; the restore that follows must succeed.
      const fakeExec = pm2Module.execPm2.getMockImplementation();
      let starts = 0;
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        if (args[0] === 'start' && starts++ === 0) {
          pm2State = { name: LLAMA_APP, status: 'errored', pid: null, args: [] };
          execPm2Calls.push(args);
          return { stdout: '', stderr: '' };
        }
        return fakeExec(args);
      });

      const result = await relaunchLlamaServerWithAlias('qwen3.8-27b-dflash2');
      expect(result.applied).toBe(false);

      execPm2Calls = [];
      await relaunchLlamaServerWithTuning({});
      const args = lastStartArgs();
      expect(args[args.indexOf('--alias') + 1]).toBe('dflash');
    });

    it('refuses a blank model id without touching the daemon', async () => {
      await startedAs('dflash');
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithAlias('   ');
      expect(result.applied).toBe(false);
      expect(execPm2Calls).toEqual([]);
    });
  });

  describe('relaunchLlamaServerWithTuning', () => {
    // The default harness pins the endpoint unreachable so lifecycle tests don't
    // collide with a developer's real llama-server. These tests need a FAITHFUL
    // probe instead: "reachable" has to track the fake PM2 process, or the
    // relaunch can never observe the server it just started answering — and the
    // new `online` check would report every success as not-applied.
    // The launch line of the most recent PM2 start — everything after the `--`
    // separator, which is what llama-server actually received.
    const launchArgs = () => {
      const start = [...execPm2Calls].reverse().find((c) => c[0] === 'start') || [];
      const dash = start.indexOf('--');
      return dash === -1 ? [] : start.slice(dash + 1);
    };

    // Did the daemon actually bounce? Reading the status tails PM2's logs, which
    // is not a restart — only a stop/start pair is.
    const restarted = () => execPm2Calls.some((c) => c[0] === 'start' || c[0] === 'delete');

    const probeTracksPm2 = () => vi.spyOn(openAiModelsProbe, 'probeOpenAiModels')
      .mockImplementation(async () => ({ reachable: pm2State?.status === 'online' }));

    const started = async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
      probeTracksPm2();
      await startLlamaServer({ model: modelPath, port: PORTS.LLAMA_SERVER });
    };

    it('refuses when nothing is running — there is no model path to reuse', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/not running/);
    });

    // The user's launch flags live only in the running process, so an ordinary
    // measurement must never reset them. Without `reset` an empty tuning asks
    // for nothing and is answered before PM2 is touched at all.
    // `null`, not `false`: nothing was refused. The daemon already serves the
    // configuration the caller asked for, so an untuned assessment's "Backend
    // defaults" label is accurate as it stands.
    it('relaunches nothing for an empty tuning on a daemon it never tuned', async () => {
      await started();
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({});
      expect(result.applied).toBeNull();
      expect(result.reason).toBeNull();
      expect(restarted()).toBe(false);
    });

    // The bug this pair exists for: an untuned run that followed a tuned one was
    // sampling a daemon still carrying the tuned launch line, then filing the
    // reading as "Backend defaults" — a record describing a configuration that
    // never ran, which `compareTunings` ranks every real tuning against.
    it('puts the pre-tuning launch line back for an empty tuning after a tuned one', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 512, flashAttn: true });
      execPm2Calls = [];

      const result = await relaunchLlamaServerWithTuning({});

      expect(result.applied).toBeNull();
      const start = execPm2Calls.find((c) => c[0] === 'start');
      expect(start).not.toContain('-ub');
      expect(start).not.toContain('--flash-attn');
      expect(start[start.indexOf('-m') + 1]).toBe(modelPath);
    });

    // The baseline is the line the FIRST tuning displaced. Crediting the second
    // tuning's `previous` would make "untuned" mean "whatever the first sweep
    // left running" — the same lie, one step removed.
    it('keeps the original baseline across successive tunings', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      await relaunchLlamaServerWithTuning({ ubatchSize: 1024, flashAttn: true });
      execPm2Calls = [];

      await relaunchLlamaServerWithTuning({});

      const start = execPm2Calls.find((c) => c[0] === 'start');
      expect(start).not.toContain('-ub');
      expect(start).not.toContain('--flash-attn');
    });

    it('relaunches nothing for a second empty tuning once the daemon is back at its baseline', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      await relaunchLlamaServerWithTuning({});
      execPm2Calls = [];

      expect(await relaunchLlamaServerWithTuning({})).toMatchObject({ applied: null });
      expect(restarted()).toBe(false);
    });

    // A user-stopped daemon takes its tuning with it, so a later untuned run has
    // nothing to undo — and must not resurrect the process to prove it.
    it('drops the baseline when the daemon is stopped outside a relaunch', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      await stopLlamaServer();
      execPm2Calls = [];

      expect(await relaunchLlamaServerWithTuning({})).toMatchObject({ applied: null });
      expect(restarted()).toBe(false);
    });

    // A start the user asked for supersedes the baseline. Restoring the old
    // daemon's launch line over a configuration just chosen on the LLMs page
    // would undo their change in the name of measuring defaults.
    it('drops the baseline when a fresh server is started over a crashed one', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      // The daemon dies outside PortOS — nothing called stopLlamaServer, so
      // nothing cleared the baseline — and the user starts a new one.
      pm2State = null;
      await startLlamaServer({ model: modelPath, port: PORTS.LLAMA_SERVER, ctxSize: 65536 });
      execPm2Calls = [];

      expect(await relaunchLlamaServerWithTuning({})).toMatchObject({ applied: null });
      expect(restarted()).toBe(false);
    });

    // The regression this guards: a reset the caller did not ask for wipes the
    // only copy of a configuration the user chose on the LLMs page.
    it('keeps the flags a tuning does not name unless a reset was requested', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ batchSize: 4096, flashAttn: true }, { reset: true });
      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 1024 });

      expect(result.config.ubatchSize).toBe(1024);
      expect(result.config.batchSize).toBe(4096);
      expect(result.config.flashAttn).toBe(true);
    });

    // The bug `reset` exists for: variants applied in sequence accumulated, so
    // the second launched with the first one's flags while its record's label
    // claimed a single knob — and `compareTunings` credited the change to it.
    it('clears the knobs a reset tuning does not name, so variants cannot accumulate', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ batchSize: 4096 }, { reset: true });
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 1024 }, { reset: true });

      expect(result.applied).toBe(true);
      expect(result.config.ubatchSize).toBe(1024);
      expect(result.config.batchSize).toBeNull();
      expect(launchArgs()).not.toContain('4096');
    });

    // The baseline variant of a sweep: no knobs at all, which only means
    // something when the caller asked for a complete tuning.
    it('resets a tuned server back to backend defaults for an empty reset tuning', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 1024, flashAttn: true }, { reset: true });
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({}, { reset: true });

      expect(result.applied).toBe(true);
      expect(result.config.ubatchSize).toBeNull();
      expect(result.config.flashAttn).toBe(false);
      expect(launchArgs()).not.toContain('--flash-attn');
    });

    it('reports a reset already in effect without restarting', async () => {
      await started();
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({}, { reset: true });
      expect(result.applied).toBe(true);
      expect(restarted()).toBe(false);
    });

    // A sweep rewrites the launch line once per variant, and the running daemon
    // is the only record of the flags the user chose.
    it('captures and restores the launch configuration a sweep started from', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 512, flashAttn: true }, { reset: true });
      const captured = await captureLlamaServerConfig();

      await relaunchLlamaServerWithTuning({ batchSize: 4096 }, { reset: true });
      expect((await getLlamaServerStatus()).config.flashAttn).toBe(false);

      const result = await restoreLlamaServerConfig(captured);
      expect(result.restored).toBe(true);
      const back = (await getLlamaServerStatus()).config;
      expect(back.ubatchSize).toBe(512);
      expect(back.flashAttn).toBe(true);
      expect(back.batchSize).toBeNull();
    });

    // A sweep is EXPECTED to produce launch lines that do not work. When the
    // failing variant's own fallback could not get the previous configuration up
    // either, llama-server is stopped and the install's provider is dead —
    // which is when a restore matters most, not a reason to decline it.
    it('starts from the captured configuration when the daemon is down', async () => {
      await started();
      const captured = await captureLlamaServerConfig();
      await stopLlamaServer();
      expect((await getLlamaServerStatus()).running).toBe(false);

      const result = await restoreLlamaServerConfig(captured);
      expect(result.restored).toBe(true);
      expect((await getLlamaServerStatus()).running).toBe(true);
    });

    // A server somebody else started belongs to them.
    it('refuses a running server PortOS does not manage', async () => {
      await started();
      const captured = await captureLlamaServerConfig();
      pm2State = { name: 'someone-elses-llama', status: 'online', pid: 999, args: [] };
      execPm2Calls = [];

      const result = await restoreLlamaServerConfig(captured);
      expect(result.restored).toBe(false);
      expect(result.reason).toMatch(/outside PortOS/);
      expect(restarted()).toBe(false);
    });

    it('captures nothing when PortOS is not the one running llama-server', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
      expect(await captureLlamaServerConfig()).toBeNull();
    });

    // ── An unreadable PM2 is a THIRD answer ──────────────────────────────────
    // `getAppStatusStrict` returning null means the read failed, not that the
    // daemon is somebody else's. Telling a user who owns this server that they
    // started it in a terminal points them at a fix for a problem they do not
    // have — and, worse, files their baseline reading as un-applied.

    it('refuses an unreadable PM2 as itself, not as an external llama-server', async () => {
      await started();
      execPm2Calls = [];
      pm2Reads.failures = Infinity;
      const readsBefore = pm2Reads.count;

      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 512 });

      expect(result.applied).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.reason).toMatch(/could not read PM2/i);
      expect(result.reason).not.toMatch(/outside PortOS/i);
      expect(restarted()).toBe(false);
      // The bypass probe for the retry: it asked more than once before
      // answering, so a single blip cannot decide this.
      expect(pm2Reads.count - readsBefore).toBeGreaterThan(1);
    });

    it('applies the tuning anyway when only the first PM2 read fails', async () => {
      await started();
      execPm2Calls = [];
      pm2Reads.failures = 1;

      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 512 });

      expect(result.applied).toBe(true);
      expect(launchArgs()).toContain('-ub');
    });

    // The regression #4759 turned expensive: an UNTUNED run now relaunches too,
    // and on an unreadable PM2 the old code took the `!running` exit, which
    // cleared the pre-tuning launch line. The baseline that run existed to
    // restore was gone by the time PM2 answered again, so the model's "Backend
    // defaults" row — the one `compareTunings` ranks every tuned reading
    // against — never appeared at all.
    it('does not discard the pre-tuning baseline on an unreadable PM2', async () => {
      await started();
      await relaunchLlamaServerWithTuning({ ubatchSize: 512, flashAttn: true });

      // PM2 unreadable AND the endpoint slow to answer — the state that used to
      // read as "nothing is running, so there is nothing left to undo".
      pm2Reads.failures = Infinity;
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: false });
      const refused = await relaunchLlamaServerWithTuning({});
      expect(refused.applied).toBe(false);
      expect(refused.retryable).toBe(true);

      // PM2 answers again, and the launch line PortOS displaced is still there
      // to put back.
      pm2Reads.failures = 0;
      probeTracksPm2();
      execPm2Calls = [];
      const cleared = await relaunchLlamaServerWithTuning({});

      expect(cleared.applied).toBeNull();
      expect(restarted()).toBe(true);
      expect(launchArgs()).not.toContain('--flash-attn');
      expect(launchArgs()).not.toContain('-ub');
    });

    // Capturing is a READ. Capturing nothing because PM2 blipped is what costs
    // the user their launch flags: the sweep clears them either way, and the
    // restore then has no record of what they were.
    it('captures the last known launch line when the PM2 read fails', async () => {
      await started();
      pm2Reads.failures = Infinity;

      expect((await captureLlamaServerConfig())?.model).toBe(modelPath);
    });

    it('refuses a restore on an unreadable PM2 without calling it somebody else\'s server', async () => {
      await started();
      const captured = await captureLlamaServerConfig();
      pm2Reads.failures = Infinity;
      execPm2Calls = [];

      const result = await restoreLlamaServerConfig(captured);

      expect(result.restored).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.reason).toMatch(/could not read PM2/i);
      expect(result.reason).not.toMatch(/outside PortOS/i);
      expect(restarted()).toBe(false);
    });

    it('restoring nothing is a no-op rather than a restart', async () => {
      await started();
      execPm2Calls = [];
      const result = await restoreLlamaServerConfig(null);
      expect(result.restored).toBe(false);
      expect(restarted()).toBe(false);
    });

    // A launcher-owned knob is not in the cleared set, so judging 'did anything
    // change?' on that set alone would report a new context size as applied
    // while the server kept serving the old window.
    it('relaunches for a launcher-owned knob the cleared set does not cover', async () => {
      await started();
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({ ctxSize: 4096 });

      expect(result.applied).toBe(true);
      expect(result.config.ctxSize).toBe(4096);
      expect(launchArgs()).toContain('4096');
    });

    it('skips the relaunch when a named knob already matches what is running', async () => {
      await started();
      const running = (await getLlamaServerStatus()).config;
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({ ctxSize: running.ctxSize });

      expect(result.applied).toBe(true);
      expect(restarted()).toBe(false);
    });

    // The model path, the port, and the window the user picked on the LLMs page
    // are not sweepable knobs — clearing them would resize the server out from
    // under them.
    it('leaves the model, port, and launcher-owned knobs alone', async () => {
      await started();
      const before = (await getLlamaServerStatus()).config;
      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 1024 });

      expect(result.config.model).toBe(before.model);
      expect(result.config.port).toBe(before.port);
      expect(result.config.ctxSize).toBe(before.ctxSize);
      expect(result.config.nGpuLayers).toBe(before.nGpuLayers);
    });

    it('puts the knobs on the new launch line, keeping the model it was serving', async () => {
      await started();
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 512, flashAttn: true });
      expect(result.applied).toBe(true);
      const start = execPm2Calls.find((c) => c[0] === 'start');
      expect(start).toContain('-ub');
      expect(start[start.indexOf('-ub') + 1]).toBe('512');
      expect(start).toContain('--flash-attn');
      expect(start[start.indexOf('-m') + 1]).toBe(modelPath);
    });

    // A sweep is EXPECTED to produce launch lines llama.cpp rejects. Leaving the
    // daemon down would break every later request, not just this measurement.
    it('restores the previous configuration when the tuned launch line exits', async () => {
      await started();
      // The harness's fake, captured as a raw function — re-spying and calling
      // `pm2Module.execPm2` would re-enter this wrapper and blow the stack.
      const fakeExec = pm2Module.execPm2.getMockImplementation();
      let starts = 0;
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        // Fail only the FIRST start after the relaunch (the tuned one); the
        // restore that follows must succeed.
        if (args[0] === 'start' && starts++ === 0) {
          pm2State = { name: LLAMA_APP, status: 'errored', pid: null, args: [] };
          execPm2Calls.push(args);
          return { stdout: '', stderr: '' };
        }
        return fakeExec(args);
      });
      execPm2Calls = [];

      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 999999 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/rejected that tuning/);
      // The restore ran, and it carried the ORIGINAL model with no `-ub`.
      const restore = execPm2Calls.filter((c) => c[0] === 'start').at(-1);
      expect(restore).not.toContain('-ub');
      expect(restore[restore.indexOf('-m') + 1]).toBe(modelPath);
    });

    // PM2 reporting `online` is not the same as the server answering. A daemon
    // that never opened its port has not had the tuning applied in any sense a
    // measurement could rest on.
    // `startLlamaServer` polls for only four seconds, and a large GGUF routinely
    // takes longer than that to load. Treating "not ready yet" as "wedged" would
    // tear down a launch that was about to succeed.
    it('waits past the start probe for a slow load rather than calling it wedged', async () => {
      await started();
      let answerAfter = 3;
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockImplementation(async () => {
        if (pm2State?.status !== 'online') return { reachable: false };
        return { reachable: answerAfter-- <= 0 };
      });
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      expect(result.applied).toBe(true);
      // One start only — the slow load was waited out, not restarted.
      expect(execPm2Calls.filter((c) => c[0] === 'start')).toHaveLength(1);
    });

    it('reports not-applied when the relaunched server never answers', async () => {
      await started();
      // PM2 keeps reporting `online` while the endpoint stays silent — the exact
      // split the check exists for.
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: false });
      // Shrink the readiness budget: the give-up path is what's under test, and
      // the production two minutes would just be two minutes of sleeping.
      resetForTest({ startupWaitTimeout: 0, relaunchReadyTimeout: 0 });
      execPm2Calls = [];
      const result = await relaunchLlamaServerWithTuning({ ubatchSize: 512 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/never answered/);
      // A silent process must not be LEFT running: this daemon fronts the llama
      // provider for the whole install, so the previous configuration goes back
      // exactly as it does for a launch line llama.cpp rejects outright.
      const restore = execPm2Calls.filter((c) => c[0] === 'start').at(-1);
      expect(restore).not.toContain('-ub');
      expect(restore[restore.indexOf('-m') + 1]).toBe(modelPath);
      // The timeout budgets are injected through the lifecycle seam: this
      // verifies the give-up/restore behavior without sleeping through the
      // production startup and readiness windows.
    }, 30000);
  });

  // ===========================================================================
  // IDLE UNLOAD (--sleep-idle-seconds)
  // ===========================================================================
  //
  // llama.cpp releases a checkpoint IN PLACE and reloads it on the next request,
  // so PortOS passes a flag rather than stopping the process the way it does for
  // MTPLX. The flag is recent, and an older build rejects an unknown flag and
  // exits before it binds — hence the capability probe these tests pin.
  describe('idle unload', () => {
    // Pin the binary like every other lifecycle test here: CI has no llama.cpp
    // installed, so an unmocked `findCommandOnPath` makes `startLlamaServer`
    // refuse before it ever builds a launch line — a failure that reproduces
    // nowhere on a developer machine that has the real binary on PATH.
    beforeEach(() => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    });

    /** Pin `llama-server --help` output for the capability probe. */
    const mockHelp = (text) => vi.spyOn(childProcess, 'execFile')
      .mockImplementation((_bin, _args, _opts, cb) => { cb(null, text, ''); return fakeSpawnProcess(); });

    const startArgs = () => (execPm2Calls.find((c) => c[0] === 'start') || []).slice(8);

    it('puts the window on the launch line in SECONDS when the build supports it', async () => {
      mockHelp('--sleep-idle-seconds SECONDS  number of seconds of idleness');

      await startLlamaServer({ model: modelPath, draftModel: null, specType: '', port: 8080, sleepIdleMinutes: 30 });

      expect(startArgs()).toContain('--sleep-idle-seconds');
      // 30 minutes on the card, 1800 seconds on the flag — the unit is the
      // flag's, and getting this backwards would idle-unload after 30 seconds.
      expect(startArgs()[startArgs().indexOf('--sleep-idle-seconds') + 1]).toBe('1800');
    });

    it('leaves the flag off entirely when the window is 0', async () => {
      mockHelp('--sleep-idle-seconds SECONDS  number of seconds of idleness');

      await startLlamaServer({ model: modelPath, draftModel: null, specType: '', port: 8080, sleepIdleMinutes: 0 });

      expect(startArgs()).not.toContain('--sleep-idle-seconds');
    });

    // The compatibility guarantee: an install on an older llama.cpp must keep
    // starting. Emitting an unknown flag would make the daemon exit immediately.
    it('omits the flag on a build that does not advertise it, rather than failing the start', async () => {
      mockHelp('--port PORT  port to listen on\n--ctx-size N  context size');

      const result = await startLlamaServer({ model: modelPath, draftModel: null, specType: '', port: 8080, sleepIdleMinutes: 30 });

      expect(result.success).toBe(true);
      expect(startArgs()).not.toContain('--sleep-idle-seconds');
      // ...and the status reports what actually reached the process, not what was asked for.
      expect(result.config.sleepIdleMinutes).toBe(0);
    });

    it('says so in the logs when the build cannot idle-unload', async () => {
      mockHelp('--port PORT  port to listen on');

      await startLlamaServer({ model: modelPath, draftModel: null, specType: '', port: 8080, sleepIdleMinutes: 30 });
      const status = await getLlamaServerStatus();

      expect(status.recentLogs.join('\n')).toContain('--sleep-idle-seconds');
    });

    it('treats a --help probe that fails as "unsupported"', async () => {
      vi.spyOn(childProcess, 'execFile')
        .mockImplementation((_bin, _args, _opts, cb) => { cb(new Error('ENOENT'), '', ''); return fakeSpawnProcess(); });

      const result = await startLlamaServer({ model: modelPath, draftModel: null, specType: '', port: 8080, sleepIdleMinutes: 30 });

      expect(result.success).toBe(true);
      expect(startArgs()).not.toContain('--sleep-idle-seconds');
    });

    it('probes --help once per binary, not once per start', async () => {
      const spy = mockHelp('--sleep-idle-seconds SECONDS');

      await startLlamaServer({ model: modelPath, draftModel: null, specType: '', port: 8080, sleepIdleMinutes: 30 });
      await stopLlamaServer();
      await startLlamaServer({ model: modelPath, draftModel: null, specType: '', port: 8080, sleepIdleMinutes: 30 });

      expect(spy).toHaveBeenCalledTimes(1);
    });

    // A PortOS restart under a still-running daemon recovers the launch line
    // from PM2's argv; the window has to come back with it or the status card
    // would report idle unload as off on a server that has it on.
    it('recovers the window from a running process argv, converting back to minutes', async () => {
      pm2State = {
        name: LLAMA_APP,
        status: 'online',
        pid: 4242,
        args: ['-m', modelPath, '--port', '8080', '--sleep-idle-seconds', '1800'],
      };

      const status = await getLlamaServerStatus();

      expect(status.config.sleepIdleMinutes).toBe(30);
    });

    it('reports 0 for a running process whose argv carries no window', async () => {
      pm2State = { name: LLAMA_APP, status: 'online', pid: 4242, args: ['-m', modelPath, '--port', '8080'] };

      const status = await getLlamaServerStatus();

      expect(status.config.sleepIdleMinutes).toBe(0);
    });
  });

});
