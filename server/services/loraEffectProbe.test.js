/**
 * LoRA effect probe service (#4872) — spawn, fallback, cache, and the
 * never-fatal contract.
 *
 * The Python measurement has its own runnable suite
 * (scripts/ml/lora_effect_probe_test.py). What matters here is everything AROUND
 * it: that a passive read never lands in this module, that a missing numpy
 * advances to the next interpreter instead of becoming a verdict about the
 * adapter, and that no failure path can throw into a render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posixPath } from '../lib/testHelper.js';

const MOCK_LORAS_DIR = '/mock/loras';

const state = vi.hoisted(() => ({
  statResult: { size: 4096, mtimeMs: 1_700_000_000_000, isFile: () => true },
  statThrows: false,
  sidecar: null,
  patched: [],
  patchThrows: false,
  existing: new Set(),
  runs: [],
  // filename -> { stdout, ok, canceled, reason }
  responses: [],
}));

vi.mock('fs', () => ({ existsSync: vi.fn((p) => state.existing.has(p)) }));
vi.mock('fs/promises', () => ({
  stat: vi.fn(async () => {
    if (state.statThrows) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return state.statResult;
  }),
}));
vi.mock('../lib/fileUtils.js', () => ({ PATHS: { root: '/mock/root', loras: MOCK_LORAS_DIR } }));

vi.mock('../lib/sidecarProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  runSidecarProcess: vi.fn(async ({ bin, args, signal }) => {
    state.runs.push({ bin, args });
    const response = state.responses.shift() || { ok: true, stdout: '' };
    // `aborted: true` models OUR budget expiring: withAbortTimeout fires the
    // signal, the caller's listener observes it, and the child then dies of the
    // SIGTERM that follows. A response with `canceled` but no `aborted` models
    // an EXTERNAL kill (OOM, stray pkill), where the signal never fires — the
    // distinction the production code has to make.
    if (response.aborted) signal?.dispatchEvent(new Event('abort'));
    const { aborted, ...rest } = response;
    return rest;
  }),
}));

vi.mock('../lib/pythonSetup.js', () => ({
  detectPython: vi.fn(async () => '/usr/bin/python3'),
  NUMPY_PYTHON_RESOLVERS: [() => '/venv/flux2/bin/python3', () => null, () => '/venv/music/bin/python3'],
}));

vi.mock('./videoGen/runtimes.js', () => ({
  LTX2_VENV_PYTHON: '/venv/ltx2/bin/python3',
  LTX25_VENV_PYTHON: '/venv/ltx25/bin/python3',
}));

vi.mock('./loras.js', () => ({
  assertSafeLoraFilename: vi.fn((f) => {
    if (!f || !f.endsWith('.safetensors')) throw new Error('LoRA filename must end with .safetensors');
  }),
  readSidecar: vi.fn(async () => state.sidecar),
  patchLoraSidecar: vi.fn(async (filename, patch) => {
    if (state.patchThrows) throw new Error('EACCES');
    state.patched.push({ filename, patch });
    return patch;
  }),
}));

const resultLine = (payload) => `STAGE:measure\nRESULT:${JSON.stringify(payload)}\n`;

const OK_PAYLOAD = {
  probeVersion: 1, status: 'ok', modules: 4, measured: 4, skippedNonFinite: 0,
  skippedUnsupported: 0, zeroModules: 0, medianRms: 0.002, maxRms: 0.01, minRms: 0.001, reason: null,
};

let probeLoraEffect;
let LORA_EFFECT_PROBE_SCRIPT;

beforeEach(async () => {
  vi.resetModules();
  state.statResult = { size: 4096, mtimeMs: 1_700_000_000_000, isFile: () => true };
  state.statThrows = false;
  state.sidecar = null;
  state.patched = [];
  state.patchThrows = false;
  state.runs = [];
  state.responses = [];
  state.existing = new Set(['/venv/ltx2/bin/python3', '/venv/ltx25/bin/python3', '/usr/bin/python3']);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  ({ probeLoraEffect, LORA_EFFECT_PROBE_SCRIPT } = await import('./loraEffectProbe.js'));
});

describe('probeLoraEffect — happy path', () => {
  it('spawns the shared probe against the resolved LoRA path and returns a normalized report', async () => {
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    const report = await probeLoraEffect('style.safetensors');
    // posixPath the RECEIVED path, never the expectation: `join` yields
    // backslashes on Windows, and normalizing the expected side instead would
    // hide a genuinely wrong path.
    expect(state.runs[0].bin).toBe('/venv/ltx2/bin/python3');
    expect(state.runs[0].args.map(posixPath))
      .toEqual([posixPath(LORA_EFFECT_PROBE_SCRIPT), `${MOCK_LORAS_DIR}/style.safetensors`]);
    expect(report).toMatchObject({ status: 'ok', measured: 4, medianRms: 0.002, sizeBytes: 4096 });
    expect(report.measuredAt).toEqual(expect.any(String));
  });

  it('caches the measurement into the sidecar keyed by the file size and mtime', async () => {
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    await probeLoraEffect('style.safetensors');
    expect(state.patched).toHaveLength(1);
    expect(state.patched[0]).toMatchObject({
      filename: 'style.safetensors',
      patch: { effectReport: expect.objectContaining({ status: 'ok', sizeBytes: 4096, mtimeMs: 1_700_000_000_000 }) },
    });
  });

  it('returns the cached report without spawning anything', async () => {
    state.sidecar = { effectReport: { ...OK_PAYLOAD, sizeBytes: 4096, mtimeMs: 1_700_000_000_000, measuredAt: '2026-08-23T00:00:00.000Z' } };
    const report = await probeLoraEffect('style.safetensors');
    expect(state.runs).toHaveLength(0);
    expect(report).toMatchObject({ status: 'ok', measuredAt: '2026-08-23T00:00:00.000Z' });
  });

  it('re-measures a cached report when the file size changed underneath it', async () => {
    state.sidecar = { effectReport: { ...OK_PAYLOAD, sizeBytes: 999, mtimeMs: 1_700_000_000_000, measuredAt: '2026-08-23T00:00:00.000Z' } };
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    await probeLoraEffect('style.safetensors');
    expect(state.runs).toHaveLength(1);
  });

  it('re-measures when the file was rewritten at the same size', async () => {
    // Same bytes-count, different mtime: a re-download of a sibling adapter.
    // Trusting the old report here would attach the previous verdict to
    // different weights.
    state.sidecar = { effectReport: { ...OK_PAYLOAD, sizeBytes: 4096, mtimeMs: 1_699_999_000_000, measuredAt: '2026-08-23T00:00:00.000Z' } };
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    await probeLoraEffect('style.safetensors');
    expect(state.runs).toHaveLength(1);
  });

  it('re-measures on force even when a fresh cached report exists', async () => {
    state.sidecar = { effectReport: { ...OK_PAYLOAD, sizeBytes: 4096, mtimeMs: 1_700_000_000_000, measuredAt: '2026-08-23T00:00:00.000Z' } };
    state.responses = [{ ok: true, stdout: resultLine({ ...OK_PAYLOAD, status: 'zero', zeroModules: 4, medianRms: 0, maxRms: 0 }) }];
    const report = await probeLoraEffect('style.safetensors', { force: true });
    expect(state.runs).toHaveLength(1);
    expect(report.status).toBe('zero');
  });
});

describe('probeLoraEffect — interpreter fallback', () => {
  it('advances to the next interpreter when one has no numpy, and stops on a real answer', async () => {
    state.responses = [
      { ok: false, reason: 'exit 3', stdout: resultLine({ status: 'unmeasurable', reason: 'numpy is not installed in this interpreter' }) },
      { ok: true, stdout: resultLine(OK_PAYLOAD) },
    ];
    const report = await probeLoraEffect('style.safetensors');
    expect(state.runs.map((r) => r.bin)).toEqual(['/venv/ltx2/bin/python3', '/venv/ltx25/bin/python3']);
    expect(report.status).toBe('ok');
  });

  it('never tries a second interpreter once one gave a verdict about the file', async () => {
    state.responses = [{ ok: true, stdout: resultLine({ ...OK_PAYLOAD, status: 'unreadable', measured: 0, modules: 0 }) }];
    const report = await probeLoraEffect('style.safetensors');
    expect(state.runs).toHaveLength(1);
    expect(report.status).toBe('unreadable');
  });

  it('skips interpreters that are not installed', async () => {
    state.existing = new Set(['/usr/bin/python3']);
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    await probeLoraEffect('style.safetensors');
    expect(state.runs.map((r) => r.bin)).toEqual(['/usr/bin/python3']);
  });

  it('reports unmeasurable — never throws — when no interpreter exists at all', async () => {
    state.existing = new Set();
    const report = await probeLoraEffect('style.safetensors');
    expect(state.runs).toHaveLength(0);
    expect(report.status).toBe('unmeasurable');
    expect(report.reason).toMatch(/no Python interpreter/i);
  });
});

describe('probeLoraEffect — never fatal, never a false verdict', () => {
  it('reports unmeasurable when every interpreter fails, and caches nothing', async () => {
    state.responses = [
      { ok: false, reason: 'spawn failed: ENOENT', stdout: '' },
      { ok: false, reason: 'spawn failed: ENOENT', stdout: '' },
      { ok: false, reason: 'spawn failed: ENOENT', stdout: '' },
    ];
    const report = await probeLoraEffect('style.safetensors');
    expect(report.status).toBe('unmeasurable');
    // An environment failure must not be frozen into the sidecar — the next
    // attempt (after the venv is installed) has to be able to succeed.
    expect(state.patched).toHaveLength(0);
  });

  it('reports unmeasurable on a timeout rather than surfacing a cancel', async () => {
    state.responses = [{ ok: false, canceled: true, aborted: true, reason: 'cancelled (SIGTERM)', stdout: '' }];
    state.existing = new Set(['/venv/ltx2/bin/python3']);
    const report = await probeLoraEffect('style.safetensors');
    expect(report.status).toBe('unmeasurable');
    expect(report.reason).toMatch(/budget/i);
  });

  it('stops the candidate walk on a timeout instead of paying the budget per interpreter', async () => {
    // A timeout says the FILE is slow to read; every interpreter would be
    // equally slow, so retrying multiplies an inline stall for nothing. This
    // runs before generateVideo even mints a job id, so the UI shows nothing
    // while it waits.
    state.responses = [
      { ok: false, canceled: true, aborted: true, reason: 'cancelled (SIGTERM)', stdout: '' },
      { ok: true, stdout: resultLine(OK_PAYLOAD) },
    ];
    const report = await probeLoraEffect('style.safetensors');
    expect(state.runs).toHaveLength(1);
    expect(report.status).toBe('unmeasurable');
  });

  it('CACHES a timeout so the next render READS IT BACK instead of stalling again', async () => {
    // Unlike the other unmeasurable verdicts (which describe this machine's
    // Python and may fix themselves the moment a venv installs), a timeout
    // describes what reading THIS file costs on THIS storage — exactly what the
    // size+mtime key already scopes.
    //
    // Asserting the WRITE alone is vacuous: a report stamped with the wrong
    // probe version is written and then never read back, which is exactly how
    // this regressed once. Feed the stored value back through the cache.
    state.responses = [{ ok: false, canceled: true, aborted: true, reason: 'cancelled (SIGTERM)', stdout: '' }];
    await probeLoraEffect('style.safetensors');
    expect(state.patched).toHaveLength(1);
    const stored = state.patched[0].patch.effectReport;
    expect(stored).toMatchObject({ status: 'unmeasurable', sizeBytes: 4096 });

    state.sidecar = { effectReport: stored };
    state.runs = [];
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    const second = await probeLoraEffect('style.safetensors');
    expect(state.runs).toHaveLength(0);
    expect(second.status).toBe('unmeasurable');
  });

  it('does not mistake an EXTERNAL kill for its own timeout', async () => {
    // runSidecarProcess reports `canceled` for any SIGTERM/SIGKILL death — an
    // OOM kill, a stray pkill, a process-group signal at shutdown. Reading that
    // as "our budget expired" would permanently badge the adapter Not
    // measurable, because timeouts are the one unmeasurable verdict we cache.
    state.responses = [
      { ok: false, canceled: true, reason: 'cancelled (SIGKILL)', stdout: '' },
      { ok: true, stdout: resultLine(OK_PAYLOAD) },
    ];
    const report = await probeLoraEffect('style.safetensors');
    expect(state.runs.length).toBeGreaterThan(1);
    expect(report.status).toBe('ok');
    expect(state.patched.some((w) => w.patch.effectReport?.status === 'unmeasurable')).toBe(false);
  });

  it('reports an external kill honestly rather than as a budget overrun', async () => {
    state.existing = new Set(['/venv/ltx2/bin/python3']);
    state.responses = [{ ok: false, canceled: true, reason: 'cancelled (SIGKILL)', stdout: '' }];
    const report = await probeLoraEffect('style.safetensors');
    expect(report.status).toBe('unmeasurable');
    expect(report.reason).toMatch(/killed/i);
    expect(state.patched).toHaveLength(0);
  });

  it('never caches the previous candidate\'s verdict when the budget runs out between them', async () => {
    // The walk can end on budget exhaustion with `last` still holding a
    // machine-specific "numpy is not installed" — freezing that into the
    // sidecar would keep reporting unmeasurable long after the user installs a
    // runtime, because its probe version IS current.
    state.responses = [
      { ok: false, reason: 'exit 3', stdout: resultLine({ probeVersion: 1, status: 'unmeasurable', reason: 'numpy is not installed in this interpreter' }) },
      { ok: false, reason: 'exit 3', stdout: resultLine({ probeVersion: 1, status: 'unmeasurable', reason: 'numpy is not installed in this interpreter' }) },
      { ok: false, reason: 'exit 3', stdout: resultLine({ probeVersion: 1, status: 'unmeasurable', reason: 'numpy is not installed in this interpreter' }) },
    ];
    const report = await probeLoraEffect('style.safetensors');
    expect(report.reason).toMatch(/numpy/i);
    expect(state.patched).toHaveLength(0);
  });

  it('does NOT cache an unmeasurable that is only about this machine', async () => {
    state.responses = [
      { ok: false, reason: 'exit 3', stdout: resultLine({ status: 'unmeasurable', reason: 'numpy is not installed' }) },
      { ok: false, reason: 'exit 3', stdout: resultLine({ status: 'unmeasurable', reason: 'numpy is not installed' }) },
      { ok: false, reason: 'exit 3', stdout: resultLine({ status: 'unmeasurable', reason: 'numpy is not installed' }) },
    ];
    await probeLoraEffect('style.safetensors');
    expect(state.patched).toHaveLength(0);
  });

  it('reports unmeasurable for malformed probe output instead of a hollow verdict', async () => {
    state.existing = new Set(['/venv/ltx2/bin/python3']);
    state.responses = [{ ok: true, stdout: 'RESULT:{not json\n' }];
    const report = await probeLoraEffect('style.safetensors');
    expect(report.status).toBe('unmeasurable');
  });

  it('survives well-formed JSON that is not a report object', async () => {
    // `RESULT:[1,2]` parses fine and is truthy, but normalizes to null — a
    // caller that only checked truthiness would dereference it.
    for (const line of ['RESULT:[1,2]\n', 'RESULT:"nope"\n', 'RESULT:null\n', 'RESULT:7\n']) {
      state.existing = new Set(['/venv/ltx2/bin/python3']);
      state.responses = [{ ok: true, stdout: line }];
      const report = await probeLoraEffect('style.safetensors');
      expect(report.status).toBe('unmeasurable');
      expect(report.reason).toMatch(/produced no result/i);
    }
  });

  it('still returns the measurement when the sidecar cache write fails', async () => {
    state.patchThrows = true;
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    await expect(probeLoraEffect('style.safetensors')).resolves.toMatchObject({ status: 'ok' });
  });

  it('404s for a missing or non-regular LoRA rather than calling it unmeasurable', async () => {
    // "unmeasurable" means this machine could not run the probe. Saying it about
    // a file that isn't there would tell the user their adapter is unmeasurable
    // when it simply does not exist — and every sibling route 404s.
    state.statThrows = true;
    await expect(probeLoraEffect('gone.safetensors')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    state.statThrows = false;
    state.statResult = { size: 0, mtimeMs: 0, isFile: () => false };
    await expect(probeLoraEffect('dir.safetensors')).rejects.toMatchObject({ status: 404 });
    expect(state.runs).toHaveLength(0);
  });

  it('still refuses an unsafe filename — path validation is not part of "never fatal"', async () => {
    await expect(probeLoraEffect('../../etc/passwd')).rejects.toThrow(/safetensors/i);
  });

  it('reports unmeasurable when the spawn itself throws instead of rejecting into a render', async () => {
    // runSidecarProcess models its failures as resolutions, but the underlying
    // spawn can still throw synchronously — and a render awaits this.
    const { runSidecarProcess } = await import('../lib/sidecarProcess.js');
    vi.mocked(runSidecarProcess).mockRejectedValueOnce(new Error('ERR_INVALID_ARG_VALUE'));
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    state.existing = new Set(['/venv/ltx2/bin/python3']);
    const report = await probeLoraEffect('style.safetensors');
    expect(report.status).toBe('unmeasurable');
    expect(report.reason).toMatch(/could not be started/i);
  });

  it('honors a caller deadline that has already passed, without spawning', async () => {
    // resolveVideoLoras shares ONE deadline across every selected adapter, so a
    // batch cannot stall for one full budget per LoRA.
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    const report = await probeLoraEffect('style.safetensors', { deadline: Date.now() - 1 });
    expect(state.runs).toHaveLength(0);
    expect(report.status).toBe('unmeasurable');
  });

  it('coalesces concurrent probes of the same file into one child', async () => {
    state.responses = [{ ok: true, stdout: resultLine(OK_PAYLOAD) }];
    const [a, b] = await Promise.all([
      probeLoraEffect('style.safetensors', { force: true }),
      probeLoraEffect('style.safetensors', { force: true }),
    ]);
    expect(state.runs).toHaveLength(1);
    expect(a).toEqual(b);
  });
});
