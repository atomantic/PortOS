import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ home: null }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => state.home ?? actual.homedir() };
});

const { createZip } = await import('../../lib/zipWriter.js');
const {
  realesrganInstallTarget, describeRealesrganRuntime, installRealesrganRuntime, realesrganArgs,
  resolveRealesrganInvocation, __resetRealesrganInstallForTests,
} = await import('./realesrganRuntime.js');
const { REALESRGAN_MODELS } = await import('./upscalePlan.js');

// Writes an install tree the way a successful install leaves it, so readiness
// can be checked without the release archive or a GPU.
async function stageInstall({ receipt = {}, skipModelFiles = [] } = {}) {
  const target = realesrganInstallTarget();
  await mkdir(join(target.installDir, 'models'), { recursive: true });
  await writeFile(target.binaryPath, 'binary');
  for (const model of Object.values(REALESRGAN_MODELS)) {
    for (const file of model.files) if (!skipModelFiles.includes(file)) await writeFile(join(target.modelDir, file), 'weights');
  }
  await writeFile(join(target.installDir, 'portos-install.json'), JSON.stringify({
    receiptVersion: 1, version: target.version, sha256: target.sha256,
    verifiedModels: Object.keys(REALESRGAN_MODELS), gpu: 'Example GPU', verifiedAt: '2026-01-01T00:00:00.000Z', ...receipt,
  }));
  return target;
}

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'portos-realesrgan-home-'));
  __resetRealesrganInstallForTests();
});
afterEach(async () => { await rm(state.home, { recursive: true, force: true }); });

describe('Real-ESRGAN install target', () => {
  it('names one pinned archive per supported host and refuses the rest with a reason', () => {
    const mac = realesrganInstallTarget({ platform: 'darwin', arch: 'arm64' });
    expect(mac).toMatchObject({ supported: true, version: 'v0.2.5.0', archive: expect.stringMatching(/macos\.zip$/) });
    expect(mac.url).toBe(`https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/${mac.archive}`);
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(realesrganInstallTarget({ platform: 'win32', arch: 'x64' }).binaryPath).toMatch(/realesrgan-ncnn-vulkan\.exe$/);
    expect(realesrganInstallTarget({ platform: 'linux', arch: 'x64' }).archive).toMatch(/ubuntu\.zip$/);
    expect(realesrganInstallTarget({ platform: 'linux', arch: 'arm64' })).toMatchObject({ supported: false, reason: expect.stringMatching(/x86-64 only/) });
    expect(realesrganInstallTarget({ platform: 'freebsd', arch: 'x64' })).toMatchObject({ supported: false });
  });

  it('runs a fixed-4x network at 4x and the animation model at its native 2x', () => {
    const args = (id) => realesrganArgs({ input: 'in', output: 'out', modelDir: 'models', network: REALESRGAN_MODELS[id].network, nativeScale: REALESRGAN_MODELS[id].nativeScale });
    expect(args('realesrgan-x4plus')).toEqual(['-i', 'in', '-o', 'out', '-n', 'realesrgan-x4plus', '-s', '4', '-m', 'models', '-f', 'png']);
    expect(args('realesr-animevideov3')).toEqual(['-i', 'in', '-o', 'out', '-n', 'realesr-animevideov3', '-s', '2', '-m', 'models', '-f', 'png']);
  });
});

describe.skipIf(!realesrganInstallTarget().supported)('Real-ESRGAN readiness (read-only)', () => {
  it('reports the install target and size before anything is installed', async () => {
    const runtime = await describeRealesrganRuntime('realesrgan-x4plus');
    expect(runtime).toMatchObject({
      id: 'realesrgan-ncnn-vulkan', supported: true, installed: false, verified: false,
      installTarget: { version: 'v0.2.5.0', archive: realesrganInstallTarget().archive },
      model: { id: 'realesrgan-x4plus', nativeScale: 4 },
    });
    expect(runtime.reason).toMatch(/not installed.*MB download/);
    // Read-only: describing readiness creates nothing on disk.
    expect(await readdir(state.home)).toEqual([]);
    await expect(resolveRealesrganInvocation('realesrgan-x4plus')).rejects.toMatchObject({ status: 400, code: 'REALESRGAN_NOT_READY' });
  });

  it('is ready only with the binary, the weights and a current receipt that verified those weights', async () => {
    const target = await stageInstall({ receipt: { verifiedModels: ['realesrgan-x4plus'] } });
    expect(await describeRealesrganRuntime('realesrgan-x4plus')).toMatchObject({ installed: true, verified: true, gpu: 'Example GPU', reason: null });
    expect(await resolveRealesrganInvocation('realesrgan-x4plus')).toEqual({
      bin: target.binaryPath, modelDir: target.modelDir, network: 'realesrgan-x4plus', nativeScale: 4,
    });
    const unverified = await describeRealesrganRuntime('realesr-animevideov3');
    expect(unverified).toMatchObject({ installed: false, verified: false, reason: expect.stringMatching(/did not pass the install check/) });
  });

  it('treats a receipt from another release or missing weight files as not ready', async () => {
    await stageInstall({ receipt: { version: 'v0.0.1' } });
    expect(await describeRealesrganRuntime('realesrgan-x4plus')).toMatchObject({ installed: false, reason: expect.stringMatching(/not installed/) });
    await rm(realesrganInstallTarget().installDir, { recursive: true, force: true });
    await stageInstall({ skipModelFiles: ['realesrgan-x4plus.bin'] });
    expect(await describeRealesrganRuntime('realesrgan-x4plus')).toMatchObject({ installed: false, reason: expect.stringMatching(/weights are missing/) });
  });
});

describe.skipIf(!realesrganInstallTarget().supported)('Real-ESRGAN install', () => {
  it('deletes a download that fails the pinned SHA-256 and installs nothing', async () => {
    const tampered = createZip([{ name: realesrganInstallTarget().asset.binary, data: 'not the release' }]);
    const fetchImpl = vi.fn(async () => new Response(tampered, { status: 200, headers: { 'content-length': String(tampered.length) } }));
    const events = [];
    await expect(installRealesrganRuntime({ fetchImpl, onEvent: (event) => events.push(event) }))
      .rejects.toMatchObject({ code: 'DOWNLOAD_HASH_MISMATCH' });
    expect(fetchImpl).toHaveBeenCalledWith(realesrganInstallTarget().url, expect.anything());
    const target = realesrganInstallTarget();
    expect(existsSync(target.installDir)).toBe(false);
    expect(await readdir(join(state.home, '.portos', 'realesrgan-ncnn-vulkan', 'downloads'))).toEqual([]);
    expect(events.some((event) => event.type === 'stage' && event.stage === 'download')).toBe(true);
    expect((await describeRealesrganRuntime('realesrgan-x4plus')).installed).toBe(false);
  });

  it('refuses a second install while one is running', async () => {
    let release;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const first = installRealesrganRuntime({ fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await expect(installRealesrganRuntime({ fetchImpl })).rejects.toMatchObject({ status: 409, code: 'REALESRGAN_INSTALL_IN_FLIGHT' });
    release(new Response('nope', { status: 404 }));
    await expect(first).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });
});
