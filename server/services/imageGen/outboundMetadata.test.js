import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const root = await mkdtemp(join(tmpdir(), 'portos-outbound-meta-'));
const FAKE_IMAGES_DIR = join(root, 'images');

vi.mock('../../lib/fileUtils.js', async (original) => {
  const actual = await original();
  actual.PATHS.images = FAKE_IMAGES_DIR;
  return makePathsProxy(actual, { dataRoot: root });
});

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({
    videoGen: { google: { apiKey: 'test-google-key', projectId: 'test-project' } },
  })),
}));

const spawnCalls = [];
vi.mock('../../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((command, args, opts) => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new EventEmitter();
      child.stdin.write = vi.fn((chunk) => { child.stdinData = `${child.stdinData || ''}${chunk}`; return true; });
      child.stdin.end = vi.fn();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      spawnCalls.push({ command, args, opts, child });
      return child;
    }),
  };
});

const googleImage = await import('./google.js');
const grokImage = await import('./grok.js');
const agyImage = await import('./agy.js');
const codexImage = await import('./codex.js');
const { imageGenEvents } = await import('../imageGenEvents.js');
const { fileToDataUri } = await import('../falQueue.js');
const { frameDataUriAtAspect } = await import('../videoGen/falFrameAspect.js');
const { uploadHiggsfieldImage } = await import('../higgsfieldApi.js');

const noiseRaw = (width, height) => {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 7) * 91) % 256;
  return raw;
};

async function makeJpegWithGpsAndXmp(width = 64, height = 64) {
  const withExif = await sharp(noiseRaw(width, height), { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Make: 'TestPhone', Model: 'PhoneX' }, IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' } })
    .jpeg({ quality: 85 })
    .toBuffer();
  const xmpPayload = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>private-location-tag</x:xmpmeta>');
  const len = xmpPayload.length + 2;
  const xmpSeg = Buffer.concat([Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]), xmpPayload]);
  return Buffer.concat([withExif.subarray(0, 2), xmpSeg, withExif.subarray(2)]);
}

async function makePngWithExif(width = 64, height = 64) {
  return sharp(noiseRaw(width, height), { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N' } })
    .png()
    .toBuffer();
}

const closeSpawned = async (index = 0) => {
  const call = spawnCalls[index];
  if (!call) return;
  call.child.exitCode = 1;
  call.child.emit('close', 1, null);
  await new Promise((r) => setTimeout(r, 25));
};

beforeEach(async () => {
  spawnCalls.length = 0;
  imageGenEvents.removeAllListeners();
  await rm(FAKE_IMAGES_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_IMAGES_DIR, { recursive: true });
});

afterEach(async () => {
  for (let i = 0; i < spawnCalls.length; i += 1) {
    if (spawnCalls[i].child.exitCode == null) await closeSpawned(i);
  }
  vi.unstubAllGlobals();
  imageGenEvents.removeAllListeners();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('outbound metadata stripping', () => {
  it('strips GPS EXIF from an in-budget JPEG sent to Google image generation without re-encoding', async () => {
    const source = await makeJpegWithGpsAndXmp();
    await writeFile(join(FAKE_IMAGES_DIR, 'google-gps.jpg'), source);
    const outPng = await sharp(noiseRaw(32, 32), { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();

    const posted = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      posted.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: outPng.toString('base64') } }] } }],
        }),
      };
    }));

    const done = Promise.withResolvers();
    imageGenEvents.on('completed', (e) => done.resolve({ type: 'completed', ...e }));
    imageGenEvents.on('failed', (e) => done.resolve({ type: 'failed', ...e }));

    const job = await googleImage.generateImage({
      model: 'gemini-2.5-flash-image',
      prompt: 'studio portrait',
      referenceImagePaths: ['google-gps.jpg'],
    });
    expect(await done.promise).toMatchObject({ type: 'completed', generationId: job.jobId });

    const parts = posted[0].body.contents[0].parts;
    const inlinePart = parts.find((p) => p.inlineData);
    expect(inlinePart.inlineData.mimeType).toBe('image/jpeg');
    const sent = Buffer.from(inlinePart.inlineData.data, 'base64');
    const meta = await sharp(sent).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(sent.includes(Buffer.from('private-location-tag'))).toBe(false);
    // Compressed JPEG scan data (SOS 0xFF 0xDA to EOI) is byte-identical.
    const sos = Buffer.from([0xff, 0xda]);
    expect(sent.subarray(sent.indexOf(sos)).equals(source.subarray(source.indexOf(sos)))).toBe(true);
  });

  it('strips EXIF/XMP on fileToDataUri and uncropped frameDataUriAtAspect (fal, Google, Higgsfield, Runway video)', async () => {
    const jpgPath = join(FAKE_IMAGES_DIR, 'frame-gps.jpg');
    const pngPath = join(FAKE_IMAGES_DIR, 'frame-exif.png');
    await writeFile(jpgPath, await makeJpegWithGpsAndXmp(64, 36));
    await writeFile(pngPath, await makePngWithExif(64, 36));

    const jpgUri = await fileToDataUri(jpgPath);
    const jpgSent = Buffer.from(jpgUri.slice(jpgUri.indexOf(',') + 1), 'base64');
    expect((await sharp(jpgSent).metadata()).exif).toBeUndefined();
    expect(jpgSent.includes(Buffer.from('private-location-tag'))).toBe(false);

    // 64x36 is already 16:9, so frameDataUriAtAspect takes the uncropped pass-through.
    const framed = await frameDataUriAtAspect(pngPath, '16:9');
    expect(framed.conformed).toBeNull();
    const pngSent = Buffer.from(framed.dataUri.slice(framed.dataUri.indexOf(',') + 1), 'base64');
    expect((await sharp(pngSent).metadata()).exif).toBeUndefined();
  });

  it('strips EXIF/XMP before uploadHiggsfieldImage PUTs bytes', async () => {
    const jpgPath = join(FAKE_IMAGES_DIR, 'hf-gps.jpg');
    await writeFile(jpgPath, await makeJpegWithGpsAndXmp());

    let putBody = null;
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      if (opts.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ upload_url: 'https://storage.example.com/put', public_url: 'https://cdn.example.com/img.jpg' }),
        };
      }
      putBody = opts.body;
      return { ok: true, status: 200 };
    }));

    const url = await uploadHiggsfieldImage({ apiKey: 'k:s', path: jpgPath });
    expect(url).toBe('https://cdn.example.com/img.jpg');
    const meta = await sharp(putBody).metadata();
    expect(meta.exif).toBeUndefined();
    expect(putBody.includes(Buffer.from('private-location-tag'))).toBe(false);
  });

  it('hands Grok, Agy, and Codex CLI tools a metadata-free file path while keeping gallery originals intact', async () => {
    const source = await makeJpegWithGpsAndXmp();
    const origPath = join(FAKE_IMAGES_DIR, 'cli-gps.jpg');
    await writeFile(origPath, source);

    // Grok
    await grokImage.generateImage({ prompt: 'relight', initImagePath: 'cli-gps.jpg' });
    const grokPrompt = spawnCalls[0].child.stdinData;
    const grokPathMatch = grokPrompt.match(/source image at ([^\s]+)/);
    expect(grokPathMatch).toBeTruthy();
    const grokStagedPath = grokPathMatch[1];
    expect(grokStagedPath).not.toBe(origPath);
    const grokBytes = await readFile(grokStagedPath);
    expect((await sharp(grokBytes).metadata()).exif).toBeUndefined();
    expect(grokBytes.includes(Buffer.from('private-location-tag'))).toBe(false);
    await closeSpawned(0);

    // Agy
    await agyImage.generateImage({ prompt: 'relight', initImagePath: 'cli-gps.jpg' });
    const agyArgs = spawnCalls[1].args;
    const agyPrompt = agyArgs[agyArgs.indexOf('--print') + 1];
    const agyPathMatch = agyPrompt.match(/in this order: ([^\n]+)/);
    expect(agyPathMatch).toBeTruthy();
    const agyStagedPath = agyPathMatch[1].trim();
    expect(agyStagedPath).not.toBe(origPath);
    const agyBytes = await readFile(agyStagedPath);
    expect((await sharp(agyBytes).metadata()).exif).toBeUndefined();
    expect(agyBytes.includes(Buffer.from('private-location-tag'))).toBe(false);
    await closeSpawned(1);

    // Codex
    await codexImage.generateImage({ prompt: 'relight', initImagePath: 'cli-gps.jpg' });
    const codexArgs = spawnCalls[2].args;
    const codexStagedPath = codexArgs[codexArgs.indexOf('-i') + 1];
    expect(codexStagedPath).not.toBe(origPath);
    const codexBytes = await readFile(codexStagedPath);
    expect((await sharp(codexBytes).metadata()).exif).toBeUndefined();
    expect(codexBytes.includes(Buffer.from('private-location-tag'))).toBe(false);
    await closeSpawned(2);

    // Gallery original was never mutated.
    expect((await readFile(origPath)).equals(source)).toBe(true);
  });
});
