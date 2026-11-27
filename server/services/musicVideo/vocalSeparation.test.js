import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANCEL_ALREADY_TERMINAL } from '../../lib/cancelResponse.js';
import {
  attachVocalSeparationSseClient, cancelVocalSeparation, getActiveVocalSeparationJobId, startVocalSeparation,
} from './vocalSeparation.js';

vi.mock('./projects.js', () => ({ getProject: vi.fn() }));
vi.mock('./demucsRuntime.js', async (importOriginal) => {
  const actual = await importOriginal();
  const plan = actual._demucsRuntimePlan({ platform: 'linux', arch: 'x64' });
  return { ...actual, ensureDemucsRuntime: (options) => actual.ensureDemucsRuntime({ ...options, plan }) };
});

const projectId = 'project';
const audioPath = join(tmpdir(), 'example-song.wav');
const project = { id: projectId, name: 'Example Video', trackId: 'song' };
const updated = { ...project, vocalStemFilename: 'vocals.wav' };
const success = { success: true };

const nextTerminalFrame = (jobId) => {
  const { promise, resolve } = Promise.withResolvers();
  const req = new EventEmitter();
  const res = {
    req, writeHead: vi.fn(), end: vi.fn(),
    write: (data) => {
      const frame = JSON.parse(data.slice('data: '.length));
      if (frame.type !== 'progress') {
        req.emit('close');
        resolve(frame);
      }
    },
  };
  expect(attachVocalSeparationSseClient(jobId, res)).toBe(true);
  return promise;
};

function dependencies(run) {
  return {
    getProject: vi.fn(async () => project),
    resolveMaster: vi.fn(async () => audioPath),
    attachVocalStem: vi.fn(async (_id, { tempPath }) => {
      expect(existsSync(tempPath)).toBe(true);
      return updated;
    }),
    resolveBasePython: async () => 'python3.11',
    cudaAvailable: async () => true,
    run: vi.fn(run),
  };
}

function writeVocals(args) {
  return writeFile(join(args[args.indexOf('-o') + 1], 'vocals.wav'), 'fixture');
}

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portos-vocal-test-'));
  vi.stubEnv('PORTOS_DEMUCS_VENV_DIR', dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('vocal-separation lifecycle', () => {
  it('reuses an active job and publishes the stem after accelerator failure and CPU retry', async () => {
    const accelerator = Promise.withResolvers();
    const deps = dependencies(async (_bin, args) => {
      if (!args.includes('demucs')) return success;
      if (args[args.indexOf('-d') + 1] !== 'cpu') return accelerator.promise;
      await writeVocals(args);
      return success;
    });
    const { jobId } = await startVocalSeparation(projectId, { deps });
    const terminal = nextTerminalFrame(jobId);
    expect(getActiveVocalSeparationJobId(projectId)).toBe(jobId);
    await expect(startVocalSeparation(projectId, { deps })).resolves.toEqual({ jobId, reused: true });
    accelerator.resolve({ success: false, error: 'fixture accelerator failure' });

    await expect(terminal).resolves.toEqual({ type: 'complete', project: updated });
    const devices = deps.run.mock.calls.filter(([, args]) => args.includes('demucs'))
      .map(([, args]) => args[args.indexOf('-d') + 1]);
    expect(devices).toEqual([expect.stringMatching(/^(cuda|mps)$/), 'cpu']);
    expect(deps.attachVocalStem).toHaveBeenCalledExactlyOnceWith(projectId, {
      tempPath: expect.stringMatching(/vocals\.wav$/), originalName: 'Example-Video-vocals.wav', sourcePath: audioPath,
    });
    expect(getActiveVocalSeparationJobId(projectId)).toBeNull();
    expect(cancelVocalSeparation(jobId)).toBe(CANCEL_ALREADY_TERMINAL);
  });

  it.each(['venv', 'pip'])('cancels during %s without waiting for the child to close', async (stage) => {
    const started = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const deps = dependencies(async (_bin, args, _onLine, { signal }) => {
      if (!args.includes(stage)) return success;
      started.resolve(signal);
      return closed.promise;
    });
    const { jobId } = await startVocalSeparation(projectId, { deps });
    const terminal = nextTerminalFrame(jobId);
    const signal = await started.promise;

    try {
      expect(cancelVocalSeparation(jobId)).toBe(true);
      await expect(terminal).resolves.toEqual({ type: 'canceled' });
      expect(signal.aborted).toBe(true);
      expect(getActiveVocalSeparationJobId(projectId)).toBeNull();
      expect(deps.attachVocalStem).not.toHaveBeenCalled();
    } finally {
      closed.resolve({ success: false, error: 'cancelled' });
    }
  });

  it('rejects the stem when the project song changes before attachment', async () => {
    const deps = dependencies(async (_bin, args) => {
      if (args.includes('demucs')) await writeVocals(args);
      return success;
    });
    deps.getProject.mockResolvedValueOnce(project).mockResolvedValue({ ...project, trackId: 'replacement-song' });
    const { jobId } = await startVocalSeparation(projectId, { deps });

    await expect(nextTerminalFrame(jobId)).resolves.toMatchObject({ type: 'error', code: 'MUSIC_VIDEO_AUDIO_CHANGED' });
    expect(deps.attachVocalStem).not.toHaveBeenCalled();
    expect(getActiveVocalSeparationJobId(projectId)).toBeNull();
  });
});
