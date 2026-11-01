import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { forceAlignLyrics, lyricAlignRuntimePlan, resolveLyricAlignRuntime } from './lyricForcedAlign.js';
import { encodePcm16Wav, wavDurationSec } from './lyricAlignCore.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function harness(transform = (words) => words, { ownInterpreter = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ctc-contract-'));
  roots.push(root);
  let runDir;
  const resolveRuntime = vi.fn();
  const run = vi.fn(async (_bin, args, onLine, options) => {
    if (args[0] !== '-m' && args[0] !== '-c') {
      runDir = args[args.indexOf('--output') + 1];
      expect(wavDurationSec(await readFile(args[args.indexOf('--audio') + 1]))).toBe(2);
      expect(JSON.parse(await readFile(args[args.indexOf('--lyrics') + 1], 'utf8'))).toEqual([['Hello,', 'café!'], ['Hello,']]);
      expect(options.isCancelled).toEqual(expect.any(Function));
      onLine('PROGRESS:emissions:50');
      onLine('unstructured output is ignored');
      await writeFile(runDir, JSON.stringify(transform([
        [{ w: 'Hello,', startSec: 0.1, endSec: 0.4 }, { w: 'café!', startSec: 0.4, endSec: 0.8 }],
        [{ w: 'Hello,', startSec: 1.4, endSec: 1.8 }],
      ])));
    }
    return { success: true };
  });
  const resolver = ownInterpreter
    ? { resolveBasePython: async () => 'test-python' }
    : { resolveRuntime };
  return { root, run, resolveRuntime, runDir: () => runDir, align: (options = {}) => forceAlignLyrics(encodePcm16Wav(16000 * 8),
    [{ text: 'Hello, café!' }, { text: 'Hello,' }], { startSec: 4, endSec: 6, dir: join(root, 'venv'),
      ...resolver, run, ...options }) };
}

describe('MMS_FA process contract', () => {
  it('provisions compatible wheels on demand, preserves word occurrences and offsets the cropped song clock', async () => {
    const h = await harness();
    expect(h.run).not.toHaveBeenCalled();
    const onProgress = vi.fn();
    const words = await h.align({ onProgress });
    expect(words).toEqual([
      [{ w: 'Hello,', startSec: 4.1, endSec: 4.4, conf: 'matched' }, { w: 'café!', startSec: 4.4, endSec: 4.8, conf: 'matched' }],
      [{ w: 'Hello,', startSec: 5.4, endSec: 5.8, conf: 'matched' }],
    ]);
    expect(h.run.mock.calls[1][1]).toEqual(['-m', 'pip', 'install', ...lyricAlignRuntimePlan().packages]);
    expect(onProgress).toHaveBeenCalledWith({ stage: 'emissions', percent: 50 });
    await expect(readFile(h.runDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('repairs a venv created from an incompatible interpreter before installing pinned wheels', async () => {
    const h = await harness();
    const dir = join(h.root, 'venv');
    const bin = join(dir, process.platform === 'win32' ? 'Scripts' : 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    const implementation = h.run.getMockImplementation();
    let installed = false;
    h.run.mockImplementation(async (...args) => {
      if (args[1][0] === '-c' && !installed) return { success: false };
      if (args[1][1] === 'pip') installed = true;
      return implementation(...args);
    });
    await h.align();
    expect(h.run.mock.calls.some(([, args]) => args.join(' ') === `-m venv --clear ${dir}`)).toBe(true);
    expect(h.run.mock.calls.some(([, args]) => args[0] === '-c' && args[1] === lyricAlignRuntimePlan().versionProbe)).toBe(true);
  });

  it('repairs an existing hardware-compatible venv when discovery only found the Intel plan', async () => {
    const h = await harness((words) => words, { ownInterpreter: false });
    const bin = join(h.root, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    const hardware = lyricAlignRuntimePlan();
    const fallback = lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: false });
    h.resolveRuntime.mockResolvedValue({ plan: fallback, python: null });
    const implementation = h.run.getMockImplementation();
    let installed = false;
    h.run.mockImplementation(async (...args) => {
      const probe = args[1][0] === '-c' ? args[1][1] : '';
      if (probe === hardware.probe) return { success: installed };
      if (probe === hardware.versionProbe) return { success: true };
      if (probe) return { success: false };
      if (args[1][1] === 'pip') {
        installed = true;
        return { success: true };
      }
      return implementation(...args);
    });
    await h.align();
    expect(h.resolveRuntime).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls.some(([, args]) => args[1] === 'venv')).toBe(false);
    expect(h.run.mock.calls.find(([, args]) => args[1] === 'pip')[1]).toEqual(['-m', 'pip', 'install', ...hardware.packages]);
  });

  it('reuses a healthy Intel-fallback venv without rediscovering interpreters', async () => {
    const hardware = lyricAlignRuntimePlan();
    const fallback = lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: false });
    if (hardware.probe === fallback.probe) return;
    const h = await harness((words) => words, { ownInterpreter: false });
    const bin = join(h.root, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    h.resolveRuntime.mockResolvedValue({ plan: fallback, python: null });
    const implementation = h.run.getMockImplementation();
    h.run.mockImplementation(async (...args) => {
      const probe = args[1][0] === '-c' ? args[1][1] : '';
      if (probe === hardware.probe) return { success: false };
      if (probe === fallback.probe) return { success: true };
      if (probe) return { success: false };
      return implementation(...args);
    });
    await h.align();
    expect(h.resolveRuntime).toHaveBeenCalledTimes(1);
    h.resolveRuntime.mockClear();
    await h.align();
    expect(h.resolveRuntime).not.toHaveBeenCalled();
  });

  it('does not discover a base interpreter when the venv already matches the pin', async () => {
    const h = await harness((words) => words, { ownInterpreter: false });
    const bin = join(h.root, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    await h.align();
    expect(h.resolveRuntime).not.toHaveBeenCalled();
    expect(h.run.mock.calls.some(([, args]) => args[1] === 'pip')).toBe(false);
    expect(h.run.mock.calls[0][1][0]).toBe('-c');
  });

  it('rejects missing, foreign, overlapping and out-of-window results instead of publishing invented words', async () => {
    for (const mutate of [() => null, (w) => w.slice(1), (w) => { w[1][0].w = 'foreign'; return w; },
      (w) => { w[1][0].startSec = 0.5; return w; }, (w) => { w[1][0].endSec = 3; return w; }]) {
      const h = await harness(mutate);
      await expect(h.align()).rejects.toMatchObject({ code: 'LYRIC_ALIGN_CTC_FAILED' });
      await expect(readFile(h.runDir())).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('never starts a canceled alignment and fails closed on runtime installation failure', async () => {
    const h = await harness();
    await expect(h.align({ isCancelled: () => true })).rejects.toMatchObject({ canceled: true });
    expect(h.run).not.toHaveBeenCalled();
    await expect(h.align({ run: async () => ({ success: false }) })).rejects.toMatchObject({ code: 'LYRIC_ALIGN_CTC_INSTALL_FAILED' });
  });
});

describe('lyric alignment wheel pins', () => {
  it('uses current wheels on Apple Silicon even when the caller says the process is x64', () => {
    const plan = lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: true });
    expect(plan.torch).toBe('2.8.0');
    expect(plan.maxPythonMinor).toBe(13);
    expect(plan.arch).toBe('arm64');
    expect(plan.versionProbe).toContain('platform.machine() == "arm64"');
    expect(plan.packages).toEqual(['torch==2.8.0', 'torchaudio==2.8.0']);
  });

  it('keeps the last Intel Mac wheels on real Intel hardware', () => {
    const plan = lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: false });
    expect(plan.torch).toBe('2.2.2');
    expect(plan.maxPythonMinor).toBe(12);
    expect(plan.arch).toBeNull();
    expect(plan.versionProbe).not.toContain('platform.machine()');
    expect(plan.packages).toContain('numpy<2');
  });

  it('uses current wheels off macOS', () => {
    const plan = lyricAlignRuntimePlan({ platform: 'linux', appleSilicon: false });
    expect(plan.torch).toBe('2.8.0');
    expect(plan.arch).toBeNull();
    expect(plan.versionProbe).not.toContain('platform.machine()');
  });

  it('prefers an arm64 interpreter and current wheels on Apple Silicon', async () => {
    const findPython = vi.fn(async (_plan, opts = {}) => (opts.arch === 'arm64' ? '/opt/homebrew/bin/python3' : '/opt/anaconda3/bin/python3'));
    const selected = await resolveLyricAlignRuntime({ platform: 'darwin', appleSilicon: true, findPython });
    expect(selected.plan.torch).toBe('2.8.0');
    expect(selected.python).toBe('/opt/homebrew/bin/python3');
    expect(findPython).toHaveBeenCalledTimes(1);
  });

  it('falls back to Intel wheels when Apple Silicon has only an x86_64 interpreter', async () => {
    const findPython = vi.fn(async (plan, opts = {}) => (opts.arch === 'arm64' ? null : `/python-${plan.maxPythonMinor}`));
    const selected = await resolveLyricAlignRuntime({ platform: 'darwin', appleSilicon: true, findPython });
    expect(selected.plan.torch).toBe('2.2.2');
    expect(selected.python).toBe('/python-12');
    expect(findPython).toHaveBeenCalledTimes(2);
  });

  it('does not look for an arm64 interpreter on a real Intel Mac', async () => {
    const findPython = vi.fn(async () => '/usr/local/bin/python3');
    const selected = await resolveLyricAlignRuntime({ platform: 'darwin', appleSilicon: false, findPython });
    expect(selected.plan.torch).toBe('2.2.2');
    expect(selected.python).toBe('/usr/local/bin/python3');
    expect(findPython).toHaveBeenCalledTimes(1);
  });
});
