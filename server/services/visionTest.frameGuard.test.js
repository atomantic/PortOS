/**
 * Degenerate-frame gate on the vision path (issue #4173): a blank screenshot
 * must never be forwarded to a vision provider, because that spends a real
 * (often paid) call asking a model to describe a solid black square.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

let dir;

vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(async () => ({
    id: 'lmstudio', type: 'api', endpoint: 'http://127.0.0.1:1234/v1', defaultModel: 'vision-model',
  })),
}));
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('./ollamaManager.js', () => ({ ensureProviderReady: vi.fn(async () => ({ success: true })) }));
vi.mock('./visionCli.js', () => ({ describeImageViaCli: vi.fn() }));
vi.mock('../lib/aiToolkit/internal/endpointGuard.js', () => ({
  assertSecretEndpoint: vi.fn(),
  evaluateSecretEndpoint: vi.fn(() => ({ ok: true })),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, screenshots: '/unused-in-this-suite' },
    resolveScreenshot: vi.fn((name) => join(dir, name)),
  };
});

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { testVision } from './visionTest.js';

const SIDE = 64;
const write = async (name, buffer) => { await writeFile(join(dir, name), buffer); return name; };
const solid = (background) => sharp({ create: { width: SIDE, height: SIDE, channels: 3, background } }).png().toBuffer();
const real = () => {
  const raw = Buffer.alloc(SIDE * SIDE * 3);
  for (let p = 0; p < SIDE * SIDE; p++) {
    raw[p * 3] = p % 256; raw[p * 3 + 1] = (p * 3) % 256; raw[p * 3 + 2] = (p * 7) % 256;
  }
  return sharp(raw, { raw: { width: SIDE, height: SIDE, channels: 3 } }).png().toBuffer();
};

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'portos-visiontest-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => { vi.clearAllMocks(); });

describe('testVision degenerate-frame gate', () => {
  it('refuses to spend a vision call on a solid-fill screenshot', async () => {
    const name = await write('blank.png', await solid({ r: 0, g: 0, b: 0 }));
    await expect(testVision({ imagePath: name, prompt: 'what is this?', expectedContent: 'cat' }))
      .rejects.toThrow(/no content/i);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('still sends a real screenshot to the provider', async () => {
    const name = await write('real.png', await real());
    vi.mocked(fetchWithTimeout).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'a cat' } }] }),
    });
    const result = await testVision({ imagePath: name, prompt: 'what is this?', expectedContent: 'cat' });
    expect(fetchWithTimeout).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('does not block an undecodable screenshot on this gate — that is a different failure', async () => {
    const name = await write('garbage.png', Buffer.from('not a png'));
    vi.mocked(fetchWithTimeout).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'unreadable' } }] }),
    });
    await testVision({ imagePath: name, prompt: 'what is this?', expectedContent: 'unreadable' });
    expect(fetchWithTimeout).toHaveBeenCalled();
  });
});
