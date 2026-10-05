import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostVerdict, assertVideo, inspectGeometry, toneRatio, assertContainment } from './eidoverseAcceptance.js';
import { syntheticSong } from '../fixtures/eidoverseAcceptanceScene.js';
import { acceptanceExitCode } from '../eidoverse-acceptance.js';

const host = { platform: 'linux', arch: 'x64', docker: { OSType: 'linux', Architecture: 'x86_64' }, memAvailable: 8 * 1024 ** 3, diskFree: 60 * 1024 ** 3 };
const probe = { streams: [{ codec_type: 'video', width: 1280, height: 720, nb_read_frames: '48', avg_frame_rate: '24/1', duration: '2' }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: '2' } };
const expected = { width: 1280, height: 720, frames: 48 };

function geometry(frame) {
  const width = 400, height = 400, rgb = Buffer.alloc(width * height * 3, 16);
  const shapes = [[0.225, 0.3, 0.15, [32, 224, 96]], [0.775, 0.3, 0.15, [32, 80, 240]], [(0.55 + frame * 0.018) / 2, 0.675, 0.1, [240, 48, 32]]];
  for (const [cx, cy, span, color] of shapes) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (Math.abs((x + 0.5) / width - cx) < span / 2 && Math.abs((y + 0.5) / height - cy) < span / 2) rgb.set(color, (y * width + x) * 3);
    }
  }
  return rgb;
}

describe('acceptance evidence guards (synthetic validator tests, never runtime acceptance)', () => {
  it('fails closed on unavailable native architecture, daemon, memory or Docker-root storage', () => {
    expect(hostVerdict(host).status).toBe('pass');
    for (const change of [{ platform: 'darwin' }, { arch: 'arm64' }, { docker: null }, { memAvailable: host.memAvailable - 1 }, { diskFree: host.diskFree - 1 }, { diskFree: NaN }]) {
      expect(hostVerdict({ ...host, ...change }).status).toBe('unavailable');
    }
  });
  it('checks decoded frame counts and muxed streams independently of successful encoder exit', () => {
    expect(assertVideo(probe, expected).frames).toBe(48);
    for (const change of [{ width: 720 }, { nb_read_frames: '47' }, { duration: '1.95' }, { avg_frame_rate: '30/1' }]) {
      expect(() => assertVideo({ ...probe, streams: [{ ...probe.streams[0], ...change }, probe.streams[1]] }, expected)).toThrow();
    }
    expect(() => assertVideo({ ...probe, streams: [probe.streams[0]] }, expected)).toThrow();
  });
  it('recognizes spatial geometry at first/middle/last and rejects a restarted excerpt, black output and banded gradients', () => {
    for (const frame of [0, 24, 47]) expect(inspectGeometry(geometry(frame), 400, 400, frame).red.pixels).toBeGreaterThan(0);
    expect(() => inspectGeometry(geometry(0), 400, 400, 24)).toThrow();
    expect(() => inspectGeometry(Buffer.alloc(400 * 400 * 3), 400, 400, 0)).toThrow();
    const bands = Buffer.alloc(400 * 400 * 3);
    for (let i = 0; i < bands.length; i += 3) bands.set([0, 240, 0], i);
    expect(() => inspectGeometry(bands, 400, 400, 0)).toThrow();
  });
  it('detects the excerpt tone rather than treating any audio stream as correct alignment', () => {
    const wav = syntheticSong();
    const decode = offset => {
      const pcm = Buffer.alloc(24000 * 4);
      for (let i = 0; i < 24000; i++) pcm.writeFloatLE(wav.readInt16LE(44 + (offset + i) * 2) / 32768, i * 4);
      return pcm;
    };
    expect(toneRatio(decode(0), 330, 880)).toBeGreaterThan(100);
    expect(toneRatio(decode(48000), 880, 330)).toBeGreaterThan(100);
    expect(() => toneRatio(decode(0), 880, 330)).toThrow();
    expect(() => toneRatio(Buffer.alloc(24000 * 4), 880, 330)).toThrow();
  });
  it('checks the real inspect projection for containment and rejects writable inputs, GPU devices and extra host mounts', () => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    const c = { Image: imageId, Config: { User: '1000:1000', Cmd: ['--cached-only', '--frozen'], Env: ['GALLIUM_DRIVER=llvmpipe', 'RENDER_CODEC=libx264'] }, HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], Privileged: false, SecurityOpt: ['no-new-privileges'],
      Memory: 8 * 1024 ** 3, NanoCpus: 4 * 1e9, PidsLimit: 256, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m' }, Devices: [], DeviceRequests: [],
    }, Mounts: [{ Type: 'bind', Destination: '/input', RW: false }, { Type: 'bind', Destination: '/output', RW: true }] };
    expect(() => assertContainment(c, imageId)).not.toThrow();
    for (const mutate of [copy => { copy.HostConfig.NetworkMode = 'host'; }, copy => { copy.Mounts[0].RW = true; }, copy => { copy.Mounts.push({ Type: 'bind', Destination: '/home', RW: false }); }, copy => { copy.HostConfig.DeviceRequests = [{ Count: -1 }]; }]) {
      const copy = structuredClone(c); mutate(copy);
      expect(() => assertContainment(copy, imageId)).toThrow();
    }
  });
  it('writes unavailable and leaves all runtime criteria not-run when prerequisites are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'eido-acceptance-validator-'));
    try {
      const report = join(root, 'report.json');
      const script = fileURLToPath(new URL('../eidoverse-acceptance.js', import.meta.url));
      expect(() => execFileSync(process.execPath, [script, '--preflight', '--report', report], {
        env: { PATH: '/no-acceptance-tools', NODE_ENV: 'test' }, stdio: 'pipe', timeout: 5000,
      })).toThrow();
      const saved = JSON.parse(readFileSync(report, 'utf8'));
      expect(saved.status).toBe('unavailable'); expect(saved.criteria.host.status).toBe('unavailable');
      expect(Object.entries(saved.criteria).filter(([k]) => k !== 'host').every(([, c]) => c.status === 'not-run')).toBe(true);
      expect(JSON.stringify(saved)).not.toContain(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects combined CLI modes before preflight and never promotes a failed live report to success', () => {
    const root = mkdtempSync(join(tmpdir(), 'eido-acceptance-modes-'));
    try {
      const report = join(root, 'report.json');
      const script = fileURLToPath(new URL('../eidoverse-acceptance.js', import.meta.url));
      expect(() => execFileSync(process.execPath, [script, '--preflight', '--live', '--report', report], {
        env: { PATH: '/no-acceptance-tools', NODE_ENV: 'test' }, stdio: 'pipe', timeout: 5000,
      })).toThrow();
      const saved = JSON.parse(readFileSync(report, 'utf8'));
      expect(saved.status).toBe('fail');
      expect(saved.reason).toContain('mutually exclusive');
      expect(Object.values(saved.criteria).every(c => c.status === 'not-run')).toBe(true);
      const failedLive = { status: 'fail', criteria: { host: { status: 'pass' } } };
      expect(acceptanceExitCode(failedLive, { preflightOnly: true, live: true })).toBe(2);
      expect(acceptanceExitCode(failedLive, { live: true })).toBe(2);
      expect(acceptanceExitCode(failedLive)).toBe(2);
      expect(acceptanceExitCode({ status: 'pass' }, { live: true })).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
