import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { forceAlignLyrics, _lyricAlignRuntimePlan } from './lyricForcedAlign.js';
import { encodePcm16Wav, wavDurationSec } from './lyricAlignCore.js';

const LOCK_PATH = fileURLToPath(new URL('../../../scripts/requirements-lyric-align.lock.txt', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../../../scripts/requirements-lyric-align.txt', import.meta.url));
const LINUX = _lyricAlignRuntimePlan({ platform: 'linux' });
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function harness(transform = (words) => words, { scriptLines = ['PROGRESS:emissions:50'], scriptSuccess = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ctc-contract-'));
  roots.push(root);
  let runDir;
  let scriptArgs;
  const findPython = vi.fn(async () => 'test-python');
  const run = vi.fn(async (_bin, args, onLine, options) => {
    if (args[1] === 'venv') await mkdir(args.at(-1), { recursive: true });
    if (args[0] !== '-m' && args[0] !== '-c') {
      scriptArgs = args;
      runDir = args[args.indexOf('--output') + 1];
      expect(wavDurationSec(await readFile(args[args.indexOf('--audio') + 1]))).toBe(2);
      expect(JSON.parse(await readFile(args[args.indexOf('--lyrics') + 1], 'utf8'))).toEqual([['Hello,', 'café!'], ['Hello,']]);
      expect(options.isCancelled).toEqual(expect.any(Function));
      for (const line of [...scriptLines, 'unstructured output is ignored']) onLine(line);
      if (!scriptSuccess) return { success: false };
      await writeFile(runDir, JSON.stringify(transform([
        [{ w: 'Hello,', startSec: 0.1, endSec: 0.4 }, { w: 'café!', startSec: 0.4, endSec: 0.8 }],
        [{ w: 'Hello,', startSec: 1.4, endSec: 1.8 }],
      ])));
    }
    return { success: true };
  });
  const dir = join(root, 'venv');
  const makeVenv = async (stamp) => {
    const bin = join(dir, process.platform === 'win32' ? 'Scripts' : 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    if (stamp) await writeFile(join(dir, 'portos-lock.sha256'), stamp);
  };
  return {
    root, dir, run, findPython, makeVenv, runDir: () => runDir, scriptArgs: () => scriptArgs,
    align: (options = {}) => forceAlignLyrics(encodePcm16Wav(16000 * 8),
      [{ text: 'Hello, café!' }, { text: 'Hello,' }], { startSec: 4, endSec: 6, dir, plan: LINUX, findPython, run, ...options }),
  };
}

const calls = (h, predicate) => h.run.mock.calls.filter(([, args]) => predicate(args));

describe('MMS_FA process contract', () => {
  it('provisions the hash lock on demand, preserves word occurrences and offsets the cropped song clock', async () => {
    const h = await harness();
    expect(h.run).not.toHaveBeenCalled();
    const onProgress = vi.fn();
    const words = await h.align({ onProgress });
    expect(words).toEqual([
      [{ w: 'Hello,', startSec: 4.1, endSec: 4.4, conf: 'matched' }, { w: 'café!', startSec: 4.4, endSec: 4.8, conf: 'matched' }],
      [{ w: 'Hello,', startSec: 5.4, endSec: 5.8, conf: 'matched' }],
    ]);
    expect(h.run.mock.calls[0][1]).toEqual(['-m', 'venv', h.dir]);
    expect(h.run.mock.calls[1][1]).toEqual(['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes',
      '--no-deps', '--only-binary', ':all:', '-r', LOCK_PATH]);
    // The checkpoint cache sits beside the venv so a venv rebuild keeps it.
    expect(h.scriptArgs().slice(-2)).toEqual(['--model-dir', join(h.root, 'venv-models')]);
    expect(onProgress).toHaveBeenCalledWith({ stage: 'emissions', percent: 50 });
    await expect(readFile(h.runDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds a venv on an incompatible interpreter from a discovered base', async () => {
    const h = await harness();
    await h.makeVenv();
    const implementation = h.run.getMockImplementation();
    h.run.mockImplementation(async (...args) => (args[1][1]?.includes('BASE:') ? { success: false } : implementation(...args)));
    await h.align();
    expect(h.findPython).toHaveBeenCalledWith(LINUX);
    expect(calls(h, (args) => args.join(' ') === `-m venv --clear ${h.dir}`).map(([bin]) => bin)).toEqual(['test-python']);
    expect(await readFile(join(h.dir, 'portos-lock.sha256'), 'utf8')).toBe(LINUX.lockId);
  });

  it('rebuilds a compatible venv from another lock with its own base, even when torch already matches', async () => {
    const h = await harness();
    await h.makeVenv('stamp-of-an-older-lock');
    const implementation = h.run.getMockImplementation();
    h.run.mockImplementation(async (bin, args, onLine, options) => {
      if (args[1]?.includes('BASE:')) {
        expect(args[1]).toContain(LINUX.versionProbe);
        onLine('BASE:own-base-python');
        return { success: true };
      }
      return implementation(bin, args, onLine, options);
    });
    await h.align();
    expect(h.findPython).not.toHaveBeenCalled();
    // Packages are only ever installed into a cleared venv, so nothing outside the lock survives.
    const order = h.run.mock.calls.map(([bin, args]) => (args[1] === 'venv' ? `${bin} venv ${args[2]}` : args[1]));
    expect(order.indexOf('own-base-python venv --clear')).toBeLessThan(order.indexOf('pip'));
    expect(calls(h, (args) => args[1] === 'pip')).toHaveLength(1);
  });

  it('does not discover a base interpreter when the venv carries this lock', async () => {
    const h = await harness();
    await h.makeVenv(LINUX.lockId);
    await h.align();
    expect(h.findPython).not.toHaveBeenCalled();
    expect(calls(h, (args) => args[1] === 'pip' || args[1] === 'venv')).toHaveLength(0);
    expect(h.run.mock.calls[0][1]).toEqual(['-c', LINUX.probe]);
  });

  it('refuses Intel macOS before probing, discovering or installing anything, even beside an old venv', async () => {
    const h = await harness();
    await h.makeVenv();
    const plan = _lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: false });
    await expect(h.align({ plan })).rejects.toMatchObject({ code: 'LYRIC_ALIGN_CTC_UNSUPPORTED_PLATFORM' });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.findPython).not.toHaveBeenCalled();
  });

  it('names the arm64 interpreter Apple Silicon needs instead of installing for an x86_64 one', async () => {
    const h = await harness();
    h.findPython.mockResolvedValue(null);
    const plan = _lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: true, darwinMajor: 24 });
    await expect(h.align({ plan })).rejects.toMatchObject({
      code: 'LYRIC_ALIGN_CTC_PYTHON_MISSING', message: expect.stringContaining('arm64 Python 3.11–3.14'),
    });
    expect(h.findPython).toHaveBeenCalledWith(plan);
    expect(calls(h, (args) => args[1] === 'pip' || args[1] === 'venv')).toHaveLength(0);
  });

  it('reports a rejected checkpoint distinctly and forwards download progress', async () => {
    const h = await harness(undefined, {
      scriptLines: ['PROGRESS:downloading-model:40', 'ERROR:checkpoint-rejected'], scriptSuccess: false,
    });
    const onProgress = vi.fn();
    await expect(h.align({ onProgress })).rejects.toMatchObject({ code: 'LYRIC_ALIGN_CTC_MODEL_REJECTED' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'downloading-model', percent: 40 });
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

describe('lyric alignment platform plans', () => {
  it('installs only the hash lock on Linux, Windows and Apple Silicon, with an arm64 interpreter on macOS', () => {
    const plans = {
      linux: LINUX,
      win32: _lyricAlignRuntimePlan({ platform: 'win32' }),
      darwin: _lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: true, darwinMajor: 23 }),
    };
    for (const plan of Object.values(plans)) {
      expect(plan.unsupported).toBeNull();
      expect(plan.install.slice(-2)).toEqual(['-r', LOCK_PATH]);
      expect(plan.install).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--only-binary']));
      expect(plan.versionProbe).toContain('(3, 11) <= sys.version_info[:2] <= (3, 14)');
    }
    expect(plans.darwin.versionProbe).toContain('platform.machine() == "arm64"');
    expect(plans.linux.versionProbe).not.toContain('platform.machine()');
    expect(plans.win32.arch).toBeNull();
  });

  it('refuses Macs patched PyTorch cannot run instead of picking an older wheel', () => {
    expect(_lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: false }).unsupported).toMatch(/Apple Silicon/);
    expect(_lyricAlignRuntimePlan({ platform: 'darwin', appleSilicon: true, darwinMajor: 22 }).unsupported).toMatch(/macOS 14/);
  });

  it('probes for exactly the locked torch and torchaudio', () => {
    expect(LINUX.probe).toContain('torch.__version__.split("+")[0] == "2.14.1"');
    expect(LINUX.probe).toContain('torchaudio.__version__.split("+")[0] == "2.11.1"');
  });
});

describe('lyric alignment hash lock', () => {
  const lock = readFileSync(LOCK_PATH, 'utf8');
  const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((block) => /^[a-z][^\n]*==/i.test(block));
  const pin = (name) => blocks.filter((block) => block.startsWith(`${name}==`)).map((block) => block.split(/[ ;\\]/)[0]);
  const numeric = (version) => version.split('.').map(Number);

  it('hashes every package from PyPI, with no URL or VCS source', () => {
    expect(blocks.length).toBeGreaterThan(10);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
    expect(lock).not.toMatch(/^--(?:extra-)?index-url/m);
    expect(lock).toMatch(/^# exclude-newer \d{4}-\d{2}-\d{2}$/m);
  });

  it('locks one patched torch, its torchaudio, and the direct pins of the source file', () => {
    expect(pin('torch')).toHaveLength(1);
    // GHSA-rrmf-rvhw-rf47 is the latest first-fixed release in the #15652 audit.
    const [major, minor] = numeric(pin('torch')[0].split('==')[1]);
    expect(major > 2 || (major === 2 && minor >= 13)).toBe(true);
    const direct = readFileSync(SOURCE_PATH, 'utf8').split('\n').filter((line) => /^[a-z]/i.test(line))
      .map((line) => line.split(/[ ;]/)[0]);
    for (const requirement of direct) expect(blocks.some((block) => block.startsWith(`${requirement} `))).toBe(true);
  });
});
