import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { forceAlignLyrics } from './lyricForcedAlign.js';
import { encodePcm16Wav, wavDurationSec } from './lyricAlignCore.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function harness(transform = (words) => words) {
  const root = await mkdtemp(join(tmpdir(), 'ctc-contract-'));
  roots.push(root);
  let runDir;
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
  return { root, run, runDir: () => runDir, align: (options = {}) => forceAlignLyrics(encodePcm16Wav(16000 * 8),
    [{ text: 'Hello, café!' }, { text: 'Hello,' }], { startSec: 4, endSec: 6, dir: join(root, 'venv'),
      resolveBasePython: async () => 'test-python', run, ...options }) };
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
    const intelMac = process.platform === 'darwin' && process.arch === 'x64';
    const version = intelMac ? '2.2.2' : '2.8.0';
    expect(h.run.mock.calls[1][1]).toEqual(['-m', 'pip', 'install', `torch==${version}`, `torchaudio==${version}`, ...(intelMac ? ['numpy<2'] : [])]);
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
