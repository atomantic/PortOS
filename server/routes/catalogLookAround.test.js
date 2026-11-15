import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { join } from 'node:path';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { falVideoClipQuote } from '../lib/falVideoModels.js';
import { composeLookAroundPrompt, DEFAULT_LOOK_AROUND_MODEL } from '../lib/catalogLookAround.js';

const { __setLookAroundDepsForTests, LOOK_AROUND_CLEANUP_ADDITION } = await import('../services/catalogLookAround.js');
const router = (await import('./catalog.js')).default;
const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);
const base = '/api/catalog/ingredients/plc-1/look-around';

const CLIP = { id: 'aaaaaaaa-0000-4000-8000-000000000001', filename: 'aaaaaaaa-0000-4000-8000-000000000001.mp4', createdAt: '2026-11-01T00:00:00Z',
  modelId: `fal:${DEFAULT_LOOK_AROUND_MODEL}`, prompt: 'pan', lookAround: { ingredientId: 'plc-1', motion: 'half-left', sourceMediaKey: 'plate.png' } };
const OTHER = { ...CLIP, id: 'bbbbbbbb-0000-4000-8000-000000000002', lookAround: { ...CLIP.lookAround, ingredientId: 'plc-2' } };

// A pan to the RIGHT across a textured strip (content slides left 24px a frame); frame 6 is motion-blurred.
const FRAMES = 16;
const FRAME_W = 480;
const FRAME_H = 48;
const SHIFT = 24;
async function writePanFrames(dir) {
  const width = FRAME_W + SHIFT * FRAMES;
  const strip = Buffer.alloc(width * FRAME_H);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < width; x++) {
      strip[y * width + x] = Math.max(0, Math.min(255, Math.round(128 + 60 * Math.sin(x / 9) + 30 * Math.sin(x / 31 + 2) + ((x * 13 + y * 7) % 23) - 11)));
    }
  }
  const paths = [];
  for (let i = 0; i < FRAMES; i++) {
    const path = join(dir, `scan-${String(i + 1).padStart(3, '0')}.png`);
    let image = sharp(strip, { raw: { width, height: FRAME_H, channels: 1 } }).extract({ left: i * SHIFT, top: 0, width: FRAME_W, height: FRAME_H });
    if (i === 6) image = sharp(await image.png().toBuffer()).blur(6);
    await image.png().toFile(path);
    paths.push(path);
  }
  return paths;
}

const state = {};
beforeEach(() => {
  Object.assign(state, {
    place: { id: 'plc-1', type: 'place', name: 'Example harbor', payload: {} },
    media: [{ mediaKey: 'cover.png', kind: 'portrait', role: null, library: {} }, { mediaKey: 'plate.png', kind: 'reference', role: 'plate', library: {} }],
    history: [CLIP, OTHER],
    settings: { videoGen: { fal: { apiKey: 'example-key' } } },
  });
  let saved = 0;
  __setLookAroundDepsForTests({
    getIngredient: vi.fn(async (id) => (id === state.place.id ? state.place : null)),
    listMedia: vi.fn(async () => state.media),
    attachMedia: vi.fn(async (ingredientId, mediaKey, kind, options) => ({ ingredientId, mediaKey, kind, ...options })),
    assertWritable: vi.fn(async (id) => id),
    getSettings: vi.fn(async () => state.settings),
    loadHistory: vi.fn(async () => state.history),
    resolveImage: vi.fn((key) => `/example/images/${key}`),
    readImageDimensions: vi.fn(async () => ({ width: 1280, height: 720 })),
    probe: vi.fn(async () => ({ durationSec: 4, width: 1280, height: 720, fps: 24 })),
    clipPath: vi.fn((filename) => `/example/videos/${filename}`),
    enqueueJob: vi.fn(async () => ({ jobId: 'job-look-1' })),
    listJobs: vi.fn(async () => [{ id: 'job-look-0', status: 'running', progress: 0.4, params: { lookAround: { motion: 'full-turn' } } }]),
    scanFrames: vi.fn(async (_videoPath, { dir }) => writePanFrames(dir)),
    extractFrame: vi.fn(async () => {}),
    saveGalleryImage: vi.fn(async () => ({ filename: `upload-angle${++saved}.png` })),
    cleanupTarget: vi.fn(async () => ({ mode: 'codex', backend: { mode: 'codex' }, settings: {}, local: null, cloud: null })),
    previewCleanup: vi.fn(async (body) => ({ sentPrompt: `wrapped: ${body.prompt}` })),
    enqueueCleanup: vi.fn(async () => ({ jobId: `cleanup-${saved}` })),
  });
});
const deps = () => __setLookAroundDepsForTests({});

describe('look-around routes', () => {
  // Catches a render that runs or attaches before the director has seen its prompt and price.
  it('previews the prompt PortOS writes for the motion and its price without queueing anything', async () => {
    const res = await request(app).post(base).send({ motion: 'half-right', dryRun: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const quote = falVideoClipQuote({ modelId: DEFAULT_LOOK_AROUND_MODEL, seconds: 10, resolution: res.body.resolution, width: 1280, height: 720 });
    expect(res.body).toMatchObject({ dryRun: true, motion: 'half-right', sourceImage: 'plate.png', modelId: DEFAULT_LOOK_AROUND_MODEL,
      seconds: 10, estimatedCostUsd: quote.costUsd, prompt: composeLookAroundPrompt('half-right'), promptIsDefault: true, configured: true });
    expect(res.body.body.prompt).toBe(composeLookAroundPrompt('half-right'));
    expect(res.body.estimatedCostUsd).toBeGreaterThan(0);
    const { enqueueJob, attachMedia } = deps();
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(attachMedia).not.toHaveBeenCalled();
  });

  // Catches the queued job drifting from the preview, or losing the place/plate it belongs to.
  it('queues the same request with look-around provenance and sends an edited prompt as written', async () => {
    const prompt = '  Slow pan, my own words.  ';
    const res = await request(app).post(base).send({ motion: 'full-turn', seconds: 12, prompt });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ jobId: 'job-look-1', prompt, promptIsDefault: false, seconds: 12 });
    const job = deps().enqueueJob.mock.calls[0][0];
    expect(job).toMatchObject({ kind: 'video', owner: 'catalog-look-around:plc-1', params: {
      mode: 'fal', videoMode: 'image', modelId: DEFAULT_LOOK_AROUND_MODEL, prompt, sourceImagePath: '/example/images/plate.png', duration: 12,
      lookAround: { ingredientId: 'plc-1', motion: 'full-turn', sourceMediaKey: 'plate.png' },
    } });
    expect(deps().attachMedia).not.toHaveBeenCalled();
  });

  it('refuses a non-place, an unattached source, a text-only model and a render without a fal key', async () => {
    expect((await request(app).post(base).send({ sourceImage: 'elsewhere.png', dryRun: true })).status).toBe(422);
    expect((await request(app).post(base).send({ modelId: 'fal-ai/minimax/hailuo-02/standard/text-to-video', dryRun: true })).status).toBe(400);
    expect((await request(app).post(base).send({ motion: 'spin', dryRun: true })).status).toBe(400);
    state.settings = {};
    expect((await request(app).post(base).send({ dryRun: true })).body.configured).toBe(false);
    expect((await request(app).post(base).send({})).body.code).toBe('FAL_NOT_CONFIGURED');
    state.place = { ...state.place, type: 'character' };
    expect((await request(app).post(base).send({ dryRun: true })).status).toBe(409);
    expect(deps().enqueueJob).not.toHaveBeenCalled();
  });

  it('lists only this place’s clips and its renders in flight', async () => {
    const res = await request(app).get(base);
    expect(res.status).toBe(200);
    expect(res.body.clips.map((clip) => clip.id)).toEqual([CLIP.id]);
    expect(res.body).toMatchObject({ mainPlate: 'plate.png', configured: true, pending: [{ jobId: 'job-look-0', status: 'running', motion: 'full-turn' }] });
    expect(res.body.models.length).toBeGreaterThan(1);
    expect(res.body.models.every((m) => m.id.includes('image-to-video'))).toBe(true);
  });

  // Catches a blur score that cannot tell a smeared frame, and angle labels taken from the prompt
  // (the clip was asked to turn left but turned right).
  it('scores every frame for blur and places the strip by the turn the frames show', async () => {
    const res = await request(app).post(`${base}/${CLIP.id}/frames`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ clipId: CLIP.id, direction: 'right', directionSource: 'frames', requestedDirection: 'left' });
    expect(res.body.frames).toHaveLength(FRAMES);
    const sharpness = res.body.frames.map((frame) => frame.sharpness);
    expect(sharpness[6]).toBeLessThan(Math.min(...sharpness.filter((_, i) => i !== 6)) * 0.8);
    expect(res.body.frames.at(-1).bearingDeg).toBe(180);
    expect(res.body.frames.map((f) => f.bearingDeg)).toEqual([...res.body.frames.map((f) => f.bearingDeg)].sort((a, b) => a - b));
    expect(res.body.strip.length).toBeGreaterThanOrEqual(3);
    expect(res.body.strip.map((f) => f.atSec)).not.toContain(res.body.frames[6].atSec);
    expect(res.body.strip[0].thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(res.body.strip.at(-1).label).toBe('180° behind');
    expect((await request(app).post(`${base}/${OTHER.id}/frames`).send({})).status).toBe(409);
    expect((await request(app).post(`${base}/not..valid/frames`).send({})).status).toBe(400);
    expect(deps().attachMedia).not.toHaveBeenCalled();
  });

  // Catches kept angles that lose their shared-geometry lineage, or a clip that never joins the place.
  it('attaches kept angles as labelled plates with lineage, the clip as media, and queues lineage-keeping clean-ups', async () => {
    const angles = [{ atSec: 0.5 }, { atSec: 2, name: 'Quay steps' }, { atSec: 3.75, bearingDeg: 175 }];
    const preview = await request(app).post(`${base}/${CLIP.id}/angles`).send({ angles, cleanup: true, dryRun: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.cleanup.sentPrompt).toBe(`wrapped: ${LOOK_AROUND_CLEANUP_ADDITION.text}`);
    expect(deps().attachMedia).not.toHaveBeenCalled();
    expect(deps().enqueueCleanup).not.toHaveBeenCalled();

    const res = await request(app).post(`${base}/${CLIP.id}/angles`).send({ angles, cleanup: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const calls = deps().attachMedia.mock.calls;
    const plates = calls.filter(([, , kind]) => kind === 'reference');
    expect(plates).toHaveLength(3);
    expect(plates.map(([, key, , options]) => [key, options.role, options.library.angle.clipId, options.library.angle.sourceMediaKey]))
      .toEqual([1, 2, 3].map((n) => [`upload-angle${n}.png`, 'plate', CLIP.id, 'plate.png']));
    expect(plates.map(([, , , options]) => options.library.angle.atSec)).toEqual([0.5, 2, 3.75]);
    expect(plates[1][3].library.variant.label).toMatch(/° right · Quay steps$/);
    expect(plates[2][3].library.variant.label).toBe('175° right');
    expect(deps().extractFrame.mock.calls.map(([path, atSec]) => [path, atSec])).toEqual(angles.map(({ atSec }) => [`/example/videos/${CLIP.filename}`, atSec]));
    expect(calls.find(([, , kind]) => kind === 'video')).toMatchObject(['plc-1', CLIP.filename, 'video', { role: 'look-around' }]);
    const cleanups = deps().enqueueCleanup.mock.calls;
    expect(cleanups).toHaveLength(3);
    expect(cleanups[0][0]).toMatchObject({ initImageFile: 'upload-angle1.png', prompt: LOOK_AROUND_CLEANUP_ADDITION.text, width: 1280, height: 720 });
    expect(cleanups[0][1].catalogAttach).toMatchObject({ ingredientId: 'plc-1', role: 'plate', library: {
      angle: { clipId: CLIP.id, sourceMediaKey: 'plate.png' }, derivedFrom: { mediaKey: 'upload-angle1.png', kind: 'reference' } } });
    expect(res.body.cleanupJobs).toHaveLength(3);
    expect((await request(app).post(`${base}/${CLIP.id}/angles`).send({ angles: [{ atSec: 9 }] })).status).toBe(400);
  });
});
