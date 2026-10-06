import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, statfs } from 'node:fs/promises';

export const UPSTREAM_SHA = '959a95c3d3963c334422d170317062e00936c573';
export const CRITERIA = ['host', 'source', 'build', 'containment', 'landscape', 'portrait', 'decodedGeometry', 'audioOffset', 'preroll', 'cancellation', 'failureCleanup'];
export const run = async (bin, args, options = {}) => (await promisify(execFile)(bin, args, {
  timeout: 30000, maxBuffer: 32 * 1024 ** 2, encoding: 'utf8', ...options,
})).stdout;

export function newReport() {
  return { schema: 1, upstreamSha: UPSTREAM_SHA, backend: 'Mesa software WebGPU + libx264; no physical GPU or speed claim',
    status: 'unavailable', criteria: Object.fromEntries(CRITERIA.map(key => [key, { status: 'not-run' }])) };
}

export function hostVerdict({ platform, arch, docker, memAvailable, diskFree }) {
  const reasons = [];
  if (platform !== 'linux' || arch !== 'x64') reasons.push('native Linux x86_64 required');
  if (docker?.OSType !== 'linux' || docker?.Architecture !== 'x86_64') reasons.push('local Linux x86_64 Docker daemon required');
  if (!(memAvailable >= 8 * 1024 ** 3)) reasons.push('MemAvailable below 8 GiB or unreadable');
  if (!(diskFree >= 60 * 1024 ** 3)) reasons.push('Docker-root filesystem free space below 60 GiB or unreadable');
  return { status: reasons.length ? 'unavailable' : 'pass', reasons, memAvailable, diskFree };
}

/** Read only. Never install Docker, change its root, prune images or free OS space. */
export async function preflight() {
  const facts = { platform: process.platform, arch: process.arch };
  try {
    // A remote daemon's root is not measurable with host statfs/MemAvailable.
    const context = JSON.parse(await run('docker', ['context', 'inspect']));
    assert.match(process.env.DOCKER_HOST || context[0].Endpoints.docker.Host, /^unix:\/\//);
    facts.docker = JSON.parse(await run('docker', ['info', '--format', '{{json .}}']));
    const mem = await readFile('/proc/meminfo', 'utf8');
    facts.memAvailable = Number(mem.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]) * 1024;
    const disk = await statfs(facts.docker.DockerRootDir);
    facts.diskFree = disk.bavail * disk.bsize;
  } catch { /* Missing, inaccessible and unmeasurable prerequisites fail closed. */ }
  return { platform: facts.platform, arch: facts.arch, ...hostVerdict(facts) };
}

export function assertVideo(probe, { width, height, frames }) {
  const video = probe.streams.find(s => s.codec_type === 'video');
  const audio = probe.streams.find(s => s.codec_type === 'audio');
  assert.ok(video && audio, 'real video and muxed audio streams required');
  assert.equal(video.width, width); assert.equal(video.height, height);
  assert.equal(Number(video.nb_read_frames), frames, 'decoded frame count');
  const [n, d] = video.avg_frame_rate.split('/').map(Number);
  assert.equal(n / d, 24);
  assert.ok(Math.abs(Number(video.duration) - frames / 24) <= 1 / 24000, 'video duration');
  assert.ok(Math.abs(Number(probe.format.duration) - frames / 24) <= 1 / 24, 'mux duration');
  return { width, height, fps: 24, frames, duration: Number(video.duration), audioCodec: audio.codec_name };
}

/** Spatial landmarks reject black frames AND successful banded-gradient renders. */
export function inspectGeometry(rgb, width, height, frame) {
  assert.equal(rgb.length, width * height * 3);
  const masks = { red: [], green: [], blue: [] };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (r > 130 && r > g * 1.8 && r > b * 1.8) masks.red.push([x, y]);
    if (g > 130 && g > r * 1.8 && g > b * 1.5) masks.green.push([x, y]);
    if (b > 130 && b > r * 1.8 && b > g * 1.8) masks.blue.push([x, y]);
  }
  const expected = { green: [0.225, 0.3, 0.15], blue: [0.775, 0.3, 0.15], red: [(0.55 + 0.018 * frame) / 2, 0.675, 0.1] };
  const result = {};
  for (const [key, points] of Object.entries(masks)) {
    const [cx, cy, span] = expected[key];
    assert.ok(points.length > width * height * span ** 2 * 0.5, `${key} recognizable nonblank area`);
    const x = points.reduce((a, p) => a + p[0], 0) / points.length / width;
    const y = points.reduce((a, p) => a + p[1], 0) / points.length / height;
    assert.ok(Math.abs(x - cx) < 0.015 && Math.abs(y - cy) < 0.015, `${key} expected location at frame ${frame}`);
    const bounds = points.reduce((a, p) => [Math.min(a[0], p[0]), Math.max(a[1], p[0]), Math.min(a[2], p[1]), Math.max(a[3], p[1])], [width, 0, height, 0]);
    assert.ok(Math.abs((bounds[1] - bounds[0] + 1) / width - span) < 0.025, `${key} bounded width (not a gradient)`);
    assert.ok(Math.abs((bounds[3] - bounds[2] + 1) / height - span) < 0.025, `${key} bounded height (not a gradient)`);
    result[key] = { x, y, pixels: points.length };
  }
  return result;
}

/** Frequency energy at known synthetic tones, independently decoded from AAC. */
export function toneRatio(pcm, wanted, unwanted, rate = 48000) {
  assert.ok(pcm.length >= rate / 4 * 4, 'at least 250ms decoded audio');
  const energy = frequency => {
    let re = 0, im = 0;
    for (let i = 0; i < pcm.length / 4; i++) {
      const value = pcm.readFloatLE(i * 4), angle = 2 * Math.PI * frequency * i / rate;
      re += value * Math.cos(angle); im += value * Math.sin(angle);
    }
    return re ** 2 + im ** 2;
  };
  const signal = energy(wanted);
  assert.ok(signal > 1, 'non-silent synthetic master song');
  const ratio = signal / Math.max(energy(unwanted), 1e-9);
  assert.ok(ratio > 100, `expected ${wanted}Hz rather than ${unwanted}Hz`);
  return ratio;
}

export function assertContainment(container, imageId) {
  const h = container.HostConfig;
  assert.equal(container.Image, imageId);
  assert.equal(h.NetworkMode, 'none'); assert.equal(h.ReadonlyRootfs, true);
  assert.deepEqual(h.CapDrop, ['ALL']); assert.equal(h.Privileged, false);
  assert.ok(h.SecurityOpt.includes('no-new-privileges'));
  assert.equal(h.Memory, 8 * 1024 ** 3); assert.equal(h.NanoCpus, 4 * 1e9); assert.equal(h.PidsLimit, 256);
  assert.equal(container.Config.User, '1000:1000');
  assert.ok(container.Config.Env.includes('GALLIUM_DRIVER=llvmpipe'));
  assert.ok(container.Config.Env.includes('RENDER_CODEC=libx264'));
  assert.ok(container.Config.Cmd.includes('--cached-only') && container.Config.Cmd.includes('--frozen'));
  const binds = container.Mounts.filter(m => m.Type === 'bind');
  assert.equal(binds.length, 2);
  assert.equal(binds.find(m => m.Destination === '/input')?.RW, false);
  assert.equal(binds.find(m => m.Destination === '/output')?.RW, true);
  assert.ok(!container.Mounts.some(m => m.Destination.includes('docker.sock')));
  assert.match(h.Tmpfs['/tmp'], /size=512m/);
  assert.deepEqual(h.Devices || [], []); assert.deepEqual(h.DeviceRequests || [], []);
}
