import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getMtplxServerStatus,
  startMtplxServer,
  stopMtplxServer,
  relaunchMtplxServerWithTuning,
  installMtplx,
  _resetMtplxServerStateForTests,
  ensureMtplxRunning,
  ensureMtplxProviderReady,
  isMtplxProvider,
  MTPLX_APP,
} from './mtplxServerManager.js';
import * as processEnv from '../lib/processEnv.js';
import * as platform from '../lib/platform.js';
import * as openAiModelsProbe from '../lib/openAiModelsProbe.js';
import * as mtplxModels from '../lib/mtplxModels.js';
import * as pm2Module from './pm2.js';
import * as commandExistsModule from '../lib/commandExists.js';
import * as streamingSpawn from '../lib/streamingSpawn.js';

const BINARY = '/opt/homebrew/bin/mtplx';
const cachedModel = (repoId, extra = {}) => ({ repo_id: repoId, validation: { ok: true }, ...extra });
const FAST_TIMING = {
  startupWait: 50,
  startupPoll: 0,
  portRelease: 20,
  relaunchReadyTimeout: 30,
  relaunchPoll: 0,
};
const resetForTest = (overrides = {}) => {
  _resetMtplxServerStateForTests({ ...FAST_TIMING, ...overrides });
};

describe('mtplxServerManager', () => {
  let pm2State = null;
  let execPm2Calls = [];
  let testLogDir = null;

  beforeEach(async () => {
    testLogDir = await mkdtemp(join(tmpdir(), 'portos-mtplx-test-'));
    resetForTest({
      logFiles: {
        stdout: join(testLogDir, 'portos-mtplx-out.log'),
        stderr: join(testLogDir, 'portos-mtplx-error.log'),
      },
    });
    vi.restoreAllMocks();
    pm2State = null;
    execPm2Calls = [];

    // The host may genuinely be running MTPLX (or anything else) on :8000 — pin
    // both probes so a developer machine's real listeners can't decide these.
    vi.spyOn(platform, 'isPortInUse').mockResolvedValue(false);
    vi.spyOn(openAiModelsProbe, 'probeOpenAiModels')
      .mockImplementation(async () => ({ reachable: pm2State?.status === 'online' }));
    vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(true);
    // The dump is a real file on the developer's machine; pin it so the
    // startsAtBoot assertions are about this code, not their PM2 state.
    vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue([]);
    vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: [cachedModel('Example/Qwen-MTP')], error: null });

    vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
      execPm2Calls.push(args);
      if (args[0] === 'start') {
        const nameIdx = args.indexOf('--name');
        const dashIdx = args.indexOf('--');
        pm2State = {
          name: nameIdx !== -1 ? args[nameIdx + 1] : args[1],
          status: 'online',
          pid: 4242,
          args: dashIdx !== -1 ? args.slice(dashIdx + 1) : [],
        };
      }
      if (args[0] === 'delete') pm2State = null;
      return { stdout: '', stderr: '' };
    });
    vi.spyOn(pm2Module, 'getAppStatusStrict').mockImplementation(async (name) => (
      pm2State && pm2State.name === name ? pm2State : { name, status: 'not_found', pm2_env: null }
    ));
    vi.spyOn(pm2Module, 'clearJlistCache').mockImplementation(() => {});
  });

  afterEach(async () => {
    _resetMtplxServerStateForTests();
    vi.restoreAllMocks();
    await rm(testLogDir, { recursive: true, force: true });
    testLogDir = null;
  });

  describe('getMtplxServerStatus', () => {
    it('reports not installed when the binary is not on PATH', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      const status = await getMtplxServerStatus();
      expect(status.installed).toBe(false);
      expect(status.running).toBe(false);
      expect(status.managed).toBe(false);
      // A missing binary means the cache was never queried, so `cachedModels`
      // must not read as "queried and empty" plus a phantom error.
      expect(status.cacheError).toBeNull();
    });

    it('surfaces the cached checkpoints an installed MTPLX can be started on', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      const status = await getMtplxServerStatus();
      expect(status.installed).toBe(true);
      expect(status.cachedModels).toEqual(['Example/Qwen-MTP']);
      expect(status.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    });

    it('reports the platform gate only when nothing is installed here', async () => {
      vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(false);
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      expect((await getMtplxServerStatus()).supported).toBe(false);

      // A binary on PATH is proof this host runs it — "macOS only" would be a
      // false report about an install the user can see.
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      const installed = await getMtplxServerStatus();
      expect(installed.supported).toBe(true);
      expect(installed.unsupportedReason).toBeNull();
    });

    // The card renders these rather than re-deriving flags from the knob ids,
    // so the catalog that owns the transport stays the only thing that renders
    // a flag. A tuned daemon that reported no flags would look plain "running"
    // while every request through the mtplx provider ran under them.
    it('reports the tuning flags the running daemon was launched with', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      await startMtplxServer({ tuning: { depth: 5 } });
      expect((await getMtplxServerStatus()).tuningFlags).toEqual(['--depth', '5']);
    });

    it('reports no tuning flags for a server PortOS does not manage', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });
      const status = await getMtplxServerStatus();
      expect(status.running).toBe(true);
      // PortOS cannot read another process's launch line, so claiming it is
      // untuned would be a guess dressed as a fact.
      expect(status.tuningFlags).toEqual([]);
    });

    it('flags the process as boot-persisted only when the PM2 dump names it', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      expect((await getMtplxServerStatus()).runAtStartup).toBe(false);

      vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue([MTPLX_APP]);
      expect((await getMtplxServerStatus()).runAtStartup).toBe(true);

      // An unreadable dump is NOT "no" — it has to stay distinguishable so the
      // UI can say "unknown" instead of "won't come back after a reboot".
      vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue(null);
      expect((await getMtplxServerStatus()).runAtStartup).toBeNull();
    });
  });

  describe('startMtplxServer', () => {
    beforeEach(() => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
    });

    it('starts `mtplx serve` under PM2 on a cached checkpoint', async () => {
      const result = await startMtplxServer();
      expect(result.success).toBe(true);
      expect(result.managed).toBe(true);

      const start = execPm2Calls.find((args) => args[0] === 'start');
      expect(start).toContain('--name');
      expect(start[start.indexOf('--name') + 1]).toBe(MTPLX_APP);
      const launch = start.slice(start.indexOf('--') + 1);
      // `serve` (API-only), never `start` — which is interactive and prompts.
      expect(launch[0]).toBe('serve');
      expect(launch).toContain('--model');
      expect(launch[launch.indexOf('--model') + 1]).toBe('Example/Qwen-MTP');
    });

    it('binds the port the caller asked for, so the provider endpoint matches', async () => {
      const result = await startMtplxServer({ port: 8010 });
      expect(result.endpoint).toBe('http://127.0.0.1:8010/v1');
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch[launch.indexOf('--port') + 1]).toBe('8010');
    });

    it('refuses with the in-app download as the fix when the cache was read and is empty', async () => {
      vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: [], error: null });
      // The fix a user is pointed at is a button in PortOS, never a terminal
      // command they have to leave the app to run (PRD NR-9).
      const err = await startMtplxServer().catch((e) => e);
      expect(err.message).toMatch(/Download default checkpoint/);
      expect(err.message).not.toMatch(/terminal/);
      expect(execPm2Calls.some((args) => args[0] === 'start')).toBe(false);
    });

    it('falls through to MTPLX\'s own default when the cache could not be READ', async () => {
      // `models: null` is "could not read", which must not block a start that
      // may well work — unlike `[]`, which means "read, and empty".
      vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: null, error: 'mtplx models timed out' });
      const result = await startMtplxServer();
      expect(result.success).toBe(true);
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch).not.toContain('--model');
    });

    it('reports what a server that died on startup printed', async () => {
      // PM2 leaving `online` is the signal; its log tail is what turns "exited"
      // into something the user can act on.
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        execPm2Calls.push(args);
        if (args[0] === 'start') {
          pm2State = { name: MTPLX_APP, status: 'errored', pid: null, args: [] };
        }
        if (args[0] === 'delete') pm2State = null;
        if (args[0] === 'logs') {
          return {
            stdout: '',
            stderr: [
              'runtime is not installed',
              'Bootstrapping with pip',
              'python3.13 -m ensurepip --upgrade --default-pip',
              'error: model is not available locally',
            ].join('\n'),
          };
        }
        return { stdout: '', stderr: '' };
      });
      await expect(startMtplxServer()).rejects.toThrow(/model is not available locally/);
      // The failed entry is cleaned up so the next start isn't a name collision.
      expect(pm2State).toBeNull();
    });

    it('explains how to recover when MTPLX cannot bootstrap its Python runtime', async () => {
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        execPm2Calls.push(args);
        if (args[0] === 'start') {
          pm2State = { name: MTPLX_APP, status: 'errored', pid: null, args: [] };
        }
        if (args[0] === 'delete') pm2State = null;
        if (args[0] === 'logs') {
          return {
            stdout: '',
            stderr: [
              'runtime is not installed',
              'Bootstrapping with pip',
              'python3.13 -m ensurepip --upgrade --default-pip',
              "Command '['python3.13', '-m', 'ensurepip']' returned non-zero exit status 1",
            ].join('\n'),
          };
        }
        return { stdout: '', stderr: '' };
      });

      const err = await startMtplxServer().catch((error) => error);

      expect(err).toMatchObject({ code: 'MTPLX_EXITED' });
      expect(err.message).toContain('Homebrew\'s Python does not provide a working `ensurepip`');
      expect(err.message).toContain('brew reinstall python@3.13');
      expect(err.message).toContain('brew reinstall --build-from-source youssofal/mtplx/mtplx');
      const start = execPm2Calls.find((args) => args[0] === 'start');
      expect(start[start.indexOf('--output') + 1]).toMatch(/portos-mtplx-out\.log$/);
      expect(start[start.indexOf('--error') + 1]).toMatch(/portos-mtplx-error\.log$/);
      expect(err.message).toContain('returned non-zero exit status 1');
      expect(pm2State).toBeNull();
    });

    it('does not classify bootstrap text left by a previous launch', async () => {
      await startMtplxServer();
      const firstStart = execPm2Calls.find((args) => args[0] === 'start');
      const outputPath = firstStart[firstStart.indexOf('--output') + 1];
      const errorPath = firstStart[firstStart.indexOf('--error') + 1];
      await stopMtplxServer();

      const staleBootstrap = [
        'runtime is not installed',
        'Bootstrapping with pip',
        'python3.13 -m ensurepip --upgrade --default-pip',
        "Command '['python3.13', '-m', 'ensurepip']' returned non-zero exit status 1",
      ].join('\n');
      await writeFile(outputPath, staleBootstrap);
      await writeFile(errorPath, staleBootstrap);

      execPm2Calls = [];
      pm2Module.execPm2.mockImplementation(async (args) => {
        execPm2Calls.push(args);
        if (args[0] === 'start') {
          pm2State = { name: MTPLX_APP, status: 'errored', pid: null, args: [] };
        }
        if (args[0] === 'delete') pm2State = null;
        if (args[0] === 'logs') {
          return {
            stdout: await readFile(outputPath, 'utf8'),
            stderr: await readFile(errorPath, 'utf8'),
          };
        }
        return { stdout: '', stderr: '' };
      });

      const err = await startMtplxServer().catch((error) => error);

      expect(err).toMatchObject({ code: 'MTPLX_EXITED' });
      expect(err.message).toMatch(/MTPLX exited immediately/);
      expect(err.message).not.toMatch(/Homebrew/);
      expect(await readFile(outputPath, 'utf8')).toBe('');
      expect(await readFile(errorPath, 'utf8')).toBe('');
      expect(pm2State).toBeNull();
    });

    it('keeps the in-memory launch context when log reset is unavailable', async () => {
      resetForTest({
        logFiles: {
          stdout: join(testLogDir, 'missing', 'portos-mtplx-out.log'),
          stderr: join(testLogDir, 'missing', 'portos-mtplx-error.log'),
        },
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        execPm2Calls.push(args);
        if (args[0] === 'start') {
          pm2State = { name: MTPLX_APP, status: 'errored', pid: null, args: [] };
        }
        if (args[0] === 'delete') pm2State = null;
        return { stdout: '', stderr: '' };
      });

      const err = await startMtplxServer().catch((error) => error);

      expect(err).toMatchObject({ code: 'MTPLX_EXITED' });
      expect(err.message).toContain('Starting: mtplx serve');
      expect(err.message).not.toMatch(/Homebrew/);
      expect(pm2State).toBeNull();
    });

    it('reports the endpoint it actually bound, with no host it never passes', async () => {
      // MTPLX is a loopback daemon and no `--host` ever reaches its launch line,
      // so accepting a host would record an endpoint the server is not bound to.
      const result = await startMtplxServer({ port: 8010, host: '0.0.0.0' });
      expect(result.endpoint).toBe('http://127.0.0.1:8010/v1');
      expect(result.config).not.toHaveProperty('host');
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch).not.toContain('--host');
      expect((await getMtplxServerStatus()).host).toBe('127.0.0.1');
    });

    it('refuses when the binary is not installed', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      await expect(startMtplxServer()).rejects.toThrow(/not found on PATH/);
    });

    it('refuses rather than launching a second copy onto a bound port', async () => {
      vi.spyOn(platform, 'isPortInUse').mockResolvedValue(true);
      await expect(startMtplxServer()).rejects.toThrow(/already in use/);
    });

    it('puts the tuning knobs on the launch line as mtplx serve flags', async () => {
      const result = await startMtplxServer({ tuning: { depth: 5, kvQuant: 'q4' } });
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch[launch.indexOf('--depth') + 1]).toBe('5');
      expect(launch[launch.indexOf('--kv-quant') + 1]).toBe('q4');
      // Carried on the config so a later relaunch re-applies it rather than
      // silently dropping back to MTPLX's defaults.
      expect(result.config.tuning).toEqual({ depth: 5, kvQuant: 'q4' });
    });

    it('drops a knob the catalog does not declare instead of inventing a flag', async () => {
      // The retired `maxKvSize` knob was never an `mtplx serve` flag; passing
      // one through unchecked is exactly the exit-before-bind failure.
      await startMtplxServer({ tuning: { maxKvSize: 8192, depth: 2 } });
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch).not.toContain('--max-kv-size');
      expect(launch).toContain('--depth');
    });

    it('leaves the launch line untuned when nothing was asked for', async () => {
      const result = await startMtplxServer();
      const start = execPm2Calls.find((a) => a[0] === 'start');
      const launch = start.slice(start.indexOf('--') + 1);
      expect(launch).toEqual(['serve', '--port', expect.any(String), '--model', 'Example/Qwen-MTP']);
      expect(result.config.tuning).toEqual({});
    });
  });

  describe('relaunchMtplxServerWithTuning', () => {
    beforeEach(() => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      resetForTest();
    });

    // Readiness is what the caller's `applied: true` means, so most cases need
    // the endpoint to answer once the relaunched process is up.
    const answerOnceRunning = () => vi.spyOn(openAiModelsProbe, 'probeOpenAiModels')
      .mockImplementation(async () => ({ reachable: pm2State?.status === 'online' }));

    // Reachable UNLESS the running launch line carries `flag` — a tuning MTPLX
    // starts under but never serves under, with the previous configuration
    // coming back healthy. The restore now waits for readiness too, so a probe
    // pinned unreachable for everything would model both halves failing.
    const answerUnless = (flag) => vi.spyOn(openAiModelsProbe, 'probeOpenAiModels')
      .mockImplementation(async () => ({
        reachable: pm2State?.status === 'online' && !(pm2State.args || []).includes(flag),
      }));

    it('relaunches on the same checkpoint with the tuning flags added', async () => {
      await startMtplxServer({ port: 8010 });
      answerOnceRunning();
      const result = await relaunchMtplxServerWithTuning({ contextWindow: 32768 });

      expect(result.applied).toBe(true);
      expect(result.reason).toBeNull();
      const launch = execPm2Calls.filter((a) => a[0] === 'start').pop();
      expect(launch[launch.indexOf('--model') + 1]).toBe('Example/Qwen-MTP');
      expect(launch[launch.indexOf('--port') + 1]).toBe('8010');
      expect(launch[launch.indexOf('--context-window') + 1]).toBe('32768');
    });

    // The reading is labelled with the knob set the caller named, and nothing
    // else. Merging the previous run's flags in would launch a configuration
    // the record does not describe — and `compareTunings` would then rank two
    // readings against each other on labels neither one actually ran under.
    it('launches exactly the tuning it was given, not that plus the last one', async () => {
      await startMtplxServer({ tuning: { depth: 4 } });
      answerOnceRunning();
      const result = await relaunchMtplxServerWithTuning({ kvQuant: 'q8' });

      expect(result.config.tuning).toEqual({ kvQuant: 'q8' });
      const launch = execPm2Calls.filter((a) => a[0] === 'start').pop();
      expect(launch).not.toContain('--depth');
      expect(launch[launch.indexOf('--kv-quant') + 1]).toBe('q8');
    });

    // A sweep EXPECTS launch lines that do not work. Leaving the daemon down
    // would break the whole install's mtplx provider, not just the measurement.
    it('restores the previous configuration when MTPLX rejects the tuning', async () => {
      await startMtplxServer({ tuning: { depth: 2 } });
      answerOnceRunning();

      let rejectNext = true;
      const realExec = pm2Module.execPm2.getMockImplementation();
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        const out = await realExec(args);
        if (args[0] === 'start' && args.includes('--context-window') && rejectNext) {
          rejectNext = false;
          pm2State = { name: MTPLX_APP, status: 'errored', pid: null, args: [] };
        }
        if (args[0] === 'logs') return { stdout: '', stderr: 'error: unrecognized arguments' };
        return out;
      });

      const result = await relaunchMtplxServerWithTuning({ contextWindow: 1048576 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/MTPLX rejected that tuning/);
      // Back up on what it was serving before, not left down.
      expect(pm2State?.status).toBe('online');
      expect(result.config.tuning).toEqual({ depth: 2 });
      const restored = execPm2Calls.filter((a) => a[0] === 'start').pop();
      expect(restored).not.toContain('--context-window');
      expect(restored[restored.indexOf('--depth') + 1]).toBe('2');
    });

    // PM2 says `online` long before an MLX checkpoint is loaded, so a process
    // that never answers is a wedge — and measuring its timeouts would file
    // them as evidence for this tuning.
    it('restores the previous configuration when the relaunch never answers', async () => {
      await startMtplxServer({ tuning: { depth: 2 } });
      answerUnless('--context-window');
      const result = await relaunchMtplxServerWithTuning({ contextWindow: 65536 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/never answered/);
      expect(result.config.tuning).toEqual({ depth: 2 });
      expect(pm2State?.status).toBe('online');
    });

    // The restore is only worth anything if the daemon is SERVING again when it
    // returns. `startMtplxServer` proves only that the process survived its
    // first seconds, and the caller measures immediately after — so returning
    // early would have it sample a checkpoint still loading, time every sample
    // out, and store a junk does-not-fit record that counts as "assessed".
    it('reports no config when the previous configuration could not be brought back', async () => {
      await startMtplxServer({ tuning: { depth: 2 } });
      // Nothing answers again — the tuned line, and the restore behind it.
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: false });
      const result = await relaunchMtplxServerWithTuning({ contextWindow: 65536 });
      expect(result.applied).toBe(false);
      expect(result.config).toBeNull();
    });

    // A launch line MTPLX ACCEPTS but the machine cannot hold dies partway
    // through loading the checkpoint — after the short startup window has
    // already returned. Waiting the full readiness budget out on a process PM2
    // has marked `errored` leaves the install's mtplx provider down for minutes
    // per bad launch line, and a sweep is expected to produce several.
    it('restores immediately when PM2 shows the relaunch died, not after the full budget', async () => {
      await startMtplxServer({ tuning: { depth: 2 } });
      answerUnless('--context-window');
      // Long enough that sitting it out would blow the per-test timeout, so the
      // assertion is about noticing the death rather than about the clock.
      resetForTest({
        startupWait: 20,
        startupPoll: 5,
        relaunchReadyTimeout: 60_000,
        relaunchPoll: 5,
      });

      const realExec = pm2Module.execPm2.getMockImplementation();
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        const out = await realExec(args);
        // Comes up "online", then dies once the startup wait has already passed.
        if (args[0] === 'start' && args.includes('--context-window')) {
          setTimeout(() => { if (pm2State) pm2State.status = 'errored'; }, 30);
        }
        if (args[0] === 'logs') return { stdout: '', stderr: 'metal buffer allocation failed' };
        return out;
      });

      const result = await relaunchMtplxServerWithTuning({ contextWindow: 1048576 });
      expect(result.applied).toBe(false);
      // The two not-ready states are distinct: PM2 has a status and a log tail
      // for a process that DIED, and reporting that as "never answered on its
      // port" would discard the one fact that explains the failure.
      expect(result.reason).toMatch(/exited while loading/);
      expect(result.reason).toMatch(/metal buffer allocation failed/);
      expect(result.config.tuning).toEqual({ depth: 2 });

      // The restore relaunches, and `startMtplxServer` clears the log buffer and
      // lastExitError for the server it is about to start — so without putting
      // the failure back, the card would show a healthy daemon with empty logs
      // and the only record of WHY would be inside the assessment.
      const after = await getMtplxServerStatus();
      expect(after.lastExitError).toMatch(/exited while loading/);
      expect(after.recentLogs.join(' ')).toMatch(/restored the previous configuration/);
    });

    // "MTPLX rejected that tuning" is only true when `mtplx serve` actually ran.
    // `startMtplxServer` also throws from guards that fire BEFORE it launches
    // anything — most realistically the port still held by the daemon just
    // stopped — and blaming the tuning sends the user hunting a flag that was
    // never passed.
    it('does not blame the tuning for a failure that happened before MTPLX ran', async () => {
      await startMtplxServer({ tuning: { depth: 2 } });
      answerOnceRunning();
      // The stopped daemon is still holding the port when the next start tries.
      vi.spyOn(platform, 'isPortInUse').mockResolvedValue(true);

      const result = await relaunchMtplxServerWithTuning({ depth: 6 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/could not start MTPLX/);
      expect(result.reason).not.toMatch(/rejected that tuning/);
    });

    it('refuses when PM2 cannot be read, without calling the daemon external', async () => {
      // `pm2 jlist` fails transiently while MTPLX is still answering: running,
      // but PortOS cannot prove it owns the process.
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });
      vi.spyOn(pm2Module, 'getAppStatusStrict').mockResolvedValue(null);
      const result = await relaunchMtplxServerWithTuning({ depth: 3 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/could not read PM2/);
      // The misdiagnosis this replaced: telling a user their own managed daemon
      // was started outside PortOS points them at the wrong fix.
      expect(result.reason).not.toMatch(/outside PortOS/);
    });

    it('refuses when nothing is running, since there is no checkpoint to reuse', async () => {
      const result = await relaunchMtplxServerWithTuning({ depth: 3 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/not running/);
      expect(execPm2Calls.some((a) => a[0] === 'start')).toBe(false);
    });

    // `model: null` means the running server is on MTPLX's OWN hard-coded
    // default. Restarting with null re-runs the cache resolution, which picks a
    // checkpoint — so the relaunch would serve a different model than the one
    // being measured, and file the reading under the wrong one.
    it('refuses when the launch line names no checkpoint it could reproduce', async () => {
      vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: null, error: 'mtplx models timed out' });
      await startMtplxServer();
      answerOnceRunning();
      execPm2Calls.length = 0;

      const result = await relaunchMtplxServerWithTuning({ depth: 3 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/own default checkpoint/);
      // Refused BEFORE stopping it — the server the user has is left alone.
      expect(execPm2Calls.map(([verb]) => verb)).not.toContain('delete');
      expect(execPm2Calls.map(([verb]) => verb)).not.toContain('start');
      expect(pm2State?.status).toBe('online');
    });

    it('will not stop a server PortOS did not start', async () => {
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });
      const result = await relaunchMtplxServerWithTuning({ depth: 3 });
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/started outside PortOS/);
      expect(execPm2Calls.some((a) => a[0] === 'delete')).toBe(false);
    });

    // `applied: true` on an empty request would claim a configuration nobody
    // asked for — and a knob that normalized away leaves nothing to apply.
    it('makes no claim when there is no knob to apply', async () => {
      await startMtplxServer();
      execPm2Calls.length = 0;
      expect((await relaunchMtplxServerWithTuning({})).applied).toBe(false);
      expect((await relaunchMtplxServerWithTuning({ maxKvSize: 8192 })).applied).toBe(false);
      expect(execPm2Calls.some((a) => a[0] === 'start')).toBe(false);
    });

    // A PortOS restart re-adopts a live PM2 process by reading its argv back.
    // Losing the tuning there would make the next relaunch drop flags the
    // server is demonstrably running with.
    it('recovers the tuning from the launch line of a re-adopted process', async () => {
      pm2State = {
        name: MTPLX_APP,
        status: 'online',
        pid: 4242,
        args: ['serve', '--port', '8010', '--model', 'Example/Qwen-MTP', '--depth', '5', '--kv-quant', 'q8'],
      };
      const status = await getMtplxServerStatus();
      expect(status.config.tuning).toEqual({ depth: 5, kvQuant: 'q8' });
    });

    // Reading a running process is not user input: clamping a value into the
    // catalog's range would report `--depth 8` as `--depth 8`'s clamped cousin
    // and hand THAT to a restore, while the daemon demonstrably runs the
    // original. Installs upgrade independently, so a launch line predating a
    // tightened bound is exactly the case this hits.
    it('drops a re-adopted value outside the declared range instead of clamping it', async () => {
      pm2State = {
        name: MTPLX_APP,
        status: 'online',
        pid: 4242,
        args: ['serve', '--port', '8000', '--model', 'Example/Qwen-MTP', '--depth', '99', '--kv-quant', 'q8'],
      };
      const status = await getMtplxServerStatus();
      expect(status.config.tuning).toEqual({ kvQuant: 'q8' });
      expect(status.tuningFlags).toEqual(['--kv-quant', 'q8']);
    });
  });

  describe('installMtplx', () => {
    beforeEach(() => {
      vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: true });
    });

    it('installs from upstream\'s Homebrew tap, never the privileged fan-control helper', async () => {
      vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);
      const result = await installMtplx();
      expect(result.success).toBe(true);
      const [cmd, args] = streamingSpawn.runStreamingCommand.mock.calls[0];
      expect(cmd).toBe('brew');
      expect(args).toEqual(['install', 'youssofal/mtplx/mtplx']);
      // `mtplx max --install` is upstream's one privileged path (a sudo fan
      // controller). It stays an explicit operator action outside PortOS.
      expect(streamingSpawn.runStreamingCommand.mock.calls.flatMap(([, a]) => a)).not.toContain('max');
    });

    it('falls back to pip on a host without Homebrew', async () => {
      vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd !== 'brew');
      await installMtplx();
      expect(streamingSpawn.runStreamingCommand.mock.calls[0][0]).toBe('python3');
    });

    it('refuses on a host that cannot run MLX at all', async () => {
      vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(false);
      await expect(installMtplx()).rejects.toThrow(/macOS with Apple Silicon/);
      expect(streamingSpawn.runStreamingCommand).not.toHaveBeenCalled();
    });
  });

  describe('stopMtplxServer', () => {
    it('deletes the PM2 process it manages', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      await startMtplxServer();
      const result = await stopMtplxServer();
      expect(result.success).toBe(true);
      expect(pm2State).toBeNull();
    });

    it('will not claim to stop a server PortOS did not start', async () => {
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });
      const result = await stopMtplxServer();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/external process/i);
    });

    it('is a no-op when nothing is running', async () => {
      const result = await stopMtplxServer();
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/not running/i);
    });
  });

  // ===========================================================================
  // LAZY START
  // ===========================================================================
  //
  // MTPLX cannot unload its checkpoint in place (its `--retrieval-idle-timeout`
  // covers retrieval models only), so the idle reaper stops the whole process
  // and the next PortOS request has to bring it back. There is no Start button
  // any more — this IS how MTPLX starts.
  describe('ensureMtplxRunning', () => {
    const startCalls = () => execPm2Calls.filter((c) => c[0] === 'start');

    beforeEach(() => {
      // A lazy start that never answers waits out the READINESS budget, not the
      // startup one — five real minutes by default. Shorten it here rather than
      // in the shared setup, which the give-up-path tests below depend on.
      resetForTest();
    });

    it('is a no-op when the daemon is already online', async () => {
      pm2State = { name: MTPLX_APP, status: 'online', pid: 777, args: ['serve', '--port', '8000'] };

      const result = await ensureMtplxRunning();

      expect(result).toEqual({ ready: true, reason: null });
      expect(startCalls()).toHaveLength(0);
    });

    it('starts a stopped daemon and reports ready once it answers', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      // Not answering yet at the guard probe, answering by the readiness poll —
      // the ordinary cold-start shape for a multi-gigabyte MLX checkpoint.
      const probe = vi.spyOn(openAiModelsProbe, 'probeOpenAiModels');
      probe.mockResolvedValueOnce({ reachable: false })   // ensureMtplxRunning's "is someone else serving?" guard
        .mockResolvedValueOnce({ reachable: false })      // startMtplxServer's port-collision guard
        .mockResolvedValue({ reachable: true });          // startup poll

      const result = await ensureMtplxRunning();

      expect(result.ready).toBe(true);
      expect(startCalls()).toHaveLength(1);
    });

    // A server the user started outside PortOS answers on the port but has no
    // PM2 entry. Starting our own would collide, so back off and use it.
    it('does not start anything when something else already serves the port', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });

      const result = await ensureMtplxRunning();

      expect(result).toEqual({ ready: true, reason: null });
      expect(startCalls()).toHaveLength(0);
    });

    it('reports the reason rather than throwing when the start fails', async () => {
      // No binary on PATH — `startMtplxServer` throws a ServerError, and a
      // caller sitting in front of an inference request must get a reason back,
      // not an exception through its stack.
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

      const result = await ensureMtplxRunning();

      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/not found on PATH/);
    });

    it('relaunches on the checkpoint and port the recovered config names', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      // Seed the recovered config the way a PortOS restart under a live daemon
      // would, then stop it — the relaunch must reuse that line, not guess.
      pm2State = { name: MTPLX_APP, status: 'online', pid: 5, args: ['serve', '--port', '8123', '--model', 'Example/Chosen-MTP'] };
      await getMtplxServerStatus();
      pm2State = null;

      await ensureMtplxRunning();

      const args = startCalls()[0].slice(startCalls()[0].indexOf('--') + 1);
      expect(args).toContain('8123');
      expect(args).toContain('Example/Chosen-MTP');
    });

    // The saved port is the ONLY record of where MTPLX belongs once PortOS has
    // restarted with it stopped — probing the default port instead would miss a
    // server already on the saved one and then collide with it on start.
    it('probes the saved port, not the default, when there is no recovered config', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      const settings = await import('./settings.js');
      vi.spyOn(settings, 'getSettings').mockResolvedValue({ localLlm: { mtplx: { launch: { port: 8010 } } } });
      const probe = vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });

      const result = await ensureMtplxRunning();

      expect(result.ready).toBe(true);
      expect(probe).toHaveBeenCalledWith('http://127.0.0.1:8010/v1', expect.anything());
      expect(startCalls()).toHaveLength(0);
    });

    it('marks the daemon used, so a request resets the idle clock', async () => {
      pm2State = { name: MTPLX_APP, status: 'online', pid: 777, args: ['serve', '--port', '8000'] };
      const { daemonLastUsedAt } = await import('../lib/managedDaemon.js');

      const before = daemonLastUsedAt(MTPLX_APP);
      await new Promise((r) => setTimeout(r, 2));
      await ensureMtplxRunning();

      expect(daemonLastUsedAt(MTPLX_APP)).toBeGreaterThan(before);
    });
  });

  describe('isMtplxProvider', () => {
    it('matches a local MTPLX endpoint', () => {
      expect(isMtplxProvider({ type: 'api', endpoint: 'http://127.0.0.1:8000/v1', id: 'mtplx', mtplxBacked: true })).toBe(true);
    });

    // An MTPLX on a tailnet peer is someone else's process — PortOS must
    // neither start it nor count its traffic against this install's idle window.
    it('does not match an MTPLX on another machine', () => {
      expect(isMtplxProvider({ type: 'api', endpoint: 'http://100.64.0.5:8000/v1', id: 'mtplx', mtplxBacked: true })).toBe(false);
    });

    it('does not match a CLI provider', () => {
      expect(isMtplxProvider({ type: 'cli', endpoint: 'http://127.0.0.1:8000/v1', id: 'mtplx', mtplxBacked: true })).toBe(false);
    });

    it('matches an MTPLX-backed TUI provider', () => {
      expect(isMtplxProvider({ type: 'tui', endpoint: 'http://127.0.0.1:8000/v1', id: 'mtplx-tui', mtplxBacked: true })).toBe(true);
    });
  });

  describe('ensureMtplxProviderReady', () => {
    it('passes through a provider that is not MTPLX without touching PM2', async () => {
      const result = await ensureMtplxProviderReady({ type: 'api', endpoint: 'https://api.example.com/v1', id: 'remote' });

      expect(result).toEqual({ success: true });
      expect(execPm2Calls.filter((c) => c[0] === 'start')).toHaveLength(0);
    });

    it('surfaces a failed lazy start as an error the caller can report', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

      const result = await ensureMtplxProviderReady({ type: 'api', endpoint: 'http://127.0.0.1:8000/v1', id: 'mtplx', mtplxBacked: true });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found on PATH/);
    });
  });

});
