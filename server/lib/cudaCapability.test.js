import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NVIDIA_SMI_QUERY_ARGS,
  parseNvidiaSmiGpus,
  detectCudaGpus,
  getCudaCapability,
  resetCudaCapabilityCache,
  CUDA_UNKNOWN_RETRY_MS,
  parseNvidiaSmiComputeCaps,
  detectCudaComputeCapability,
  NVIDIA_SMI_COMPUTE_CAP_QUERY_ARGS,
  detectCudaUtilization,
} from './cudaCapability.js';

// Real output from `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
// on an RTX 3090 box (driver 596.36). Kept verbatim so a format change is caught here.
const RTX_3090 = 'NVIDIA GeForce RTX 3090, 24576\n';

/** An execFile stub that invokes the callback with `(err, stdout)`. */
const execStub = (err, stdout = '') => vi.fn((_cmd, _args, _opts, cb) => cb(err, stdout));

beforeEach(() => resetCudaCapabilityCache());

describe('parseNvidiaSmiGpus', () => {
  it('parses a real single-GPU reading and rounds VRAM to whole GB', () => {
    expect(parseNvidiaSmiGpus(RTX_3090)).toEqual([
      { name: 'NVIDIA GeForce RTX 3090', vramMib: 24576, vramGb: 24 },
    ]);
  });

  it('parses several GPUs and tolerates CRLF and blank lines', () => {
    const gpus = parseNvidiaSmiGpus('NVIDIA A100, 40960\r\n\r\nNVIDIA L40S, 46068\r\n');
    expect(gpus.map((g) => g.name)).toEqual(['NVIDIA A100', 'NVIDIA L40S']);
    expect(gpus.map((g) => g.vramGb)).toEqual([40, 45]);
  });

  it('rounds a card reading a hair under its marketed size up to that size', () => {
    // A "24 GB" card commonly reports 24268 MiB — it must not miss a 24 GB floor.
    expect(parseNvidiaSmiGpus('NVIDIA RTX A5000, 24268')[0].vramGb).toBe(24);
  });

  it('keeps a GPU whose VRAM column is unreadable, sized null rather than dropped or zero', () => {
    // Some vGPU/MIG configurations report [N/A]. The card IS there; we just can't
    // size it — reporting no GPU, or a 0 GB one, would both be wrong.
    expect(parseNvidiaSmiGpus('GRID V100D-32Q, [N/A]')).toEqual([
      { name: 'GRID V100D-32Q', vramMib: null, vramGb: null },
    ]);
  });

  it('returns an empty list for empty or nullish output', () => {
    for (const input of ['', '   \n\n', null, undefined]) {
      expect(parseNvidiaSmiGpus(input)).toEqual([]);
    }
  });
});

describe('detectCudaGpus', () => {
  it('queries nvidia-smi with the CSV/nounits args and reports the largest card', async () => {
    const execFileImpl = execStub(null, 'NVIDIA A100, 40960\nNVIDIA GeForce RTX 3090, 24576\n');
    const result = await detectCudaGpus({ execFileImpl });

    expect(execFileImpl).toHaveBeenCalledWith(
      'nvidia-smi',
      [...NVIDIA_SMI_QUERY_ARGS],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
    expect(result).toMatchObject({ status: 'available', maxVramGb: 40 });
    expect(result.gpus).toHaveLength(2);
  });

  it('reports maxVramGb from the biggest single card, not the sum', async () => {
    // A render runs on one GPU — summing would advertise capacity no job can use.
    const result = await detectCudaGpus({ execFileImpl: execStub(null, 'A, 24576\nB, 24576\n') });
    expect(result.maxVramGb).toBe(24);
  });

  it('keeps CUDA available but VRAM size unknown when nvidia-smi cannot size a card', async () => {
    const result = await detectCudaGpus({ execFileImpl: execStub(null, 'GRID V100D-32Q, [N/A]\n') });
    expect(result).toMatchObject({ status: 'available', maxVramGb: null });
    expect(result.gpus).toEqual([{ name: 'GRID V100D-32Q', vramMib: null, vramGb: null }]);
  });

  it('treats a missing nvidia-smi as a definitive "no GPU", not a failed probe', async () => {
    const enoent = Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    expect(await detectCudaGpus({ execFileImpl: execStub(enoent) })).toMatchObject({
      status: 'absent',
      maxVramGb: null,
    });
  });

  it('treats an installed-but-failing nvidia-smi as UNKNOWN, never as "no GPU"', async () => {
    // Driver/library mismatch pending a reboot: the hardware may well be present.
    const err = Object.assign(new Error("couldn't communicate with the NVIDIA driver"), { code: 9 });
    const result = await detectCudaGpus({ execFileImpl: execStub(err) });
    expect(result.status).toBe('unknown');
    // No boolean field exists to be misread as "no GPU" — status is the only answer.
    expect(result).not.toHaveProperty('available');
    expect(result.error).toMatch(/NVIDIA driver/);
  });

  it('treats a clean run listing zero GPUs as absent', async () => {
    expect(await detectCudaGpus({ execFileImpl: execStub(null, '\n') })).toMatchObject({
      status: 'absent',
    });
  });

  it('resolves rather than throwing when the spawn itself blows up', async () => {
    const execFileImpl = vi.fn(() => { throw new Error('spawn exploded'); });
    // A probe runs outside the request lifecycle — a throw here would crash the process.
    expect(await detectCudaGpus({ execFileImpl })).toMatchObject({ status: 'unknown' });
  });
});

describe('getCudaCapability caching', () => {
  it('probes once and serves the cached answer afterwards', async () => {
    const execFileImpl = execStub(null, RTX_3090);
    await getCudaCapability({ execFileImpl });
    await getCudaCapability({ execFileImpl });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one subprocess between concurrent callers', async () => {
    const execFileImpl = execStub(null, RTX_3090);
    const [a, b] = await Promise.all([
      getCudaCapability({ execFileImpl }),
      getCudaCapability({ execFileImpl }),
    ]);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('re-probes after refresh', async () => {
    const execFileImpl = execStub(null, RTX_3090);
    await getCudaCapability({ execFileImpl });
    await getCudaCapability({ execFileImpl, refresh: true });
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('caches a definitive "absent" answer', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const execFileImpl = execStub(enoent);
    await getCudaCapability({ execFileImpl });
    await getCudaCapability({ execFileImpl });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('holds an unknown result only briefly, then re-probes', async () => {
    const failing = execStub(Object.assign(new Error('driver busy'), { code: 9 }));
    let clock = 1_000_000;
    const now = () => clock;

    await getCudaCapability({ execFileImpl: failing, now });
    // Within the retry window a wedged driver must NOT be re-spawned per call —
    // nvidia-smi can hang until its timeout, so that would stall every request.
    await getCudaCapability({ execFileImpl: failing, now });
    await getCudaCapability({ execFileImpl: failing, now });
    expect(failing).toHaveBeenCalledTimes(1);

    // Past the window it tries again, so a driver that comes back is picked up.
    clock += CUDA_UNKNOWN_RETRY_MS + 1;
    await getCudaCapability({ execFileImpl: failing, now });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('caches a recovered answer indefinitely once the driver responds', async () => {
    const failing = execStub(Object.assign(new Error('driver busy'), { code: 9 }));
    let clock = 1_000_000;
    const now = () => clock;
    await getCudaCapability({ execFileImpl: failing, now });

    clock += CUDA_UNKNOWN_RETRY_MS + 1;
    const recovered = execStub(null, RTX_3090);
    expect(await getCudaCapability({ execFileImpl: recovered, now })).toMatchObject({
      status: 'available',
    });
    clock += CUDA_UNKNOWN_RETRY_MS * 100;
    await getCudaCapability({ execFileImpl: recovered, now });
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});

describe('parseNvidiaSmiComputeCaps', () => {
  it('parses name, compute capability and VRAM per row', () => {
    const gpus = parseNvidiaSmiComputeCaps(
      'NVIDIA GeForce RTX 3090, 8.6, 24576\nNVIDIA L40S, 8.9, 46068\n',
    );
    expect(gpus).toEqual([
      { name: 'NVIDIA GeForce RTX 3090', computeCap: '8.6', vramGb: 24 },
      { name: 'NVIDIA L40S', computeCap: '8.9', vramGb: 45 },
    ]);
  });

  it('keeps a card whose arch column is unreadable, with a null sentinel', () => {
    // Present but unclassifiable is NOT the same as absent — dropping the row would
    // under-report the host as having no GPU.
    const gpus = parseNvidiaSmiComputeCaps('NVIDIA A100-SXM4-40GB, [N/A], 40960\n');
    expect(gpus).toEqual([{ name: 'NVIDIA A100-SXM4-40GB', computeCap: null, vramGb: 40 }]);
  });

  it('ignores blank lines and rows with no name', () => {
    expect(parseNvidiaSmiComputeCaps('\n\n  \n')).toEqual([]);
    expect(parseNvidiaSmiComputeCaps(null)).toEqual([]);
  });
});

describe('detectCudaComputeCapability', () => {
  const smi = (stdout) => (_bin, _args, _opts, cb) => cb(null, stdout);

  it('reports the arch of the LARGEST card, not the highest arch', async () => {
    // A render runs on one GPU and the lane picks the biggest one, so the build flag
    // must describe THAT card even when a smaller card has a newer arch.
    const res = await detectCudaComputeCapability({
      execFileImpl: smi('NVIDIA RTX 5090, 12.0, 32768\nNVIDIA L40S, 8.9, 46068\n'),
    });
    expect(res.status).toBe('available');
    expect(res.primaryComputeCap).toBe('8.9');
  });

  it('queries compute_cap separately from the VRAM probe', () => {
    // Folding compute_cap into NVIDIA_SMI_QUERY_ARGS would make an old driver fail the
    // whole probe and take the working local-cuda lane down with it.
    expect(NVIDIA_SMI_COMPUTE_CAP_QUERY_ARGS.join(' ')).toContain('compute_cap');
    expect(NVIDIA_SMI_QUERY_ARGS.join(' ')).not.toContain('compute_cap');
  });

  it('says absent when nvidia-smi is not installed', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    const res = await detectCudaComputeCapability({ execFileImpl: (_b, _a, _o, cb) => cb(err) });
    expect(res).toMatchObject({ status: 'absent', primaryComputeCap: null });
  });

  it('says unknown — not absent — when an old driver rejects the query', async () => {
    const err = Object.assign(new Error('invalid field'), { code: 1 });
    const res = await detectCudaComputeCapability({ execFileImpl: (_b, _a, _o, cb) => cb(err) });
    expect(res.status).toBe('unknown');
    expect(res.primaryComputeCap).toBeNull();
  });

  it('reports null arch (never a guess) when no row carries a readable one', async () => {
    const res = await detectCudaComputeCapability({
      execFileImpl: smi('NVIDIA A100-SXM4-40GB, [N/A], 40960\n'),
    });
    expect(res.status).toBe('available');
    expect(res.primaryComputeCap).toBeNull();
  });

  it('says absent on exit 0 with no rows', async () => {
    const res = await detectCudaComputeCapability({ execFileImpl: smi('\n') });
    expect(res).toMatchObject({ status: 'absent', primaryComputeCap: null });
  });
});

describe('detectCudaUtilization', () => {
  it('parses utilization rows', async () => {
    const res = await detectCudaUtilization({
      execFileImpl: (_b, _a, _o, cb) => cb(null, 'NVIDIA L40S, 42, 1024, 46068\n'),
    });
    expect(res.status).toBe('available');
    expect(res.gpus[0]).toEqual({
      name: 'NVIDIA L40S', utilizationPercent: 42, memoryUsedMib: 1024, memoryTotalMib: 46068,
    });
  });

  it('keeps its divergent ENOENT error contract', async () => {
    // This probe reports the RAW error message on ENOENT where detectCudaGpus and
    // detectCudaComputeCapability both report null. That asymmetry is pre-existing and
    // is the sole reason the shared nvidia-smi shell carries a separate `rawError`
    // field — pin it, so a later "simplification" that folds rawError into error can't
    // change this payload with a green suite.
    const err = Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    const util = await detectCudaUtilization({ execFileImpl: (_b, _a, _o, cb) => cb(err) });
    expect(util).toMatchObject({ status: 'absent', error: 'spawn nvidia-smi ENOENT' });
    // The contrast that makes the divergence explicit:
    expect((await detectCudaGpus({ execFileImpl: (_b, _a, _o, cb) => cb(err) })).error).toBeNull();
  });

  it('says unknown when nvidia-smi exists but fails', async () => {
    const err = Object.assign(new Error('driver mismatch'), { code: 1 });
    const res = await detectCudaUtilization({ execFileImpl: (_b, _a, _o, cb) => cb(err) });
    expect(res).toMatchObject({ status: 'unknown', error: 'driver mismatch' });
  });
});
