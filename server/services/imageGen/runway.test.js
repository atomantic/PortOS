import { acquireBackupSnapshotCut } from '../../lib/backupSnapshotBoundary.js';
import { existsSync } from 'node:fs';
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
const terminalWaiters = new Map();
const json = (value) => ({ ok: true, json: async () => value });
let output;
let calls;
let nextTask;
let downloadRequested;
let taskPolled;

beforeEach(async () => {
  await mkdir(PATHS.images, { recursive: true });
  const raw = Buffer.from(Array.from({ length: 64 * 64 * 3 }, (_, i) => i * 37 % 256));
  output = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).jpeg().toBuffer();
  calls = []; nextTask = { status: 'SUCCEEDED', output: ['https://example.com/result'] };
  downloadRequested = Promise.withResolvers(); taskPolled = Promise.withResolvers();
  imageGenEvents.on('completed', onComplete); imageGenEvents.on('failed', onFailed);
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    if (opts.method === 'POST') return json({ id: 'task-example' });
    if (opts.method === 'DELETE') return json({});
    if (url.endsWith('/task-example')) { taskPolled.resolve(); return json(nextTask); }
    downloadRequested.resolve();
    return { ok: true, arrayBuffer: async () => output };
  }));
});
const recordTerminal = (type, event) => {
  const result = { type, ...event };
  terminals.set(event.generationId, result);
  terminalWaiters.get(event.generationId)?.resolve(result);
  terminalWaiters.delete(event.generationId);
};
const onComplete = (event) => recordTerminal('completed', event);
const onFailed = (event) => recordTerminal('failed', event);
// Completion includes native image conversion and atomic filesystem writes.
// Await the event under the test's deadline, rather than imposing a 1s poll.
const terminal = (id) => {
  if (terminals.has(id)) return Promise.resolve(terminals.get(id));
  if (!terminalWaiters.has(id)) terminalWaiters.set(id, Promise.withResolvers());
  return terminalWaiters.get(id).promise;
};
afterEach(async () => {
  runway.cancelAll(); vi.useRealTimers(); vi.unstubAllGlobals(); terminals.clear(); terminalWaiters.clear();
  imageGenEvents.off('completed', onComplete); imageGenEvents.off('failed', onFailed);
  await rm(root, { recursive: true, force: true });
});

describe('Runway image workflow', () => {
  it('reuses the video credential, files a text-only still as PNG and records the exact sent prompt and price', async () => {
    const releaseCut = await acquireBackupSnapshotCut();
    let job;
    try {
      job = await runway.generateImage({ prompt: '  A garden  ', width: 1920, height: 1080 });
      await downloadRequested.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(existsSync(join(PATHS.images, job.filename))).toBe(false);
      expect(terminals.has(job.jobId)).toBe(false);
    } finally { releaseCut(); }
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
  it('renders an unseeded third-party model with more than three untagged references', async () => {
    const paths = Array.from({ length: 5 }, (_, i) => join(PATHS.images, `reference-${i}.png`));
    await Promise.all(paths.map((path) => writeFile(path, output)));
    const job = await runway.generateImage({ prompt: 'A cast in a garden', model: 'muse_image', seed: 42, referenceImagePaths: paths });
    expect(await terminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(calls[0].body).toMatchObject({ model: 'muse_image', ratio: '1600:1600' });
    expect(calls[0].body).not.toHaveProperty('seed');
    expect(calls[0].body.referenceImages).toHaveLength(5);
    expect(calls[0].body.referenceImages.every((ref) => Object.keys(ref).join() === 'uri')).toBe(true);
    expect(calls[0].body.promptText).toContain('Image 5: visual reference');
    expect(calls[0].body.promptText).not.toContain('@ref_');
  });
  it('reports the supplied and added prompt lengths before spending instead of silently cutting text', async () => {
    await expect(runway.generateImage({ prompt: 'x'.repeat(990), negativePrompt: 'a long negative' })).rejects.toMatchObject({
      status: 400, code: 'RUNWAY_IMAGE_PROMPT_TOO_LONG',
      message: expect.stringContaining('990 supplied, plus 24 from reference tags and the negative prompt'),
    });
    expect(calls).toEqual([]);
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
    await taskPolled.promise;
    expect(runway.cancel(job.jobId)).toBe(true);
    expect(await terminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
