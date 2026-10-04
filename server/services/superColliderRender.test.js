import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SUPERCOLLIDER_IMAGE_LABELS,
  SUPERCOLLIDER_RENDER_WRAPPER_SOURCE,
} from '../lib/superColliderRuntime.js';
import { setupSuperColliderRuntime } from './superColliderRuntime.js';
import { readSuperColliderPreview, renderSuperColliderSource } from './superColliderRender.js';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';

const fixture = vi.hoisted(() => ({ admission: null, failedCleanupPath: null }));
vi.mock('../lib/maintenanceAdmission.js', async importOriginal => ({
  ...await importOriginal(),
  maintenance: new Proxy({}, { get: (_target, property) => fixture.admission[property] }),
}));
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, rm: async (path, options) => {
    if (path === fixture.failedCleanupPath) throw Object.assign(new Error('Cleanup denied'), { code: 'EACCES' });
    return actual.rm(path, options);
  } };
});

// Interleaved IEEE-float WAV — the format the render wrapper asks scsynth for.
function floatWav(seconds, amplitude, { channels = 2, sampleRate = 48000 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * channels * 4);
  for (let i = 0; i < frames * channels; i += 1) data.writeFloatLE(amplitude * Math.sin(i / 7), i * 4);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 4, 28); header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const STOCK_SOURCE = 'SynthDef(\\lead, { |out = 0, freq = 440, amp = 0.2| Out.ar(out, SinOsc.ar(freq ! 2) * amp * EnvGen.kr(Env.perc, doneAction: 2)) }).add;\nPbind(\\instrument, \\lead, \\degree, Pseq([0, 2, 4], inf), \\dur, 0.5)';

/**
 * A docker CLI double with the adapter's two methods. `run` hands the test the
 * HOST directories mounted at /in and /out plus the script argv, the same
 * contract the real container has; `render` decides what the "container" does.
 */
function fakeDocker({ render = defaultRender, containers = [] } = {}) {
  const calls = { runs: [], removed: [] };
  let image = null;
  const label = (args, key) => args.flatMap((arg, i) => (arg === '--label' && args[i + 1].startsWith(`${key}=`) ? [args[i + 1].slice(key.length + 1)] : []))[0];
  return {
    calls,
    capture: async (args) => {
      if (args[0] === 'version') return { success: true, stdout: JSON.stringify({ Client: { Version: '27.0.0' }, Server: { Version: '27.0.0', Os: 'linux', Arch: 'arm64' } }), stderr: '' };
      if (args[0] === 'image') return image ? { success: true, stdout: JSON.stringify(image), stderr: '' } : { success: false, stdout: '', stderr: 'No such image' };
      if (args[0] === 'ps') return { success: true, stdout: containers.map((row) => JSON.stringify(row)).join('\n'), stderr: '' };
      if (args[0] === 'rm') calls.removed.push(args[2]);
      return { success: true, stdout: '', stderr: '' };
    },
    stream: async (args, onLine, options) => {
      if (args[0] === 'build') {
        image = { Id: 'sha256:image-1', Os: 'linux', Architecture: 'arm64', Config: { Labels: {
          [SUPERCOLLIDER_IMAGE_LABELS.runtimeVersion]: label(args, SUPERCOLLIDER_IMAGE_LABELS.runtimeVersion),
          [SUPERCOLLIDER_IMAGE_LABELS.recipeHash]: label(args, SUPERCOLLIDER_IMAGE_LABELS.recipeHash),
        } } };
        return { success: true };
      }
      const mount = (target) => args.find((arg) => arg.includes(`,target=${target}`)).match(/source=(.*?),target=/)[1];
      const scriptAt = args.indexOf('-l') + 2;
      const run = {
        args, inputDir: mount('/in'), outputDir: mount('/out'), script: args[scriptAt], argv: args.slice(scriptAt + 1),
        name: args[args.indexOf('--name') + 1], onLine: (line) => onLine?.(line), isCancelled: options.isCancelled ?? (() => false),
      };
      if (run.script === '/in/smoke.scd') {
        writeFileSync(join(run.outputDir, 'smoke.wav'), floatWav(2, 0.25));
        return { success: true };
      }
      run.source = readFileSync(join(run.inputDir, 'source.scd'), 'utf8');
      calls.runs.push(run);
      return render(run);
    },
  };
}

function defaultRender(run) {
  writeFileSync(join(run.outputDir, 'render.wav'), floatWav(Number(run.argv[2]), 0.3));
  return { success: true };
}

const waitUntil = async (predicate) => {
  for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!predicate()) throw new Error('condition never became true');
};

describe('contained SuperCollider renders', () => {
  let dataDir;
  let jobSeq = 0;
  const jobsDir = () => join(dataDir, 'supercollider', 'jobs');
  const leftoverScratch = () => (existsSync(jobsDir()) ? readdirSync(jobsDir()) : []);
  const ready = async (docker) => {
    expect((await setupSuperColliderRuntime({ docker, dataDir })).outcome).toBe('ready');
    return docker;
  };
  const render = (docker, overrides = {}) => renderSuperColliderSource({
    jobId: `job-${(jobSeq += 1)}`, source: STOCK_SOURCE, durationSec: 4, seed: 42, docker, dataDir, ...overrides,
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'portos-sc-render-'));
    fixture.admission = createMaintenanceAdmission(dataDir);
    fixture.failedCleanupPath = null;
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('renders frozen source through the contained wrapper into a validated preview and leaves no scratch', async () => {
    const docker = await ready(fakeDocker());
    const preview = await render(docker, { jobId: 'job-ok', durationSec: 8 });

    const [run] = docker.calls.runs;
    expect(run.script).toBe('/in/render.scd');
    expect(run.source).toBe(STOCK_SOURCE);
    // The trusted runner supplies every path, the duration, the format, the seed and the tempo.
    expect(run.argv).toEqual(['/in/source.scd', '/out/render.wav', '8', '48000', '42', '0.5']);
    expect(run.args).toContain(`type=bind,source=${run.inputDir},target=/in,readonly`);
    expect(run.args[run.args.indexOf('--network') + 1]).toBe('none');
    // The verified image is pinned by id, not resolved by a mutable tag.
    expect(run.args).toContain('sha256:image-1');
    expect(docker.calls.removed).toContain(run.name);

    expect(preview).toMatchObject({
      jobId: 'job-ok', sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/), seed: 42,
      settings: { durationSec: 8, sampleRate: 48000, channels: 2, tempoBpm: 120 },
      measurement: { durationMs: 8000, channels: 2, sampleRate: 48000 },
    });
    const stored = await readSuperColliderPreview('job-ok', { dataDir });
    expect(stored.preview.source).toBe(STOCK_SOURCE);
    expect(readFileSync(stored.wavPath).length).toBeGreaterThan(8 * 48000 * 2 * 4);
    expect(leftoverScratch()).toEqual([]);
  });

  it('writes the shipped wrapper beside the source, never anything the source chose', async () => {
    let wrapper;
    const docker = await ready(fakeDocker({ render: (run) => {
      wrapper = readFileSync(join(run.inputDir, 'render.scd'), 'utf8');
      return defaultRender(run);
    } }));
    await render(docker, { source: '"/tmp/elsewhere.wav".postln; Pbind(\\dur, 1)' });
    expect(wrapper).toBe(SUPERCOLLIDER_RENDER_WRAPPER_SOURCE);
  });

  it('retains a recovery blocker when render scratch cannot be removed', async () => {
    const jobId = 'job-cleanup-failed';
    const docker = await ready(fakeDocker({ render: run => {
      fixture.failedCleanupPath = join(jobsDir(), jobId);
      return defaultRender(run);
    } }));
    const permit = fixture.admission.admit('media', jobId);
    fixture.admission.begin({ reason: 'Drain audio render', owner: 'Operator' });
    await permit.run(() => render(docker, { jobId }));
    await permit.finish();
    expect(fixture.admission.status()).toMatchObject({
      state: 'draining', blockers: [expect.objectContaining({ resource: jobId, unsettled: true })],
    });
    expect(leftoverScratch()).toEqual([jobId]);
  });

  it('reports a syntax error with sclang\'s location and publishes nothing', async () => {
    const docker = await ready(fakeDocker({ render: (run) => {
      run.onLine('PORTOS_PHASE compiling');
      run.onLine('ERROR: syntax error, unexpected BINOP, expecting $end');
      run.onLine('  line 2 char 7:');
      run.onLine('PORTOS_RENDER_ERROR syntax: the source has a syntax error');
      return { success: false, error: 'exit 65: the source has a syntax error' };
    } }));
    await expect(render(docker, { jobId: 'job-syntax' })).rejects.toMatchObject({
      code: 'SUPERCOLLIDER_SYNTAX_ERROR', message: expect.stringContaining('line 2 char 7'),
    });
    expect(await readSuperColliderPreview('job-syntax', { dataDir })).toBeNull();
    expect(docker.calls.removed).toContain(docker.calls.runs[0].name);
    expect(leftoverScratch()).toEqual([]);
  });

  it('turns a wall-time kill into a timeout and still removes the container and its partial output', async () => {
    const docker = await ready(fakeDocker({ render: (run) => {
      writeFileSync(join(run.outputDir, 'render.wav'), Buffer.from('partial'));
      return { success: false, error: 'timed out after 1s' };
    } }));
    await expect(render(docker, { jobId: 'job-slow', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'SUPERCOLLIDER_TIMEOUT' });
    expect(docker.calls.removed).toContain(docker.calls.runs[0].name);
    expect(await readSuperColliderPreview('job-slow', { dataDir })).toBeNull();
    expect(leftoverScratch()).toEqual([]);
  });

  it('cancels a running render: the container is stopped and removed and nothing is published', async () => {
    const docker = await ready(fakeDocker({ render: async (run) => {
      writeFileSync(join(run.outputDir, 'render.wav'), floatWav(1, 0.3));
      await waitUntil(run.isCancelled);
      return { success: false, error: 'cancelled' };
    } }));
    const controller = new AbortController();
    const pending = render(docker, { jobId: 'job-cancel', signal: controller.signal });
    await waitUntil(() => docker.calls.runs.length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'SUPERCOLLIDER_CANCELED' });
    expect(docker.calls.removed).toContain(docker.calls.runs[0].name);
    expect(await readSuperColliderPreview('job-cancel', { dataDir })).toBeNull();
    expect(leftoverScratch()).toEqual([]);
  });

  it('stops a render that floods its output directory', async () => {
    const docker = await ready(fakeDocker({ render: async (run) => {
      for (let i = 0; i < 40; i += 1) writeFileSync(join(run.outputDir, `junk-${i}.bin`), 'x');
      await waitUntil(run.isCancelled);
      return { success: false, error: 'cancelled' };
    } }));
    await expect(render(docker)).rejects.toMatchObject({ code: 'SUPERCOLLIDER_OUTPUT_QUOTA' });
    expect(leftoverScratch()).toEqual([]);
  });

  it.each([
    ['mono', (out) => writeFileSync(join(out, 'render.wav'), floatWav(4, 0.3, { channels: 1 }))],
    ['44.1 kHz', (out) => writeFileSync(join(out, 'render.wav'), floatWav(4, 0.3, { sampleRate: 44100 }))],
    ['silent', (out) => writeFileSync(join(out, 'render.wav'), floatWav(4, 0))],
    ['too short', (out) => writeFileSync(join(out, 'render.wav'), floatWav(2, 0.3))],
    ['not audio', (out) => writeFileSync(join(out, 'render.wav'), Buffer.from('#!/bin/sh\necho hi\n'))],
    ['missing', () => {}],
    // A symlink would point the host at its own files; it must never be followed.
    ['a symlink to a host file', (out, fixture) => symlinkSync(fixture, join(out, 'render.wav'))],
  ])('rejects %s output without publishing a preview', async (_label, write) => {
    const fixture = join(dataDir, 'host-fixture.wav');
    writeFileSync(fixture, floatWav(4, 0.3));
    const docker = await ready(fakeDocker({ render: (run) => {
      write(run.outputDir, fixture);
      return { success: true };
    } }));
    await expect(render(docker, { jobId: 'job-bad' })).rejects.toMatchObject({ code: 'SUPERCOLLIDER_OUTPUT_INVALID' });
    expect(await readSuperColliderPreview('job-bad', { dataDir })).toBeNull();
    expect(leftoverScratch()).toEqual([]);
  });

  it('keeps overlapping renders isolated: separate snapshots, mounts and outputs', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const docker = await ready(fakeDocker({ render: async (run) => {
      await gate;
      return defaultRender(run);
    } }));
    const first = render(docker, { jobId: 'job-a', source: `${STOCK_SOURCE} // a`, durationSec: 4 });
    const second = render(docker, { jobId: 'job-b', source: `${STOCK_SOURCE} // b`, durationSec: 6 });
    await waitUntil(() => docker.calls.runs.length === 2);
    release();
    const [a, b] = await Promise.all([first, second]);

    const [runA, runB] = docker.calls.runs.sort((x, y) => x.source.localeCompare(y.source));
    expect(runA.inputDir).not.toBe(runB.inputDir);
    expect(runA.outputDir).not.toBe(runB.outputDir);
    expect([runA.source.endsWith('// a'), runB.source.endsWith('// b')]).toEqual([true, true]);
    expect(a.measurement.durationMs).toBe(4000);
    expect(b.measurement.durationMs).toBe(6000);
    expect(a.sourceHash).not.toBe(b.sourceHash);
    expect(leftoverScratch()).toEqual([]);
  });

  it('refuses with the setup action when the runtime is not ready, without starting a container', async () => {
    const docker = fakeDocker();
    await expect(render(docker)).rejects.toMatchObject({ code: 'SUPERCOLLIDER_UNAVAILABLE', status: 409 });
    expect(docker.calls.runs).toEqual([]);
  });

  it('sweeps containers and scratch a crashed process left behind, but not a run that could still be live', async () => {
    const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC');
    const docker = await ready(fakeDocker({ containers: [
      { Names: 'portos-sc-orphan', CreatedAt: stamp(60 * 60_000) },
      { Names: 'portos-sc-live', CreatedAt: stamp(5_000) },
    ] }));
    const stale = join(jobsDir(), 'job-from-a-crash');
    const fresh = join(jobsDir(), 'job-another-process-is-running');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, anHourAgo, anHourAgo);

    await render(docker);
    expect(docker.calls.removed).toContain('portos-sc-orphan');
    expect(docker.calls.removed).not.toContain('portos-sc-live');
    expect(leftoverScratch()).toEqual(['job-another-process-is-running']);
  });
});
