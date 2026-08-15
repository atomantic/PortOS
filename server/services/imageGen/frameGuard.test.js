import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

// The dispatcher pulls in every provider module; stub them so the suite stays
// about the degenerate-frame gate and nothing spawns a CLI or touches settings.
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('./local.js', () => ({ generateImage: vi.fn(), getActiveJob: () => null, attachSseClient: () => false, cancel: () => false }));
vi.mock('./codex.js', () => ({ generateImage: vi.fn(), getActiveJob: () => null, attachSseClient: () => false, cancelAll: () => false }));
vi.mock('./grok.js', () => ({ generateImage: vi.fn(), getActiveJob: () => null, attachSseClient: () => false, cancelAll: () => false }));
vi.mock('./agy.js', () => ({ generateImage: vi.fn(), getActiveJob: () => null, attachSseClient: () => false, cancelAll: () => false }));
vi.mock('./external.js', () => ({ generateImage: vi.fn(), checkConnection: vi.fn(), getActiveJob: () => null }));

import * as external from './external.js';
import { generateImage } from './index.js';
import { degenerateFrameReason, rejectDegenerateFrame } from './frameGuard.js';

let dir;
const SIDE = 64;

const writePng = async (name, buffer) => {
  dir ||= await mkdtemp(join(tmpdir(), 'portos-framegate-'));
  const path = join(dir, name);
  await writeFile(path, buffer);
  return path;
};

const solidPng = (background) => sharp({
  create: { width: SIDE, height: SIDE, channels: 3, background },
}).png().toBuffer();

const realPng = () => {
  const raw = Buffer.alloc(SIDE * SIDE * 3);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const i = (y * SIDE + x) * 3;
      raw[i] = (x * 3) % 256;
      raw[i + 1] = (y * 5) % 256;
      raw[i + 2] = (x + y) % 256;
    }
  }
  return sharp(raw, { raw: { width: SIDE, height: SIDE, channels: 3 } }).png().toBuffer();
};

const exists = (p) => access(p).then(() => true, () => false);

beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('degenerateFrameReason', () => {
  it('narrates a solid-fill frame in words the UI can show', async () => {
    const path = await writePng('black.png', await solidPng({ r: 0, g: 0, b: 0 }));
    const reason = await degenerateFrameReason(path);
    expect(reason).toMatch(/no content/i);
    expect(reason).toMatch(/flat color/i);
  });

  it('passes a real frame through', async () => {
    const path = await writePng('real.png', await realPng());
    expect(await degenerateFrameReason(path)).toBeNull();
  });

  it('passes an undecodable file through — that is the INVALID_IMAGE path, not this gate', async () => {
    const path = await writePng('garbage.png', Buffer.from('not a png'));
    expect(await degenerateFrameReason(path)).toBeNull();
  });

  it('passes a not-yet-written file through rather than inventing a failure', async () => {
    expect(await degenerateFrameReason(join(tmpdir(), 'portos-does-not-exist-4173.png'))).toBeNull();
    expect(await degenerateFrameReason(null)).toBeNull();
  });

  it('rejectDegenerateFrame deletes the empty PNG, and leaves a real one alone', async () => {
    const empty = await writePng('empty.png', await solidPng({ r: 255, g: 255, b: 255 }));
    expect(await rejectDegenerateFrame(empty)).toMatch(/no content/i);
    expect(await exists(empty)).toBe(false);

    const good = await writePng('keep.png', await realPng());
    expect(await rejectDegenerateFrame(good)).toBeNull();
    expect(await exists(good)).toBe(true);
  });
});

describe('generateImage degenerate-frame gate', () => {
  it('surfaces a failure when a provider writes a solid-fill PNG', async () => {
    const outputPath = await writePng('provider-solid.png', await solidPng({ r: 0, g: 0, b: 0 }));
    vi.mocked(external.generateImage).mockResolvedValue({
      filename: 'provider-solid.png', path: '/data/images/provider-solid.png', outputPath,
    });

    await expect(generateImage({ prompt: 'a cat' })).rejects.toMatchObject({ code: 'DEGENERATE_FRAME' });
    // No gallery record: the empty frame is gone from disk too.
    expect(await exists(outputPath)).toBe(false);
  });

  it('returns the artifact untouched when the frame has real content', async () => {
    const outputPath = await writePng('provider-real.png', await realPng());
    const artifact = { filename: 'provider-real.png', path: '/data/images/provider-real.png', outputPath };
    vi.mocked(external.generateImage).mockResolvedValue(artifact);

    await expect(generateImage({ prompt: 'a cat' })).resolves.toBe(artifact);
    expect(await exists(outputPath)).toBe(true);
  });

  it('lets a job-based provider return its jobId before the render lands', async () => {
    // Nothing is on disk yet — the gate must not read that as an empty frame.
    const artifact = { jobId: 'job-1', generationId: 'job-1', filename: 'pending.png', path: '/data/images/pending.png' };
    vi.mocked(external.generateImage).mockResolvedValue(artifact);
    await expect(generateImage({ prompt: 'a cat' })).resolves.toBe(artifact);
  });
});
