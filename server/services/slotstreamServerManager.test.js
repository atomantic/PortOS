import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The manager reaches settings through a dynamic `import('./settings.js')` for
// both the saved launch line and the idle window. Backing it with an in-memory
// store keeps the launch-line round-trip (start → persist → status) assertable
// without the suite reading or writing an install's real settings file.
const settingsStore = vi.hoisted(() => ({ current: {} }));
vi.mock('./settings.js', () => ({
  getSettings: async () => settingsStore.current,
  updateSettingsWith: async (mutate) => {
    settingsStore.current = await mutate(settingsStore.current);
    return settingsStore.current;
  },
}));

import {
  getSlotstreamServerStatus,
  startSlotstreamServer,
  stopSlotstreamServer,
  installSlotstream,
  _resetSlotstreamServerStateForTests,
  ensureSlotstreamRunning,
  isSlotstreamProvider,
  SLOTSTREAM_APP,
} from './slotstreamServerManager.js';
import * as processEnv from '../lib/processEnv.js';
import * as platform from '../lib/platform.js';
import * as openAiModelsProbe from '../lib/openAiModelsProbe.js';
import * as slotstreamModels from '../lib/slotstreamModels.js';
import * as pm2Module from './pm2.js';
import * as commandExistsModule from '../lib/commandExists.js';
import * as streamingSpawn from '../lib/streamingSpawn.js';
import { PORTS } from '../lib/ports.js';

const BINARY = '/opt/homebrew/bin/slotstream';
const cachedModel = (id) => ({ id, path: `/tmp/${id}` });
const FAST_TIMING = {
  startupWait: 50,
  startupPoll: 0,
  relaunchReadyTimeout: 30,
  relaunchPoll: 0,
};
const resetForTest = (overrides = {}) => {
  _resetSlotstreamServerStateForTests({ ...FAST_TIMING, ...overrides });
};

describe('slotstreamServerManager', () => {
  let pm2State = null;
  let execPm2Calls = [];
  let testLogDir = null;

  beforeEach(async () => {
    testLogDir = await mkdtemp(join(tmpdir(), 'portos-slotstream-test-'));
    resetForTest({
      logFiles: {
        stdout: join(testLogDir, 'portos-slotstream-out.log'),
        stderr: join(testLogDir, 'portos-slotstream-error.log'),
      },
    });
    vi.restoreAllMocks();
    pm2State = null;
    execPm2Calls = [];
    settingsStore.current = {};

    vi.spyOn(platform, 'isPortInUse').mockResolvedValue(false);
    vi.spyOn(openAiModelsProbe, 'probeOpenAiModels')
      .mockImplementation(async () => ({ reachable: pm2State?.status === 'online' }));
    vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(true);
    vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue([]);
    vi.spyOn(slotstreamModels, 'listSlotstreamCachedModels').mockResolvedValue({
      models: [cachedModel('qwen-moe')],
      error: null,
    });

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
    _resetSlotstreamServerStateForTests();
    vi.restoreAllMocks();
    await rm(testLogDir, { recursive: true, force: true });
    testLogDir = null;
  });

  describe('getSlotstreamServerStatus', () => {
    it('reports not installed when the binary is not on PATH', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      const status = await getSlotstreamServerStatus();
      expect(status.installed).toBe(false);
      expect(status.running).toBe(false);
      expect(status.cacheError).toBeNull();
      expect(status.memoryPlan).toEqual(expect.objectContaining({
        targetGb: expect.any(Number),
        expectedPeakGb: expect.any(Number),
        expectedWarmDecodeToks: expect.any(Number),
      }));
    });

    it('surfaces the cached checkpoints an installed Slotstream can be started on', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      const status = await getSlotstreamServerStatus();
      expect(status.installed).toBe(true);
      expect(status.cachedModels).toEqual(['qwen-moe']);
      expect(status.endpoint).toBe(`http://127.0.0.1:${PORTS.SLOTSTREAM}/v1`);
    });

    it('reports the platform gate only when nothing is installed here', async () => {
      vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(false);
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      expect((await getSlotstreamServerStatus()).supported).toBe(false);

      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      const installed = await getSlotstreamServerStatus();
      expect(installed.supported).toBe(true);
      expect(installed.unsupportedReason).toBeNull();
    });

    it('flags the process as boot-persisted only when the PM2 dump names it', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      expect((await getSlotstreamServerStatus()).runAtStartup).toBe(false);
      vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue([SLOTSTREAM_APP]);
      expect((await getSlotstreamServerStatus()).runAtStartup).toBe(true);
    });
  });

  describe('startSlotstreamServer', () => {
    beforeEach(() => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
    });

    it('starts `slotstream serve` under PM2 on a cached checkpoint with an explicit port', async () => {
      const result = await startSlotstreamServer();
      expect(result.success).toBe(true);
      expect(result.managed).toBe(true);
      expect(result.endpoint).toBe(`http://127.0.0.1:${PORTS.SLOTSTREAM}/v1`);

      const start = execPm2Calls.find((args) => args[0] === 'start');
      expect(start[start.indexOf('--name') + 1]).toBe(SLOTSTREAM_APP);
      const launch = start.slice(start.indexOf('--') + 1);
      expect(launch[0]).toBe('serve');
      expect(launch[launch.indexOf('--port') + 1]).toBe(String(PORTS.SLOTSTREAM));
      expect(launch).toContain('--memory-gb');
      expect(launch).toContain('--model');
      expect(launch[launch.indexOf('--model') + 1]).toBe('qwen-moe');
    });

    it('persists an explicit memory-cap override on the launch line', async () => {
      const result = await startSlotstreamServer({ memoryGb: 22 });
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch[launch.indexOf('--memory-gb') + 1]).toBe('22');
      expect(result.config.memoryGb).toBe(22);
      expect(result.memoryPlan.auto).toBe(false);
    });

    it('saves the cap an explicit start used, so the on-demand restart replays it', async () => {
      // Started from the card WITHOUT pressing "Save configuration": before the
      // launch line was persisted here, the idle reaper's restart re-sized from
      // host RAM and silently discarded the cap the user chose.
      await startSlotstreamServer({ memoryGb: 22 });
      expect(settingsStore.current.localLlm.slotstream.launch.memoryGb).toBe(22);

      await stopSlotstreamServer();
      execPm2Calls = [];
      await ensureSlotstreamRunning();
      const relaunch = execPm2Calls.find((a) => a[0] === 'start');
      expect(relaunch[relaunch.indexOf('--memory-gb') + 1]).toBe('22');
    });

    it('records an auto-sized start as auto, not as a cap the user chose', async () => {
      // `--memory-gb` is on the launch line either way, so the saved override is
      // the only thing that can tell them apart — reading the arg back would
      // report every auto start as an explicit cap.
      await startSlotstreamServer();
      expect(settingsStore.current.localLlm.slotstream.launch.memoryGb).toBeNull();
      expect((await getSlotstreamServerStatus()).memoryPlan.auto).toBe(true);
    });

    it('refuses Ollama\'s default port instead of colliding with a managed Ollama', async () => {
      const err = await startSlotstreamServer({ port: 11434 }).catch((e) => e);
      expect(err.message).toMatch(/11434/);
      expect(err.message).toMatch(/Ollama/);
      expect(execPm2Calls.some((args) => args[0] === 'start')).toBe(false);
    });

    it('refuses with an in-app fix when the cache was read and is empty', async () => {
      vi.spyOn(slotstreamModels, 'listSlotstreamCachedModels').mockResolvedValue({ models: [], error: null });
      const err = await startSlotstreamServer().catch((e) => e);
      expect(err.message).toMatch(/never downloads weights|no model weights cached/i);
      expect(err.message).not.toMatch(/terminal/);
      expect(execPm2Calls.some((args) => args[0] === 'start')).toBe(false);
    });

    it('refuses an explicit checkpoint that is not cached, rather than letting the runtime fetch it', async () => {
      const err = await startSlotstreamServer({ model: 'not-on-disk' }).catch((e) => e);
      expect(err.message).toMatch(/never downloads weights/i);
      expect(err.message).toMatch(/qwen-moe/);
      expect(execPm2Calls.some((args) => args[0] === 'start')).toBe(false);
    });

    it('refuses to start on a host the runtime does not support', async () => {
      vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(false);
      await expect(startSlotstreamServer()).rejects.toThrow(/Apple Silicon/);
      expect(execPm2Calls.some((args) => args[0] === 'start')).toBe(false);
    });

    it('refuses rather than launching onto a bound port', async () => {
      vi.spyOn(platform, 'isPortInUse').mockResolvedValue(true);
      await expect(startSlotstreamServer()).rejects.toThrow(/already in use/);
    });

    it('refuses when the binary is not installed', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      await expect(startSlotstreamServer()).rejects.toThrow(/not found/);
    });
  });

  describe('installSlotstream', () => {
    beforeEach(() => {
      vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: true });
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      vi.spyOn(slotstreamModels, 'slotstreamBinDir').mockReturnValue(testLogDir);
    });

    it('installs the Apple Silicon release via GitHub CLI, never a remote shell script', async () => {
      vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);
      const result = await installSlotstream();
      expect(result.success).toBe(true);
      const [cmd, args] = streamingSpawn.runStreamingCommand.mock.calls[0];
      expect(cmd).toBe('gh');
      expect(args).toEqual(expect.arrayContaining(['release', 'download', '--repo', 'carloslfu/slotstream']));
      expect(streamingSpawn.runStreamingCommand.mock.calls.flat().join(' ')).not.toMatch(/install\.sh/);
    });

    it('refuses on a host that cannot run it', async () => {
      vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(false);
      await expect(installSlotstream()).rejects.toThrow(/macOS with Apple Silicon/);
      expect(streamingSpawn.runStreamingCommand).not.toHaveBeenCalled();
    });
  });

  describe('stopSlotstreamServer', () => {
    it('deletes the PM2 process it manages', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      await startSlotstreamServer();
      const result = await stopSlotstreamServer();
      expect(result.success).toBe(true);
      expect(pm2State).toBeNull();
    });

    it('will not claim to stop a server PortOS did not start', async () => {
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });
      const result = await stopSlotstreamServer();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/external process/i);
    });
  });

  describe('ensureSlotstreamRunning', () => {
    it('is a no-op when the daemon is already online', async () => {
      pm2State = { name: SLOTSTREAM_APP, status: 'online', pid: 777, args: ['serve', '--port', String(PORTS.SLOTSTREAM)] };
      const result = await ensureSlotstreamRunning();
      expect(result).toEqual({ ready: true, reason: null });
      expect(execPm2Calls.filter((c) => c[0] === 'start')).toHaveLength(0);
    });

    it('reports the reason rather than throwing when the start fails', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      const result = await ensureSlotstreamRunning();
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/not found/);
    });
  });

  describe('isSlotstreamProvider', () => {
    it('matches a local Slotstream endpoint on the dedicated port', () => {
      expect(isSlotstreamProvider({
        type: 'api',
        endpoint: `http://127.0.0.1:${PORTS.SLOTSTREAM}/v1`,
        id: 'slotstream',
      })).toBe(true);
    });

    it('does not match a Slotstream on another machine', () => {
      expect(isSlotstreamProvider({
        type: 'api',
        endpoint: `http://192.0.2.10:${PORTS.SLOTSTREAM}/v1`,
        id: 'slotstream',
      })).toBe(false);
    });
  });
});
