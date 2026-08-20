import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  runGenerateSubprocess,
  probePythonModules,
} from './laneRunner.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

// A deliberately target-agnostic stand-in for a lane's progress vocabulary: one
// whole-line banner plus a terminal asset line. laneRunner injects the parser, so
// its tests must not import a lane's real signatures.
const parseProgress = (line) => {
  const text = String(line ?? '').trim();
  if (!text) return null;
  const glb = text.match(/(\S+\.glb)\b/i);
  if (glb) return { stage: 'export', percent: 92, assetPath: glb[1], message: text };
  if (/baking .*textures?/i.test(text)) return { stage: 'texturing', percent: 65, message: text };
  return null;
};

const run = (child, overrides = {}) => runGenerateSubprocess({
  command: 'python',
  args: ['gen.py'],
  label: 'Test lane',
  codePrefix: 'TEST',
  parseProgress,
  spawnImpl: () => child,
  ...overrides,
});

describe('runGenerateSubprocess line buffering', () => {
  it('matches a banner that straddles two data chunks', async () => {
    // Node delivers 'data' on arbitrary byte boundaries. Without a carry buffer the
    // banner arrives as two partial lines, neither matches, and the progress bar
    // stalls at the previous percent until the next banner lands (#3578).
    const child = makeChild();
    const frames = [];
    const { promise } = run(child, { onProgress: (f) => frames.push(f) });
    child.stdout.emit('data', 'Baking te');
    child.stdout.emit('data', 'xtures at 2048px...\nSaved: /out/a.glb\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
    expect(frames.map((f) => f.stage)).toEqual(['texturing', 'export']);
  });

  it('stitches a multibyte codepoint split across chunks instead of mangling the line', async () => {
    const child = makeChild();
    const frames = [];
    const { promise } = run(child, { onProgress: (f) => frames.push(f) });
    const banner = Buffer.from('Baking ✨ textures at 2048px...\n', 'utf8');
    child.stdout.emit('data', banner.subarray(0, 9)); // splits the ✨
    child.stdout.emit('data', banner.subarray(9));
    child.stdout.emit('data', 'Saved: /out/a.glb\n');
    child.emit('close', 0);
    await promise;
    expect(frames[0].message).toBe('Baking ✨ textures at 2048px...');
  });

  it('flushes a final unterminated line on close so the asset path is not lost', async () => {
    // The generator can exit without a trailing newline on its last write; the old
    // per-chunk split parsed that tail immediately, so flushing keeps parity.
    const child = makeChild();
    const { promise } = run(child);
    child.stdout.emit('data', 'Saved: /out/a.glb');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
  });

  it('keeps stdout and stderr carries separate so partial lines are never spliced', async () => {
    // A shared carry would join stdout's 'Baking te' to stderr's chunk and
    // fabricate a line neither stream wrote.
    const child = makeChild();
    const frames = [];
    const { promise } = run(child, { onProgress: (f) => frames.push(f) });
    child.stdout.emit('data', 'Baking te');
    child.stderr.emit('data', 'warning: unrelated\n');
    child.stdout.emit('data', 'xtures at 2048px...\n');
    child.stdout.emit('data', 'Saved: /out/a.glb\n');
    child.emit('close', 0);
    await promise;
    expect(frames.map((f) => f.stage)).toEqual(['texturing', 'export']);
  });

  it('still parses every \\r-separated redraw inside one chunk', async () => {
    const child = makeChild();
    const frames = [];
    const { promise } = run(child, { onProgress: (f) => frames.push(f) });
    child.stdout.emit('data', 'Baking textures at 512px\rBaking textures at 2048px\r');
    child.stdout.emit('data', 'Saved: /out/a.glb\n');
    child.emit('close', 0);
    await promise;
    expect(frames.map((f) => f.message)).toEqual([
      'Baking textures at 512px',
      'Baking textures at 2048px',
      'Saved: /out/a.glb',
    ]);
  });

  it('classifies a non-zero exit from the raw output tail, not the parsed lines', async () => {
    // The tail is appended from the raw chunk, so a classifier still matches text
    // the parser ignored — including a signature split across chunks.
    const child = makeChild();
    const { promise } = run(child, {
      classifiers: [{ test: (t) => /out of memory/i.test(t), code: 'TEST_OOM', help: 'Free some VRAM.' }],
    });
    child.stderr.emit('data', 'torch.OutOfMemoryError: CUDA out of ');
    child.stderr.emit('data', 'memory. Tried to allocate 2.00 GiB');
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'TEST_OOM' });
  });
});

describe('probePythonModules', () => {
  const ok = (payload) => (_py, _args, _opts, cb) => cb(null, JSON.stringify(payload));

  it('reports which modules resolve', async () => {
    const res = await probePythonModules({
      python: '/py', modules: ['a', 'b'], execFileImpl: ok({ a: true, b: false }),
    });
    expect(res).toEqual({ a: true, b: false });
  });

  it('passes the find_spec one-liner and the module list to the interpreter', async () => {
    const seen = [];
    await probePythonModules({
      python: '/py',
      modules: ['o_voxel', 'natten'],
      execFileImpl: (py, args, _o, cb) => { seen.push(py, args); cb(null, '{}'); },
    });
    expect(seen[0]).toBe('/py');
    // find_spec, NOT import — the probe must never pull torch into the request path.
    expect(seen[1][1]).toContain('find_spec');
    expect(seen[1].slice(2)).toEqual(['o_voxel', 'natten']);
  });

  it('returns null — never a partial map — when the probe cannot run', async () => {
    // "Failed to determine" must stay distinct from "determined to be missing", or a
    // broken probe reports a healthy install as degraded.
    expect(await probePythonModules({
      python: '/py', modules: ['a'], execFileImpl: (_p, _a, _o, cb) => cb(new Error('boom')),
    })).toBeNull();
    expect(await probePythonModules({ python: null, modules: ['a'] })).toBeNull();
    expect(await probePythonModules({ python: '/py', modules: [] })).toBeNull();
  });

  it('degrades rather than crashing on unparseable output', async () => {
    // Regression guard: parsing inside the execFile callback would let a throw escape
    // the enclosing promise and reach the event loop, killing the process.
    for (const bad of ['not json', '', 'null', '[1,2]', '  ']) {
      await expect(probePythonModules({
        python: '/py', modules: ['a'], execFileImpl: (_p, _a, _o, cb) => cb(null, bad),
      })).resolves.toBeNull();
    }
  });
});
