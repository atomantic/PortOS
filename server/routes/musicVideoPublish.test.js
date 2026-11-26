/**
 * Publish routes (#18326) at the HTTP boundary: reviewer gating, schema refusals and
 * route-to-service wiring. Browser, model and encode sinks are mocked; post/cross-link
 * state round-trips through the real project store in a temp data root.
 */
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-publish-routes-') }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const auth = vi.hoisted(() => ({ authenticated: true }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: async () => true,
  verifyRequestSessionIdentity: async req => (auth.authenticated || req.headers.authorization === 'Bearer agent')
    ? { kind: 'session', sessionId: 'synthetic-session', label: null } : null,
}));

const sinks = vi.hoisted(() => ({
  previewPublishPost: vi.fn(async () => ({ rows: [], missing: [] })),
  prepareCrossLinkEdit: vi.fn(async () => ({ target: 'youtube', links: [] })),
  capturePublishKitFrame: vi.fn(async () => ({ project: { id: 'synthetic' } })),
  getPublishKitCropPreview: vi.fn(),
  startPublishKitBuild: vi.fn(async () => ({ jobId: 'mvpk-synthetic' })),
  draftPublishKitCopy: vi.fn(async () => ({ project: { drafted: true } })),
  updatePublishKitCopy: vi.fn(async () => ({ project: { patched: true } })),
  buildThumbnailPaintPrompt: vi.fn(() => ({ prompt: 'synthetic prompt' })),
  addYoutubeThumbnailTest: vi.fn(async () => ({ project: { added: true } })),
  removeYoutubeThumbnailTest: vi.fn(async () => ({ project: { removed: true } })),
}));
vi.mock('../services/musicVideo/publish/index.js', async original => ({ ...await original(),
  previewPublishPost: sinks.previewPublishPost, prepareCrossLinkEdit: sinks.prepareCrossLinkEdit }));
vi.mock('../services/musicVideo/publishKit.js', async original => ({ ...await original(),
  getPublishKitCropPreview: sinks.getPublishKitCropPreview, startPublishKitBuild: sinks.startPublishKitBuild,
  capturePublishKitFrame: sinks.capturePublishKitFrame, draftPublishKitCopy: sinks.draftPublishKitCopy, updatePublishKitCopy: sinks.updatePublishKitCopy }));
vi.mock('../services/musicVideo/youtubeThumbnail.js', async original => ({ ...await original(),
  buildThumbnailPaintPrompt: sinks.buildThumbnailPaintPrompt, addYoutubeThumbnailTest: sinks.addYoutubeThumbnailTest, removeYoutubeThumbnailTest: sinks.removeYoutubeThumbnailTest }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

let base, projectId;
beforeAll(async () => {
  ({ id: projectId } = await projects.createProject({ name: 'Example Song' }));
  base = `/api/music-video/${projectId}`;
});
beforeEach(() => { auth.authenticated = true; vi.clearAllMocks(); });
afterAll(cleanupTempDataRoots);

it('accepts Web mastering on an explicit build and defaults a bodyless request to As mixed', async () => {
  const path = `${base}/publish-kit/build`;
  expect((await request(app).post(path).send({ loudnessPreset: '-14' })).status).toBe(400);
  expect(sinks.startPublishKitBuild).not.toHaveBeenCalled();
  expect((await request(app).post(path)).body).toEqual({ jobId: 'mvpk-synthetic' });
  expect(sinks.startPublishKitBuild).toHaveBeenLastCalledWith(projectId, { loudnessPreset: 'as-mixed' });
  expect((await request(app).post(path).send({ loudnessPreset: 'web' })).body).toEqual({ jobId: 'mvpk-synthetic' });
  expect(sinks.startPublishKitBuild).toHaveBeenLastCalledWith(projectId, { loudnessPreset: 'web' });
});

describe('POST /:id/publish/:target/cross-links', () => {
  it('refuses an unauthenticated caller before touching the browser', async () => {
    auth.authenticated = false;
    const res = await request(app).post(`${base}/publish/youtube/cross-links`).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(sinks.prepareCrossLinkEdit).not.toHaveBeenCalled();
  });

  it('strips the password before strict validation for an authorized caller', async () => {
    auth.authenticated = false; // only the bearer credential authorizes this call
    const res = await request(app).post(`${base}/publish/youtube/cross-links`).set('authorization', 'Bearer agent').send({ password: 'synthetic-password' });
    expect(res.status).toBe(200);
    expect(sinks.prepareCrossLinkEdit).toHaveBeenCalledWith(projectId, 'youtube');
  });

  it('rejects a target without an edit form and unknown body keys', async () => {
    expect((await request(app).post(`${base}/publish/tiktok/cross-links`).send({})).status).toBe(400);
    expect((await request(app).post(`${base}/publish/youtube/cross-links`).send({ extra: true })).status).toBe(400);
    expect(sinks.prepareCrossLinkEdit).not.toHaveBeenCalled();
  });
});

describe('post records and cross-link toggle', () => {
  it('records, rates and removes a post, round-tripping the stored project', async () => {
    const put = await request(app).put(`${base}/publish/posts/youtube`).send({ url: 'https://example.com/watch/1', reception: 'good' });
    expect(put.status).toBe(200);
    expect(put.body.post).toMatchObject({ url: 'https://example.com/watch/1', reception: 'good' });
    expect((await request(app).get(base)).body.publishKit.posts.youtube.url).toBe('https://example.com/watch/1');
    const del = await request(app).delete(`${base}/publish/posts/youtube`);
    expect(del.status).toBe(200);
    expect(del.body.project.publishKit.posts.youtube).toBeUndefined();
  });

  it('refuses a bad target, an empty record and unknown keys', async () => {
    expect((await request(app).put(`${base}/publish/posts/myspace`).send({ url: 'https://example.com/x' })).status).toBe(400);
    expect((await request(app).delete(`${base}/publish/posts/myspace`)).status).toBe(400);
    expect((await request(app).put(`${base}/publish/posts/youtube`).send({})).status).toBe(400);
    expect((await request(app).put(`${base}/publish/posts/youtube`).send({ url: 'not a url' })).status).toBe(400);
    expect((await request(app).put(`${base}/publish/posts/youtube`).send({ url: 'https://example.com/x', bogus: 1 })).status).toBe(400);
  });

  it('persists the cross-link toggle and refuses a non-boolean', async () => {
    const on = await request(app).put(`${base}/publish/cross-links`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.project.publishKit.crossLinks).toBe(true);
    expect((await request(app).put(`${base}/publish/cross-links`).send({ enabled: false })).body.project.publishKit.crossLinks).toBe(false);
    expect((await request(app).put(`${base}/publish/cross-links`).send({ enabled: 'yes' })).status).toBe(400);
  });

  it('previews a post read-only and refuses a bad target or option', async () => {
    const res = await request(app).post(`${base}/publish/reddit/preview`).send({ subreddit: 'example' });
    expect(res.status).toBe(200);
    expect(sinks.previewPublishPost).toHaveBeenCalledWith(projectId, 'reddit', { subreddit: 'example' });
    expect((await request(app).post(`${base}/publish/myspace/preview`).send({})).status).toBe(400);
    expect((await request(app).post(`${base}/publish/reddit/preview`).send({ bogus: 1 })).status).toBe(400);
  });
});

describe('publish kit routes', () => {
  it('binds cropped builds to preview metadata and validates the normalized position', async () => {
    const preview = { renderHistoryId: 'render-1', filename: 'master.mp4', width: 1920, height: 1080, startSec: 3, endSec: 30 };
    sinks.getPublishKitCropPreview.mockResolvedValue(preview);
    const shown = await request(app).get(`${base}/publish-kit/crop-preview`);
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual(preview);
    expect(sinks.getPublishKitCropPreview).toHaveBeenCalledWith(projectId);
    const { post } = request(app);
    expect((await post(`${base}/publish-kit/build`)).status).toBe(200);
    expect(sinks.startPublishKitBuild).toHaveBeenLastCalledWith(projectId, { loudnessPreset: 'as-mixed' });
    const crop = { ...shown.body, position: 0 };
    expect((await post(`${base}/publish-kit/build`).send({ crop, loudnessPreset: 'web' })).status).toBe(200);
    expect(sinks.startPublishKitBuild).toHaveBeenLastCalledWith(projectId, { crop, loudnessPreset: 'web' });
    for (const invalid of [{ position: -0.01 }, { position: 1.01 }, { position: '0.5' }, { renderHistoryId: '' }, { endSec: 3 }]) {
      expect((await post(`${base}/publish-kit/build`).send({ crop: { ...crop, ...invalid } })).status).toBe(400);
    }
    expect(sinks.startPublishKitBuild).toHaveBeenCalledTimes(2);
  });
  it('answers 404 NOT_FOUND for the events of an unknown job', async () => {
    const res = await request(app).get('/api/music-video/publish-kit/mvpk-missing/events');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('cancels nothing for an unknown job', async () => {
    const res = await request(app).post('/api/music-video/publish-kit/mvpk-missing/cancel');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('captures a frame and refuses a negative or unknown-key body', async () => {
    const ok = await request(app).post(`${base}/publish-kit/frame`).send({ atSec: 3.5 });
    expect(ok.status).toBe(200);
    expect(sinks.capturePublishKitFrame).toHaveBeenCalledWith(projectId, 3.5);
    expect((await request(app).post(`${base}/publish-kit/frame`).send({ atSec: -1 })).status).toBe(400);
    expect((await request(app).post(`${base}/publish-kit/frame`).send({ atSec: 1, extra: 1 })).status).toBe(400);
    expect(sinks.capturePublishKitFrame).toHaveBeenCalledTimes(1);
  });

  it('drafts and patches publish copy through the services, validating input', async () => {
    const draft = await request(app).post(`${base}/publish-kit/copy`).send({ notes: 'Synthetic notes', length: 'short' });
    expect(draft.status).toBe(200);
    expect(draft.body.project).toEqual({ drafted: true });
    expect(sinks.draftPublishKitCopy).toHaveBeenCalledWith(projectId, expect.objectContaining({ notes: 'Synthetic notes', length: 'short' }));
    expect((await request(app).post(`${base}/publish-kit/copy`).send({ length: 'huge' })).status).toBe(400);
    const patch = await request(app).patch(`${base}/publish-kit/copy`).send({ youtube: { title: 'Example title' } });
    expect(patch.status).toBe(200);
    expect(sinks.updatePublishKitCopy).toHaveBeenCalledWith(projectId, { youtube: { title: 'Example title' } });
    expect((await request(app).patch(`${base}/publish-kit/copy`).send({ youtube: { bogus: 'x' } })).status).toBe(400);
  });

  it('previews the thumbnail paint prompt and refuses an empty title', async () => {
    const ok = await request(app).post(`${base}/publish-kit/youtube-thumbnail/paint/preview`).send({ title: 'Example' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ prompt: 'synthetic prompt' });
    expect(sinks.buildThumbnailPaintPrompt).toHaveBeenCalledWith({ title: 'Example' });
    expect((await request(app).post(`${base}/publish-kit/youtube-thumbnail/paint/preview`).send({ title: '  ' })).status).toBe(400);
  });

  it('adds and removes Test & Compare thumbnail variants', async () => {
    const add = await request(app).post(`${base}/publish-kit/youtube-thumbnail/tests`);
    expect(add.status).toBe(200);
    expect(add.body.project).toEqual({ added: true });
    expect(sinks.addYoutubeThumbnailTest).toHaveBeenCalledWith(projectId);
    const del = await request(app).delete(`${base}/publish-kit/youtube-thumbnail/tests/variant-1.jpg`);
    expect(del.status).toBe(200);
    expect(del.body.project).toEqual({ removed: true });
    expect(sinks.removeYoutubeThumbnailTest).toHaveBeenCalledWith(projectId, 'variant-1.jpg');
  });
});
