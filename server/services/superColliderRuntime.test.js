import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SUPERCOLLIDER_IMAGE_LABELS, SUPERCOLLIDER_RUNTIME_VERSION } from '../lib/superColliderRuntime.js';
import { getSuperColliderStatus, setupSuperColliderRuntime } from './superColliderRuntime.js';

// Interleaved int16 stereo WAV at 48 kHz.
function stereoWav(seconds, amplitude) {
  const frames = Math.round(seconds * 48000);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i += 1) data.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(i / 9)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(48000 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * A docker CLI double with the adapter's two methods. It keeps one image,
 * "builds" it from the labels it is handed, and on `run` lets `render` write
 * into the host directory mounted at /out — the same contract the real
 * container has.
 */
function fakeDocker({ running = true, render = (out) => writeFileSync(join(out, 'smoke.wav'), stereoWav(2, 0.25)), runResult = { success: true } } = {}) {
  const calls = [];
  let image = null;
  let builds = 0;
  const label = (args, key) => args.flatMap((arg, i) => (arg === '--label' && args[i + 1].startsWith(`${key}=`) ? [args[i + 1].slice(key.length + 1)] : []))[0];
  return {
    calls,
    capture: async (args) => {
      calls.push(args[0] === 'image' ? 'inspect' : args[0]);
      if (args[0] === 'version') {
        return running
          ? { success: true, stdout: JSON.stringify({ Client: { Version: '27.0.0' }, Server: { Version: '27.0.0', Os: 'linux', Arch: 'arm64' } }), stderr: '' }
          : { success: false, code: 1, stdout: JSON.stringify({ Client: { Version: '27.0.0' }, Server: null }), stderr: 'Cannot connect to the Docker daemon' };
      }
      if (args[0] === 'image') {
        return image ? { success: true, stdout: JSON.stringify(image), stderr: '' } : { success: false, code: 1, stdout: '', stderr: 'No such image' };
      }
      return { success: true, stdout: '', stderr: '' }; // rm --force
    },
    stream: async (args) => {
      calls.push(args[0]);
      if (args[0] === 'build') {
        builds += 1;
        image = {
          Id: `sha256:image-${builds}`, Os: 'linux', Architecture: 'arm64', Size: 300e6,
          Config: { Labels: {
            [SUPERCOLLIDER_IMAGE_LABELS.runtimeVersion]: label(args, SUPERCOLLIDER_IMAGE_LABELS.runtimeVersion),
            [SUPERCOLLIDER_IMAGE_LABELS.recipeHash]: label(args, SUPERCOLLIDER_IMAGE_LABELS.recipeHash),
          } },
        };
        return { success: true };
      }
      const out = args.find((arg) => arg.endsWith('target=/out')).match(/source=(.*),target=\/out$/)[1];
      calls.runArgs = args;
      render(out);
      return runResult;
    },
  };
}

describe('SuperCollider runtime setup', () => {
  let dataDir;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'portos-supercollider-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const evidencePath = () => join(dataDir, 'supercollider', 'runtime-evidence.json');

  it('builds and proves the runtime once, then a second setup skips both', async () => {
    const docker = fakeDocker();
    expect((await getSuperColliderStatus({ docker, dataDir })).state).toBe('image-missing');

    const first = await setupSuperColliderRuntime({ docker, dataDir });
    expect(first).toMatchObject({ outcome: 'ready', built: true, probed: true, status: { state: 'ready' } });
    expect(first.status.smoke.measurement).toMatchObject({ durationMs: 2000, channels: 2, sampleRate: 48000 });
    expect(docker.calls.filter((call) => call === 'build' || call === 'run')).toEqual(['build', 'run']);
    // The probe runs against the exact image it certifies, under the shared policy.
    expect(docker.calls.runArgs).toEqual(expect.arrayContaining(['sha256:image-1', '--network', 'none', '/in/smoke.scd', '/out/smoke.wav', '2', '48000']));
    expect(docker.calls).toContain('rm');
    // The job directory is gone; only the evidence remains.
    expect(readdirSync(join(dataDir, 'supercollider', 'jobs'))).toEqual([]);

    docker.calls.length = 0;
    const second = await setupSuperColliderRuntime({ docker, dataDir });
    expect(second).toMatchObject({ outcome: 'ready', built: false, probed: false });
    expect(docker.calls).not.toContain('build');
    expect(docker.calls).not.toContain('run');
  });

  it('re-probes, without rebuilding, when the recorded evidence belongs to another runtime version', async () => {
    const docker = fakeDocker();
    await setupSuperColliderRuntime({ docker, dataDir });
    const evidence = JSON.parse(await readFile(evidencePath(), 'utf8'));
    await writeFile(evidencePath(), JSON.stringify({ ...evidence, runtimeVersion: '3.13.0-portos.1' }));
    expect((await getSuperColliderStatus({ docker, dataDir })).state).toBe('unverified');

    docker.calls.length = 0;
    const result = await setupSuperColliderRuntime({ docker, dataDir });
    expect(result).toMatchObject({ outcome: 'ready', built: false, probed: true });
    expect(JSON.parse(await readFile(evidencePath(), 'utf8')).runtimeVersion).toBe(SUPERCOLLIDER_RUNTIME_VERSION);
  });

  it('never reports readiness from a silent, failed or symlinked probe output', async () => {
    const silent = await setupSuperColliderRuntime({ docker: fakeDocker({ render: (out) => writeFileSync(join(out, 'smoke.wav'), stereoWav(2, 0)) }), dataDir });
    expect(silent).toMatchObject({ outcome: 'smoke-failed', status: { state: 'smoke-failed', ready: false } });
    expect(silent.error).toContain('silent');

    // The container owns /out; a symlink there must not make the host read its own files.
    const hostFile = join(dataDir, 'host-audio.wav');
    writeFileSync(hostFile, stereoWav(2, 0.25));
    const linked = await setupSuperColliderRuntime({ docker: fakeDocker({ render: (out) => symlinkSync(hostFile, join(out, 'smoke.wav')) }), dataDir });
    expect(linked.status.smoke).toMatchObject({ ok: false, error: 'the probe wrote no readable WAV' });

    const docker = fakeDocker({ render: () => {}, runResult: { success: false, error: 'timed out after 120s' } });
    const timedOut = await setupSuperColliderRuntime({ docker, dataDir });
    expect(timedOut.status.smoke.error).toBe('the probe render failed: timed out after 120s');
    expect(docker.calls.slice(-4)).toEqual(['run', 'rm', 'version', 'inspect']); // container force-removed after the timeout
  });

  it('stops before building when Docker is unavailable or the build is declined', async () => {
    const stopped = fakeDocker({ running: false });
    const result = await setupSuperColliderRuntime({ docker: stopped, dataDir });
    expect(result).toMatchObject({ outcome: 'docker-unavailable', status: { state: 'docker-stopped' } });
    expect(result.status.message).toContain('Cannot connect to the Docker daemon');
    expect(stopped.calls).not.toContain('build');

    expect((await setupSuperColliderRuntime({ docker: null, dataDir })).status.state).toBe('docker-missing');

    const declined = fakeDocker();
    expect(await setupSuperColliderRuntime({ docker: declined, dataDir, confirmBuild: async () => false })).toMatchObject({ outcome: 'declined', built: false });
    expect(declined.calls).not.toContain('build');
  });
});
