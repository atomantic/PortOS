import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/feeds.js', () => ({
  getFeeds: vi.fn(),
  addFeed: vi.fn(),
  removeFeed: vi.fn(),
  refreshFeed: vi.fn(),
  refreshAllFeeds: vi.fn(),
  getItems: vi.fn(),
  markItemRead: vi.fn(),
  markAllRead: vi.fn(),
  getFeedStats: vi.fn(),
}));

import * as feeds from '../services/feeds.js';
import feedsRoutes from './feeds.js';

const app = express();
app.use(express.json());
app.use('/api/feeds', feedsRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('/api/feeds', () => {
  it('subscribes to a feed URL, and maps a service refusal or a non-URL to 400', async () => {
    feeds.addFeed.mockResolvedValue({ feed: { id: 'f1', url: 'https://example.com/rss' } });
    const ok = await request(app).post('/api/feeds').send({ url: 'https://example.com/rss' });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ id: 'f1', url: 'https://example.com/rss' });

    feeds.addFeed.mockResolvedValue({ error: 'Feed already subscribed' });
    const dup = await request(app).post('/api/feeds').send({ url: 'https://example.com/rss' });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe('Feed already subscribed');

    feeds.addFeed.mockClear();
    const bad = await request(app).post('/api/feeds').send({ url: 'not a url' });
    expect(bad.status).toBe(400);
    expect(feeds.addFeed).not.toHaveBeenCalled();
  });

  it('reads items with the filters the client sends and clamps pagination', async () => {
    feeds.getItems.mockResolvedValue([]);
    await request(app).get('/api/feeds/items?feedId=f1&unreadOnly=true&limit=9999&offset=5');
    expect(feeds.getItems).toHaveBeenCalledWith({ feedId: 'f1', unreadOnly: true, limit: 500, offset: 5 });

    await request(app).get('/api/feeds/items');
    expect(feeds.getItems).toHaveBeenLastCalledWith({ feedId: undefined, unreadOnly: false, limit: 100, offset: 0 });

    const bad = await request(app).get('/api/feeds/items?unreadOnly=yes');
    expect(bad.status).toBe(400);
  });

  it('marks all items read for one feed or every feed', async () => {
    feeds.markAllRead.mockResolvedValue({ marked: 2 });
    await request(app).post('/api/feeds/items/read-all?feedId=f1');
    expect(feeds.markAllRead).toHaveBeenCalledWith('f1');
    await request(app).post('/api/feeds/items/read-all');
    expect(feeds.markAllRead).toHaveBeenLastCalledWith(undefined);
  });

  it('answers 404 when the item or feed a mutation names does not exist', async () => {
    feeds.markItemRead.mockResolvedValue({ error: 'Item not found' });
    feeds.refreshFeed.mockResolvedValue({ error: 'Feed not found' });
    feeds.removeFeed.mockResolvedValue({ error: 'Feed not found' });
    expect((await request(app).post('/api/feeds/items/i9/read')).status).toBe(404);
    expect((await request(app).post('/api/feeds/f9/refresh')).status).toBe(404);
    expect((await request(app).delete('/api/feeds/f9')).status).toBe(404);
  });
});
