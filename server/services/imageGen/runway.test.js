import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const root = await mkdtemp(join(tmpdir(), 'portos-runway-image-'));
vi.mock('../../lib/fileUtils.js', async (original) => {
  const actual = await original();
  actual.PATHS.images = join(root, 'images');
  return makePathsProxy(actual, { dataRoot: root });
});
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({ videoGen: { runway: { apiKey: 'test-key' } } })) }));
const { PATHS } = await import('../../lib/fileUtils.js');
const runway = await import('./runway.js');
const { imageGenEvents } = await import('../imageGenEvents.js');
const terminals = new Map();
const json = (value) => ({ ok: true, json: async () => value });
let output;
let calls;
let nextTask;

beforeEach(async () => {
  await mkdir(PATHS.images, { recursive: true });
  const raw = Buffer.from(Array.from({ length: 64 * 64 * 3 }, (_, i) => i * 37 % 256));
  output = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).jpeg().toBuffer();
  calls = []; nextTask = { status: 'SUCCEEDED', output: ['https://example.com/result'] };
  imageGenEvents.on('completed', onComplete); imageGenEvents.on('failed', onFailed);
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    if (opts.method === 'POST') return json({ id: 'task-example' });
    if (opts.method === 'DELETE') return json({});
    if (url.endsWith('/task-example')) return json(nextTask);
    return { ok: true, arrayBuffer: async () => output };
  }));
});
const onComplete = (event) => terminals.set(event.generationId, { type: 'completed', ...event });
const onFailed = (event) => terminals.set(event.generationId, { type: 'failed', ...event });
const terminal = async (id) => { await vi.waitFor(() => expect(terminals.has(id)).toBe(true)); return terminals.get(id); };
afterEach(async () => {
  runway.cancelAll(); vi.useRealTimers(); vi.unstubAllGlobals(); terminals.clear();
  imageGenEvents.off('completed', onComplete); imageGenEvents.off('failed', onFailed);
  await rm(root, { recursive: true, force: true });
});

describe('Runway image workflow', () => {
  it('reuses the video credential, files a text-only still as PNG and records the exact sent prompt and price', async () => {
    const job = await runway.generateImage({ prompt: '  A garden  ', width: 1920, height: 1080 });
    expect(await terminal(job.jobId)).toMatchObject({ type: 'completed', mode: 'runway' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.dev.runwayml.com/v1/text_to_image', body: { model: 'gen4_image', promptText: '  A garden  ', ratio: '1280:720' }, headers: { Authorization: 'Bearer test-key' } });
    expect(await sharp(join(PATHS.images, job.filename)).metadata()).toMatchObject({ format: 'png' });
    expect(JSON.parse(await readFile(join(PATHS.images, `${job.jobId}.metadata.json`), 'utf8'))).toMatchObject({ mode: 'runway', model: 'gen4_image', ratio: '1280:720', estimatedCredits: 5, sentPrompt: '  A garden  ' });
  });
  it('sends both bound character anchors with distinct stable tags and records basenames rather than paths', async () => {
    const paths = ['hero.png', 'rival.png'].map((name) => join(PATHS.images, name));
    await Promise.all(paths.map((path) => writeFile(path, output)));
    const visualConditioning = { assets: [{ filename: 'hero.png', bindingId: 'char-a', role: 'character-neutral', label: 'Hero' }, { filename: 'rival.png', bindingId: 'char-b', role: 'character-neutral', label: 'Rival' }] };
    const job = await runway.generateImage({ prompt: 'Two rivals', model: 'gen4_image_turbo', referenceImagePaths: paths, visualConditioning });
    expect(await terminal(job.jobId)).toMatchObject({ type: 'completed' });
    const refs = calls[0].body.referenceImages;
    expect(calls[0].body.promptText).toContain(`@${refs[0].tag}: character-neutral for Hero.`);
    expect(calls[0].body.promptText).toContain(`@${refs[1].tag}: character-neutral for Rival.`);
    expect(refs).toHaveLength(2);
    expect(refs[0].tag).not.toBe(refs[1].tag);
    for (const ref of refs) { expect(ref.uri).toMatch(/^data:image\/jpeg;base64,/); expect(calls[0].body.promptText).toContain(`@${ref.tag}`); }
    const sidecar = JSON.parse(await readFile(join(PATHS.images, `${job.jobId}.metadata.json`), 'utf8'));
    expect(sidecar.referenceTags.map((r) => r.filename)).toEqual(['hero.png', 'rival.png']);
    expect(JSON.stringify(sidecar)).not.toContain(root);
  });
  it('refuses an oversized encoded reference before any paid submission', async () => {
    const path = join(PATHS.images, 'large.png');
    await writeFile(path, Buffer.concat([output, Buffer.alloc(4_000_000)]));
    const job = await runway.generateImage({ prompt: 'A garden', referenceImagePaths: [path] });
    expect(await terminal(job.jobId)).toMatchObject({ type: 'failed', error: expect.stringContaining('after base64 encoding') });
    expect(calls).toEqual([]);
  });
  it('fails a moderated task once with its verbatim reason and permits the next asset', async () => {
    nextTask = { status: 'FAILED', failureCode: 'SAFETY.INPUT', failure: 'Input rejected by Runway moderation.' };
    const job = await runway.generateImage({ prompt: 'A garden' });
    expect(await terminal(job.jobId)).toMatchObject({ type: 'failed', error: nextTask.failure });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    nextTask = { status: 'SUCCEEDED', output: ['https://example.com/result'] };
    const next = await runway.generateImage({ prompt: 'A meadow' });
    expect(await terminal(next.jobId)).toMatchObject({ type: 'completed' });
  });
  it('waits on the same throttled task and cancels it without a resubmission', async () => {
    nextTask = { status: 'THROTTLED' };
    const job = await runway.generateImage({ prompt: 'A garden' });
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/task-example'))).toBe(true));
    expect(runway.cancel(job.jobId)).toBe(true);
    expect(await terminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
