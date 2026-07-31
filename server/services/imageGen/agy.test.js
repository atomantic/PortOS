import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

const spawnCalls = [];
const makeFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = vi.fn();
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

const TEST_ROOT = join(tmpdir(), `portos-agy-test-${process.pid}-${Date.now()}`);
const FAKE_IMAGES_DIR = join(TEST_ROOT, 'data-images');
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.images = FAKE_IMAGES_DIR;
  return {
    ...actual,
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

const agy = await import('./agy.js');
const { imageGenEvents } = await import('../imageGenEvents.js');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const stagingPathFor = (jobId) => join(tmpdir(), `portos-agy-${jobId}`, 'output.png');

const closeChild = async (index = 0, code = 1) => {
  spawnCalls[index].child.exitCode = code;
  spawnCalls[index].child.emit('close', code, null);
  await flush();
};

beforeEach(async () => {
  spawnCalls.length = 0;
  imageGenEvents.removeAllListeners();
  agy._internals.setHarvestTimeoutForTests(10);
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  agy._internals.setHarvestTimeoutForTests();
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('agy image provider', () => {
  it('lists installed models after closing stdin', async () => {
    const pending = agy.listModels({ agyPath: '/opt/agy' });
    expect(spawnCalls[0].bin).toBe('/opt/agy');
    expect(spawnCalls[0].args).toEqual(['models']);
    expect(spawnCalls[0].child.stdin.end).toHaveBeenCalledTimes(1);
    spawnCalls[0].child.stdout.emit('data', 'gemini-image\ncustom/image-v2\n');
    spawnCalls[0].child.emit('close', 0, null);
    await expect(pending).resolves.toEqual({
      models: ['gemini-image', 'custom/image-v2'],
      error: null,
    });
  });

  it('spawns headlessly with the selected model and a directed one-image prompt', async () => {
    const job = await agy.generateImage({
      prompt: 'a fox beneath the stars',
      negativePrompt: 'watermark',
      model: 'gemini-3-pro-image',
    });

    expect(job.mode).toBe('agy');
    expect(job.model).toBe('gemini-3-pro-image');
    expect(spawnCalls).toHaveLength(1);
    const { bin, args } = spawnCalls[0];
    expect(bin).toBe('agy');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toEqual(expect.arrayContaining(['--model', 'gemini-3-pro-image', '--print']));
    const prompt = args[args.indexOf('--print') + 1];
    expect(prompt).toContain('generate_image');
    expect(prompt).toContain('exactly one image');
    expect(prompt).toContain('a fox beneath the stars');
    expect(prompt).toContain('Avoid: watermark');
    expect(prompt).toContain(stagingPathFor(job.jobId));
    expect(prompt).toContain('do not modify any code or workspace content');
    await closeChild();
  });

  it('rejects image-edit inputs before spawning', async () => {
    await expect(agy.generateImage({
      prompt: 'edit this',
      initImagePath: 'source.png',
    })).rejects.toMatchObject({ code: 'AGY_IMAGE_EDIT_UNSUPPORTED', status: 400 });
    expect(spawnCalls).toHaveLength(0);
  });

  it('rejects invalid custom model ids', async () => {
    await expect(agy.generateImage({
      prompt: 'a fox',
      model: 'model; rm -rf /',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(spawnCalls).toHaveLength(0);
  });

  it('imports only a signature-verified directed PNG into the gallery', async () => {
    const completed = vi.fn();
    imageGenEvents.on('completed', completed);
    const job = await agy.generateImage({ prompt: 'a fox' });
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fakepngbody'),
    ]);
    await writeFile(stagingPathFor(job.jobId), png);
    await closeChild(0, 0);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && completed.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(completed).toHaveBeenCalledTimes(1);
    expect(existsSync(join(FAKE_IMAGES_DIR, job.filename))).toBe(true);
    expect(await readFile(join(FAKE_IMAGES_DIR, job.filename))).toEqual(png);
    const sidecar = JSON.parse(await readFile(join(FAKE_IMAGES_DIR, `${job.jobId}.metadata.json`), 'utf8'));
    // Provenance records the FIXED server-side image model, distinct from the
    // agent/session model that drove the CLI (#3231).
    expect(sidecar.imageModel).toBe('imagen-3.0-generate-002');
  });

  // agy is a coding agent: when generate_image is quota-exhausted it can still
  // satisfy "a PNG exists at this path" by writing a script that draws one. The
  // bytes pass the signature gate, so the residue left by the script is what
  // catches it (see fabricationGuard.js).
  it('rejects a PNG the agent drew with code instead of generate_image', async () => {
    const failed = vi.fn();
    imageGenEvents.on('failed', failed);
    const job = await agy.generateImage({ prompt: 'a character sheet' });
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('drawn by matplotlib'),
    ]);
    await writeFile(stagingPathFor(job.jobId), png);
    await writeFile(join(tmpdir(), `portos-agy-${job.jobId}`, 'render_sheet.py'), 'import matplotlib');
    await closeChild(0, 0);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && failed.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].error).toContain('drawn by code');
    expect(existsSync(join(FAKE_IMAGES_DIR, job.filename))).toBe(false);
  });

  it('forbids fabricating the image by any other means', () => {
    const prompt = agy._internals.buildAgyPrompt({ prompt: 'a fox', stagingPath: '/tmp/out.png' });
    expect(prompt).toContain('Only the generate_image tool may produce this image');
    expect(prompt).toContain('Reporting the failure is the correct outcome');
  });

  it('never states pixel dimensions, which generate_image cannot honor', () => {
    // AspectRatio is the only size knob (#3231). A "target dimensions" line is
    // an unsatisfiable instruction that invites the agent to reach for code —
    // and it leaked into the artwork as a rendered caption.
    const prompt = agy._internals.buildAgyPrompt({
      prompt: 'a fox', stagingPath: '/tmp/out.png', width: 832, height: 1216,
    });
    expect(prompt).not.toContain('832');
    expect(prompt).not.toContain('1216');
    expect(prompt).toContain('Pass AspectRatio "2:3" to the tool.');
  });

  // The tool's AspectRatio parameter defaults to '1:1', so a render that names
  // only pixel dimensions comes back square no matter what was asked for —
  // measured against agy 1.1.8 (1024×1024 with no ratio, 1376×768 with 16:9).
  // These lock the directive in place; without it, wide comic pages silently
  // render square.
  describe('buildAgyPrompt aspect ratio', () => {
    const build = (width, height) => agy._internals.buildAgyPrompt({
      prompt: 'a fox', stagingPath: '/tmp/out.png', width, height,
    });

    it.each([
      [1024, 1024, '1:1'],
      [1920, 1080, '16:9'],
      [1080, 1920, '9:16'],
      [1024, 768, '4:3'],
      [768, 1024, '3:4'],
      [1500, 1000, '3:2'],
      [1000, 1500, '2:3'],
    ])('directs the nearest supported ratio for %ix%i', (width, height, ratio) => {
      expect(build(width, height)).toContain(`Pass AspectRatio "${ratio}" to the tool.`);
    });

    it('snaps an unsupported ratio to the closest supported one', () => {
      // 21:9 ultrawide has no exact match — 16:9 is nearest.
      expect(build(2560, 1080)).toContain('Pass AspectRatio "16:9" to the tool.');
    });

    it('omits the directive entirely when dimensions are absent', () => {
      const prompt = agy._internals.buildAgyPrompt({ prompt: 'a fox', stagingPath: '/tmp/out.png' });
      expect(prompt).not.toContain('AspectRatio');
    });

    it('keeps the ratio directive out of the image prompt line', () => {
      // Anything on the "Image prompt:" line becomes part of what gets drawn —
      // a directive that leaks in there is rendered as content.
      const promptLine = build(1920, 1080).split('\n').find((l) => l.startsWith('Image prompt:'));
      expect(promptLine).toBe('Image prompt: a fox');
    });
  });

  it('fails closed when the directed output is not an image', async () => {
    const failed = vi.fn();
    imageGenEvents.on('failed', failed);
    const job = await agy.generateImage({ prompt: 'a fox' });
    await writeFile(stagingPathFor(job.jobId), 'not an image');
    await closeChild(0, 0);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && failed.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(failed).toHaveBeenCalledTimes(1);
    expect(existsSync(join(FAKE_IMAGES_DIR, job.filename))).toBe(false);
  });
});
