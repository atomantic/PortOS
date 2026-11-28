import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('making-of-story-test-');
vi.mock('../lib/paths.js', async (actual) => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../lib/fileUtils.js', async (actual) => makePathsProxy(await actual(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { getSettings: vi.fn(async () => ({})), settingsEvents: new EventEmitter() };
});

const { default: router } = await import('./musicVideoMakingOfStory.js');
const projects = await import('../services/musicVideo/projects.js');
const { sanitizeRecordForWire } = await import('../lib/syncWire.js');
const { formatMakingOfPostCopy } = await import('../lib/musicVideo/musicVideoMakingOfStory.js');

function call(method, path, params, body) {
  return new Promise((resolve, reject) => {
    const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
    if (!route) {
      reject(new Error(`Route not found: ${method} ${path}`));
      return;
    }
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) {
        if (this.statusCode >= 400) reject(new Error(value.error?.message || value.error || 'Request rejected'));
        else resolve({ status: this.statusCode, body: value });
      },
    };
    route.route.stack[0].handle({ params, body, app: { get: () => null }, method, url: path }, res, reject);
  });
}

afterAll(cleanupTempDataRoots);

describe('music video making-of story routes and persistence', () => {
  it('captures labeled/tagged media items, attaches to new and existing posts, deduplicates by asset, and cascades deletes', async () => {
    const project = await projects.createProject({ name: 'Example Video' });
    expect(project.makingOfStory).toBeUndefined();

    // Capture a failed still and create a post in one step.
    const captured = await call('post', '/:id/making-of/items', { id: project.id }, {
      kind: 'image',
      assetId: 'example-fail.png',
      sceneId: 'mvs-shot-1',
      label: 'First broken attempt',
      role: 'fail',
      tags: [' #Scale ', 'Ruler Sheet', 'scale'],
      note: 'Subject towered over the doorway.',
      newPostTitle: 'Fixing character height drift',
    });
    expect(captured.status).toBe(201);
    expect(captured.body.item.tags).toEqual(['scale', 'ruler-sheet']);
    expect(captured.body.createdPost.title).toBe('Fixing character height drift');
    expect(captured.body.createdPost.itemIds).toEqual([captured.body.item.id]);

    // Capturing the same asset again updates metadata in place rather than duplicating.
    const recaptured = await call('post', '/:id/making-of/items', { id: project.id }, {
      kind: 'image',
      assetId: 'example-fail.png',
      label: 'Updated broken attempt',
      role: 'before',
      tags: ['scale', 'backplate'],
      note: 'Updated note.',
      postId: captured.body.createdPost.id,
    });
    expect(recaptured.body.item.id).toBe(captured.body.item.id);
    expect(recaptured.body.story.items).toHaveLength(1);
    expect(recaptured.body.story.posts[0].itemIds).toEqual([captured.body.item.id]);

    // Capture a video clip and attach it to the same post.
    const videoCapture = await call('post', '/:id/making-of/items', { id: project.id }, {
      kind: 'video',
      assetId: 'clip-example-01',
      label: 'Fixed motion take',
      role: 'after',
      tags: ['scale', 'final'],
      postId: captured.body.createdPost.id,
    });
    expect(videoCapture.body.story.items).toHaveLength(2);
    expect(videoCapture.body.story.posts[0].itemIds).toEqual([captured.body.item.id, videoCapture.body.item.id]);

    // Update the post to staged -> posted with per-part media and a public URL and verify formatted copy.
    const updatedPost = await call('patch', '/:id/making-of/posts/:postId', {
      id: project.id,
      postId: captured.body.createdPost.id,
    }, {
      status: 'posted',
      platform: 'x',
      summary: 'How a joint comparison sheet fixed giant characters.',
      body: 'Post 1: Giant characters.\n\n---\n\nPost 2: Ruler sheet solved it.',
      partItemIds: [[captured.body.item.id], [videoCapture.body.item.id]],
      publishedUrl: 'https://example.com/status/12345',
    });
    expect(updatedPost.body.post.status).toBe('posted');
    expect(updatedPost.body.post.publishedAt).toBeTruthy();
    expect(updatedPost.body.post.partItemIds).toEqual([[captured.body.item.id], [videoCapture.body.item.id]]);
    const copy = formatMakingOfPostCopy(updatedPost.body.post, updatedPost.body.story.items, { includeMedia: true });
    expect(copy).toContain('Post 1: Giant characters.');
    expect(copy).toContain('Attachments (Part 1):');
    expect(copy).toContain('Updated broken attempt [image: example-fail.png]');
    expect(copy).toContain('Attachments (Part 2):');
    expect(copy).toContain('Fixed motion take [video: clip-example-01]');

    // Deleting an item removes it from both itemIds and partItemIds cleanly.
    const afterDelete = await call('delete', '/:id/making-of/items/:itemId', {
      id: project.id,
      itemId: captured.body.item.id,
    });
    expect(afterDelete.body.story.items).toHaveLength(1);
    expect(afterDelete.body.story.posts[0].itemIds).toEqual([videoCapture.body.item.id]);
    expect(afterDelete.body.story.posts[0].partItemIds).toEqual([[], [videoCapture.body.item.id]]);

    // Listing X drafts returns empty when no browser tabs are open.
    const xDraftsRes = await call('get', '/:id/making-of/x-drafts', { id: project.id }, {});
    expect(xDraftsRes.body).toEqual({ drafts: [] });

    // Peer wire sanitization preserves valid makingOfStory and drops tampered payloads;
    // legacy peer merge without makingOfStory preserves local makingOfStory.
    const stored = await projects.getProject(project.id);
    const wire = sanitizeRecordForWire('musicVideoProject', stored);
    expect(wire.makingOfStory).toEqual(afterDelete.body.story);
    expect(sanitizeRecordForWire('musicVideoProject', {
      ...wire,
      makingOfStory: { version: 1, items: [{ id: '../bad', kind: 'image' }], posts: [] },
    }).makingOfStory).toBeUndefined();

    const { makingOfStory: _dropped, ...legacyRemote } = wire;
    await projects.mergeProjectsFromSync([{ ...legacyRemote, updatedAt: '2099-01-01T00:00:00.000Z' }]);
    expect((await projects.getProject(project.id)).makingOfStory).toEqual(afterDelete.body.story);
  });

  it('rejects private URLs and path-traversal asset ids', async () => {
    const project = await projects.createProject({ name: 'Validation Video' });
    await expect(call('post', '/:id/making-of/items', { id: project.id }, {
      kind: 'image',
      assetId: '../secret.png',
      label: 'Bad path',
    })).rejects.toThrow();
    await expect(call('post', '/:id/making-of/posts', { id: project.id }, {
      title: 'Private host link',
      publishedUrl: 'https://box.internal/status/1',
    })).rejects.toThrow();
  });
});
