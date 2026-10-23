// Opt-in real Recycle Bin check for the Windows CI job (issue #12325).
// A developer's real bin stays untouched unless PORTOS_NATIVE_TRASH_SMOKE is set.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from './childProcess.js';
import { moveToNativeTrash } from './nativeTrash.js';

const execFileAsync = promisify(execFile);

// Keep stage budgets below the existing 30s test deadline, including setup.
// Diagnostics contain stage names/counts only, never SID or bin contents.
async function stage(name, budgetMs, run, pending = new Map()) {
  const started = performance.now();
  const controller = new AbortController();
  let timer;
  console.log(`♻️ Native trash smoke stage=${name} started budgetMs=${budgetMs}`);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Native trash smoke stage=${name} deadline after ${budgetMs}ms`));
    }, budgetMs);
  });
  const work = Promise.resolve().then(() => run(controller.signal));
  pending.set(name, work);
  work.then(() => pending.delete(name), () => pending.delete(name));
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    // Native/fs errors can embed private paths. Keep only their bounded code.
    const code = /^[A-Z_0-9]+$/.test(String(error.code)) ? error.code : 'FAILED';
    throw new Error(`Native trash smoke stage=${name} ${controller.signal.aborted ? 'deadline' : code} after ${Math.round(performance.now() - started)}ms`);
  } finally {
    clearTimeout(timer);
    console.log(`♻️ Native trash smoke stage=${name} finished elapsedMs=${Math.round(performance.now() - started)}`);
  }
}

// Abort requests cancellation; it does not prove a filesystem operation or child
// has stopped. Never delete a fixture while a timed-out stage can still mutate it.
async function drainStages(pending, budgetMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled([...pending.values()]).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), budgetMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// $I<id>: version, size, FILETIME, then (v2) path length and UTF-16LE path;
// v1 stores a padded path. Names are random, so snapshot names before recycling
// and read only new records, stopping as soon as this run's unique path matches.
const readOriginalPath = (buf) => (buf.readBigUInt64LE(0) >= 2n
  ? buf.toString('utf16le', 28, 28 + (buf.readUInt32LE(24) - 1) * 2)
  : buf.toString('utf16le', 24).replace(/\0.*$/s, ''));

async function findInfoFile(binDir, before, file, signal, { list = readdir, read = readFile } = {}) {
  const names = await list(binDir);
  let candidates = 0;
  for (const name of names) {
    signal.throwIfAborted();
    if (!name.startsWith('$I') || before.has(name)) continue;
    candidates++;
    const original = readOriginalPath(await read(join(binDir, name), { signal }));
    signal.throwIfAborted();
    if (original.toLowerCase() === file.toLowerCase()) return join(binDir, name);
  }
  console.log(`♻️ Native trash smoke bin-scan entries=${names.length} candidates=${candidates} matched=false`);
  throw new Error('No matching new Recycle Bin record');
}

// These controls run on every platform; they do not access the real bin.
describe('native trash smoke lifecycle controls', () => {
  it('drains a timed-out stage before fixture cleanup, including delayed abort acknowledgment', async () => {
    vi.useFakeTimers();
    const pending = new Map();
    let finish;
    let signal;
    const removeFixture = vi.fn();
    try {
      const result = stage('recycle', 50, value => {
        signal = value;
        return new Promise(resolve => { finish = resolve; });
      }, pending);
      const assertion = expect(result).rejects.toThrow('stage=recycle deadline');
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(signal.aborted).toBe(true);
      const cleanup = drainStages(pending, 100).then(drained => { if (drained) removeFixture(); });
      await vi.advanceTimersByTimeAsync(10);
      expect(removeFixture).not.toHaveBeenCalled();
      finish();
      await cleanup;
      expect(removeFixture).toHaveBeenCalledOnce();
      expect(pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the fixture when owned work never confirms settlement', async () => {
    vi.useFakeTimers();
    const pending = new Map([['setup', new Promise(() => {})]]);
    const removeFixture = vi.fn();
    try {
      const cleanup = drainStages(pending, 50).then(drained => { if (drained) removeFixture(); return drained; });
      await vi.advanceTimersByTimeAsync(50);
      expect(await cleanup).toBe(false);
      expect(removeFixture).not.toHaveBeenCalled();
      expect(pending.has('setup')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads only new records and stops at the matching unique path', async () => {
    const file = join('synthetic', 'unique-run', 'target.txt');
    const record = Buffer.alloc(28 + (file.length + 1) * 2);
    record.writeBigUInt64LE(2n);
    record.writeUInt32LE(file.length + 1, 24);
    record.write(file.toUpperCase(), 28, 'utf16le');
    const read = vi.fn().mockResolvedValue(record);
    const list = vi.fn().mockResolvedValue(['$Iold', '$Rold', '$Inew', '$Ilater']);
    await expect(findInfoFile('bin', new Set(['$Iold']), file, new AbortController().signal, { list, read }))
      .resolves.toBe(join('bin', '$Inew'));
    expect(read.mock.calls.map(([path]) => path)).toEqual([join('bin', '$Inew')]);
  });
});

describe.runIf(process.platform === 'win32' && process.env.PORTOS_NATIVE_TRASH_SMOKE)('native recycling adapter on a real Recycle Bin', () => {
  let dir;
  let binDir;
  let infoFile;
  const pending = new Map();
  const runStage = (name, budgetMs, run) => stage(name, budgetMs, run, pending);
  afterEach(async () => {
    if (!await drainStages(pending, 3000)) {
      throw new Error(`Native trash smoke cleanup preserved fixture: unfinished stages=${[...pending.keys()].join(',')}`);
    }
    await runStage('cleanup', 3000, async () => {
      // Remove only the pair this test proved belongs to it.
      if (infoFile) {
        await unlink(infoFile).catch(() => {});
        await unlink(join(binDir, `$R${parse(infoFile).base.slice(2)}`)).catch(() => {});
      }
      if (dir) await rm(dir, { recursive: true, force: true });
    });
  });

  it('recycles a temp file and leaves a $I record naming its original path', async () => {
    const file = await runStage('setup', 2000, async signal => {
      // The shell records the long form; the runner's tmpdir is an 8.3 path.
      const root = await realpath(tmpdir());
      signal.throwIfAborted();
      dir = await mkdtemp(join(root, 'portos-native-trash-smoke-'));
      signal.throwIfAborted();
      const target = join(dir, 'smoke target.txt');
      await writeFile(target, 'native trash smoke', { signal });
      return target;
    });
    const sid = await runStage('whoami', 3000, async signal => {
      const { stdout } = await execFileAsync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', signal });
      const result = stdout.trim().split(',')[1]?.replaceAll('"', '');
      if (!/^S-\d+(?:-\d+)+$/.test(result)) throw new Error('Invalid SID');
      return result;
    });
    binDir = join(parse(file).root, '$Recycle.Bin', sid);
    const before = await runStage('bin-snapshot', 3000, async () => new Set(await readdir(binDir).catch(error => {
      // The first recycle on a fresh volume creates its bin.
      if (error.code === 'ENOENT') return [];
      throw error;
    })));
    await runStage('recycle', 15000, signal => moveToNativeTrash([file], { signal }));
    await runStage('source-check', 1000, async () => {
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await runStage('bin-scan', 3000, async signal => {
      infoFile = await findInfoFile(binDir, before, file, signal);
    });
    expect(infoFile, 'a new $I record must name this run’s unique original path').toBeDefined();
  });
});
