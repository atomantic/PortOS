import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

// Spawn mock — capture every spawn call so tests can assert args, drive
// stdout/stderr, capture the stdin-delivered prompt, and trigger the close
// event whenever they want. Grok reads the prompt via `--prompt-file
// /dev/stdin`, so unlike codex the prompt is captured from stdin writes,
// not argv.
const spawnCalls = [];
const makeFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { written: '', on: vi.fn(), write: vi.fn(function (s) { child.stdin.written += s; }), end: vi.fn() };
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
};
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((bin, args) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, child });
      return child;
    }),
  };
});

// Stable PATHS.images under a test dir so the success-path copyFile lands in
// a predictable place we can read back (mirrors codex.test.js).
const TEST_ROOT = join(tmpdir(), `portos-grok-test-${process.pid}-${Date.now()}`);
const FAKE_IMAGES_DIR = join(TEST_ROOT, 'data-images');
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.images = FAKE_IMAGES_DIR;
  return {
    ...actual,
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

const grok = await import('./grok.js');
const { imageGenEvents } = await import('../imageGenEvents.js');

const flush = () => new Promise((r) => setImmediate(r));
const stagingPathFor = (jobId) => join(tmpdir(), `portos-grok-${jobId}.png`);
const promptOf = (i = 0) => spawnCalls[i].child.stdin.written;
const closeChild = async (i = 0, code = 1) => {
  spawnCalls[i].child.exitCode = code;
  spawnCalls[i].child.emit('close', code, null);
  await flush();
};

beforeEach(async () => {
  spawnCalls.length = 0;
  imageGenEvents.removeAllListeners();
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('grok provider — deriveAspectRatio', () => {
  it('maps common dimension pairs to the closest supported ratio', () => {
    expect(grok.deriveAspectRatio(1024, 1024)).toBe('1:1');
    expect(grok.deriveAspectRatio(1920, 1080)).toBe('16:9');
    expect(grok.deriveAspectRatio(1080, 1920)).toBe('9:16');
    expect(grok.deriveAspectRatio(1024, 1536)).toBe('2:3');
    expect(grok.deriveAspectRatio(1536, 1024)).toBe('3:2');
  });

  it('returns null for absent or invalid dimensions', () => {
    expect(grok.deriveAspectRatio(undefined, undefined)).toBe(null);
    expect(grok.deriveAspectRatio(0, 512)).toBe(null);
    expect(grok.deriveAspectRatio('nope', 512)).toBe(null);
  });
});

describe('grok provider — generateImage', () => {
  it('spawns grok with headless args and delivers the prompt over stdin', async () => {
    const job = await grok.generateImage({ prompt: 'a small fox' });
    expect(job.mode).toBe('grok');
    expect(job.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(job.status).toBe('running');
    expect(spawnCalls.length).toBe(1);
    const { bin, args } = spawnCalls[0];
    expect(bin).toBe('grok');
    // ensureGrokHeadlessArgs contract: plain output, bypassed permissions,
    // prompt via /dev/stdin (POSIX), no --model pin.
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'plain']));
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    expect(args).toEqual(expect.arrayContaining(['--prompt-file', '/dev/stdin']));
    expect(args).not.toContain('--model');
    // The agent prompt names the tool, the image prompt, and the directed path.
    const prompt = promptOf();
    expect(prompt).toContain('image_gen');
    expect(prompt).toContain('a small fox');
    expect(prompt).toContain(stagingPathFor(job.jobId));
    await closeChild();
  });

  it('derives the aspect ratio from width/height and puts it in the prompt', async () => {
    await grok.generateImage({ prompt: 'a fox', width: 1920, height: 1080 });
    expect(promptOf()).toContain('aspect_ratio "16:9"');
    await closeChild();
  });

  it('falls back to the configured default ratio when no dimensions are sent', async () => {
    await grok.generateImage({ prompt: 'a fox', aspectRatio: '9:16' });
    expect(promptOf()).toContain('aspect_ratio "9:16"');
    await closeChild();
  });

  it('ignores an unsupported configured ratio (no injection into the prompt)', async () => {
    await grok.generateImage({ prompt: 'a fox', aspectRatio: '99:1; rm -rf /' });
    expect(promptOf()).not.toContain('99:1');
    expect(promptOf()).not.toContain('aspect_ratio');
    await closeChild();
  });

  it('honors grokPath override (custom binary)', async () => {
    await grok.generateImage({ prompt: 'a fox', grokPath: '/opt/custom/grok' });
    expect(spawnCalls[0].bin).toBe('/opt/custom/grok');
    await closeChild();
  });

  it('appends the negative prompt as an Avoid line', async () => {
    await grok.generateImage({ prompt: 'a fox', negativePrompt: 'watermark, text' });
    expect(promptOf()).toContain('Avoid: watermark, text');
    await closeChild();
  });

  it('rejects when prompt is empty and there is no init image', async () => {
    await expect(grok.generateImage({ prompt: '   ' })).rejects.toThrow(/Prompt is required/);
  });

  it('switches to image_edit and the fidelity phrase for an init image', async () => {
    await mkdir(FAKE_IMAGES_DIR, { recursive: true });
    await writeFile(join(FAKE_IMAGES_DIR, 'proof.png'), 'fake');
    await grok.generateImage({ prompt: 'cover art', initImagePath: 'proof.png', initImageStrength: 0.2 });
    const prompt = promptOf();
    expect(prompt).toContain('image_edit');
    expect(prompt).toContain(join(FAKE_IMAGES_DIR, 'proof.png'));
    // Low strength → composition-preserving fidelity phrase (shared with codex).
    expect(prompt).toMatch(/preserve composition/i);
    expect(prompt).toContain('cover art');
    await closeChild();
  });

  it('drops an initImagePath that escapes the gallery (defense-in-depth)', async () => {
    await grok.generateImage({ prompt: 'cover art', initImagePath: '/etc/passwd', initImageStrength: 0.2 });
    const prompt = promptOf();
    expect(prompt).not.toContain('image_edit');
    expect(prompt).not.toContain('/etc/passwd');
    await closeChild();
  });

  it('allows an empty prompt when editing an init image', async () => {
    await mkdir(FAKE_IMAGES_DIR, { recursive: true });
    await writeFile(join(FAKE_IMAGES_DIR, 'editme.png'), 'fake');
    await grok.generateImage({ prompt: '', initImagePath: 'editme.png' });
    expect(promptOf()).toContain('image_edit');
    await closeChild();
  });

  it('allows concurrent generations (parallel cloud lane)', async () => {
    const a = await grok.generateImage({ prompt: 'one' });
    const b = await grok.generateImage({ prompt: 'two' });
    expect(a.jobId).not.toBe(b.jobId);
    expect(spawnCalls.length).toBe(2);
    await closeChild(0);
    await closeChild(1);
  });
});

describe('grok provider — directed-path harvest', () => {
  it('copies the staged file into PATHS.images and emits completed', async () => {
    const completedListener = vi.fn();
    imageGenEvents.on('completed', completedListener);

    const job = await grok.generateImage({ prompt: 'a fox' });
    // Grok "writes" the directed staging file before the child exits.
    const fakePngBytes = Buffer.from('fakepngbytes');
    await writeFile(stagingPathFor(job.jobId), fakePngBytes);
    await closeChild(0, 0);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && completedListener.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(completedListener).toHaveBeenCalledTimes(1);
    const finalPath = join(FAKE_IMAGES_DIR, job.filename);
    expect(existsSync(finalPath)).toBe(true);
    const written = await readFile(finalPath);
    expect(Buffer.compare(written, fakePngBytes)).toBe(0);
    // Staging file is cleaned up after the copy.
    expect(existsSync(stagingPathFor(job.jobId))).toBe(false);
    // Sidecar metadata exists too.
    const sidecar = join(FAKE_IMAGES_DIR, `${job.generationId}.metadata.json`);
    expect(existsSync(sidecar)).toBe(true);
  });

  it('fails with the stdout narration when grok exits 0 but wrote no file', async () => {
    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    await grok.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;
    child.stdout.emit('data', Buffer.from('I cannot generate that image.\n'));
    await closeChild(0, 0);

    // Wait out the harvest poll window (5s) plus a buffer.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && failedListener.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failedListener).toHaveBeenCalledTimes(1);
    expect(failedListener.mock.calls[0][0].error).toMatch(/I cannot generate that image/);
  }, 12000);

  it('fails with the stderr tail on a non-zero exit', async () => {
    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    await grok.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;
    child.stderr.emit('data', Buffer.from('boom: auth expired\n'));
    await closeChild(0, 1);

    expect(failedListener).toHaveBeenCalledTimes(1);
    expect(failedListener.mock.calls[0][0].error).toMatch(/Exit code 1/);
    expect(failedListener.mock.calls[0][0].error).toMatch(/auth expired/);
  });

  it('fails cleanly when the binary cannot be spawned', async () => {
    const failedListener = vi.fn();
    imageGenEvents.on('failed', failedListener);

    await grok.generateImage({ prompt: 'a fox' });
    const child = spawnCalls[0].child;
    child.emit('error', new Error('ENOENT'));
    await flush();

    expect(failedListener).toHaveBeenCalledTimes(1);
    expect(failedListener.mock.calls[0][0].error).toMatch(/Failed to spawn grok/);
  });
});

describe('grok provider — noImageReason', () => {
  it('falls back to the enablement hint when grok said nothing usable', () => {
    expect(grok.noImageReason('')).toMatch(/Enable Grok Imagegen/);
    expect(grok.noImageReason('----\n12,345\n')).toMatch(/Enable Grok Imagegen/);
  });

  it('surfaces the last narration lines', () => {
    expect(grok.noImageReason('working…\nThat prompt violates policy.\n')).toMatch(/violates policy/);
  });
});

describe('grok provider — cancel', () => {
  it('cancel() requires a jobId', () => {
    expect(() => grok.cancel()).toThrow(/requires a jobId/);
  });

  it('cancel(jobId) SIGTERMs the matching child; cancelAll() sweeps every one', async () => {
    const a = await grok.generateImage({ prompt: 'one' });
    const b = await grok.generateImage({ prompt: 'two' });
    expect(grok.cancel(a.jobId)).toBe(true);
    expect(spawnCalls[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnCalls[1].child.kill).not.toHaveBeenCalled();
    expect(grok.cancelAll()).toBe(true);
    expect(spawnCalls[1].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(grok.cancel(b.jobId)).toBe(true);
    await closeChild(0);
    await closeChild(1);
    // Everything finished — nothing left to cancel.
    expect(grok.cancel(a.jobId)).toBe(false);
    expect(grok.cancelAll()).toBe(false);
  });
});

describe('grok provider — checkConnection', () => {
  it('reports connected with the parsed version on exit 0', async () => {
    const p = grok.checkConnection({});
    await flush();
    const probe = spawnCalls[0];
    expect(probe.bin).toBe('grok');
    expect(probe.args).toEqual(['--version']);
    probe.child.stdout.emit('data', Buffer.from('grok 0.2.7\n'));
    probe.child.emit('close', 0, null);
    const status = await p;
    expect(status).toEqual({ connected: true, mode: 'grok', model: 'grok-cli 0.2.7' });
  });

  it('reports not-found when the spawn errors', async () => {
    const p = grok.checkConnection({ grokPath: '/nope/grok' });
    await flush();
    spawnCalls[0].child.emit('error', new Error('ENOENT'));
    const status = await p;
    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/not found/);
  });

  it('reports the exit code on a non-zero probe', async () => {
    const p = grok.checkConnection({});
    await flush();
    spawnCalls[0].child.emit('close', 3, null);
    const status = await p;
    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/exited 3/);
  });
});
