import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';

var tempRoot;
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'brain-collection-test-'));
  return tempRoot;
}

// Redirect all data paths to tempRoot before module imports
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy({ ...actual, readJSONFile: vi.fn(actual.readJSONFile) }, { dataRoot: () => getTempRoot() });
});

vi.mock('../services/instanceIdentity.js', () => ({
  getInstanceId: () => Promise.resolve('test-instance'),
}));

vi.mock('../services/userActions.js', () => ({
  recordUserAction: vi.fn(async () => ({ id: 'evt' }))
}));

// Import after hoisting mocks
import * as brainStorage from '../services/brainStorage.js';
import brainRoutes from './brain.js';

const app = express();
app.use(express.json());
app.use('/api/brain', brainRoutes);

const TOTAL_INBOX = 1200;
const TOTAL_MEMORIES = 1500;
const BASE_TIME = Date.parse('2026-08-01T00:00:00.000Z');

async function seedRecord(type, id, record) {
  const dir = join(getTempRoot(), 'brain', type, id);
  await mkdir(dir);
  await writeFile(join(dir, 'index.json'), JSON.stringify({ id, ...record }));
}

async function seedRecords(type, count, createRecord) {
  const parent = join(getTempRoot(), 'brain', type);
  await mkdir(parent, { recursive: true });

  const batchSize = 48;
  for (let start = 0; start < count; start += batchSize) {
    const batchEnd = Math.min(start + batchSize, count);
    await Promise.all(Array.from({ length: batchEnd - start }, (_, offset) => {
      const i = start + offset;
      const id = `${type === 'inbox' ? 'inbox' : 'mem'}-${String(i).padStart(5, '0')}`;
      return seedRecord(type, id, createRecord(i, id));
    }));
  }
}

describe('Brain collection pagination (synthetic thousands-record fixtures)', () => {
  beforeAll(async () => {
    // Seed 1,200 inbox entries
    await seedRecords('inbox', TOTAL_INBOX, (i, id) => {
      const capturedAt = new Date(BASE_TIME + i * 60000).toISOString();
      const isTargetSearch = i === 15 || i === 480 || i === 1120;
      return {
        id,
        capturedText: isTargetSearch ? `Urgent needle task ${i}` : `Thought note entry #${i}`,
        title: isTargetSearch ? `Needle Title ${i}` : `Inbox Item ${i}`,
        status: i % 4 === 0 ? 'needs_review' : (i % 4 === 1 ? 'filed' : (i % 4 === 2 ? 'done' : 'classifying')),
        capturedAt,
        createdAt: capturedAt,
        updatedAt: capturedAt
      };
    });

    // Seed 1,500 memories
    await seedRecords('memories', TOTAL_MEMORIES, (i, id) => {
      const updatedAt = new Date(BASE_TIME + i * 60000).toISOString();
      const isTargetSearch = i === 22 || i === 655 || i === 1433;
      const longBody = `Memory full content #${i}: ` + 'Detailed reflective thoughts spanning multiple sentences. '.repeat(8);
      return {
        id,
        title: isTargetSearch ? `Target Query Memory ${i}` : `Daily Memory ${i}`,
        content: longBody,
        tags: [i % 50 === 0 ? 'rare-tag' : 'common', `topic-${i % 10}`],
        archived: i % 10 === 0, // 150 archived, 1350 unarchived
        createdAt: updatedAt,
        updatedAt
      };
    });

    brainStorage.invalidateAllCaches();
  });

  afterAll(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('Inbox pagination & bounds', () => {
    it('enforces default limit of 50 and returns complete collection counts', async () => {
      const res = await request(app).get('/api/brain/inbox');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(50);
      expect(res.body.entries).toHaveLength(50);
      expect(res.body.total).toBe(TOTAL_INBOX);
      expect(res.body.nextCursor).toBeTruthy();
      expect(res.body.counts).toMatchObject({
        total: TOTAL_INBOX,
        needs_review: 300,
        filed: 300,
        done: 300,
        classifying: 300
      });
    });

    it('enforces server-enforced ceiling: serves up to max limit 100, refuses unbounded requests, and storage clamps', async () => {
      const atMax = await request(app).get('/api/brain/inbox?limit=100');
      expect(atMax.status).toBe(200);
      expect(atMax.body.items).toHaveLength(100);

      const overMax = await request(app).get('/api/brain/inbox?limit=5000');
      expect(overMax.status).toBe(400);

      // Storage layer clamps any direct/internal requests exceeding ceiling
      const directClamped = await brainStorage.getInboxPage({ limit: 5000 });
      expect(directClamped.items).toHaveLength(100);
    });

    it('pages continuously via stable cursors without duplicates or skips', async () => {
      const page1 = await request(app).get('/api/brain/inbox?limit=50');
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(50);
      const cursor1 = page1.body.nextCursor;
      expect(cursor1).toBeTruthy();

      const page2 = await request(app).get(`/api/brain/inbox?limit=50&cursor=${encodeURIComponent(cursor1)}`);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(50);
      const cursor2 = page2.body.nextCursor;
      expect(cursor2).toBeTruthy();

      const ids1 = new Set(page1.body.items.map(e => e.id));
      const ids2 = new Set(page2.body.items.map(e => e.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }

      // Order is newest-first
      const last1Time = Date.parse(page1.body.items[page1.body.items.length - 1].capturedAt);
      const first2Time = Date.parse(page2.body.items[0].capturedAt);
      expect(first2Time).toBeLessThanOrEqual(last1Time);
    });

    it('applies search across the complete 1,200 record collection, not just loaded pages', async () => {
      const res = await request(app).get('/api/brain/inbox?search=needle');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.items).toHaveLength(3);
      expect(res.body.nextCursor).toBeNull();
      const ids = res.body.items.map(item => item.id);
      expect(ids).toContain('inbox-00015');
      expect(ids).toContain('inbox-00480');
      expect(ids).toContain('inbox-01120');
    });

    it('applies status filter across complete collection', async () => {
      const res = await request(app).get('/api/brain/inbox?status=needs_review&limit=25');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(300);
      expect(res.body.items).toHaveLength(25);
      expect(res.body.items.every(e => e.status === 'needs_review')).toBe(true);
      expect(res.body.nextCursor).toBeTruthy();
    });
  });

  describe('Memory collection pagination, compact projection, and compatibility', () => {
    it('returns compact row projections with truncated content when using cursor pagination', async () => {
      const res = await request(app).get('/api/brain/memories?cursor=&limit=25');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(25);
      expect(res.body.total).toBe(1350); // 1500 minus 150 archived
      expect(res.body.nextCursor).toBeTruthy();

      // Verify compact row projection
      for (const item of res.body.items) {
        expect(item.content.length).toBeLessThanOrEqual(300);
        expect(item.contentTruncated).toBe(true);
      }
    });

    it('enforces server-enforced memory ceiling: serves up to 100, refuses over 100, and storage clamps', async () => {
      const atMax = await request(app).get('/api/brain/memories?cursor=&limit=100');
      expect(atMax.status).toBe(200);
      expect(atMax.body.items).toHaveLength(100);

      const overMax = await request(app).get('/api/brain/memories?cursor=&limit=500');
      expect(overMax.status).toBe(400);

      // Storage layer clamps any direct/internal requests exceeding ceiling
      const directClamped = await brainStorage.getEntityPage('memories', { limit: 500 });
      expect(directClamped.items).toHaveLength(100);
    });

    it('fetches full untruncated content on individual record detail endpoint', async () => {
      const listRes = await request(app).get('/api/brain/memories?cursor=&limit=1');
      const sample = listRes.body.items[0];
      expect(sample.contentTruncated).toBe(true);

      const detailRes = await request(app).get(`/api/brain/memories/${sample.id}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.id).toBe(sample.id);
      expect(detailRes.body.content.length).toBeGreaterThan(400);
      expect(detailRes.body.contentTruncated).toBeUndefined();
    });

    it('pages through memories with stable cursors and zero ID overlap', async () => {
      const page1 = await request(app).get('/api/brain/memories?cursor=&limit=25');
      const cursor1 = page1.body.nextCursor;
      const ids1 = new Set(page1.body.items.map(m => m.id));

      const page2 = await request(app).get(`/api/brain/memories?cursor=${encodeURIComponent(cursor1)}&limit=25`);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(25);
      const ids2 = new Set(page2.body.items.map(m => m.id));

      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it('applies memory search across complete collection', async () => {
      const res = await request(app).get('/api/brain/memories?search=Target%20Query');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.items).toHaveLength(3);
      const titles = res.body.items.map(m => m.title);
      expect(titles).toContain('Target Query Memory 22');
      expect(titles).toContain('Target Query Memory 655');
      expect(titles).toContain('Target Query Memory 1433');
    });

    it('preserves legacy unpaginated array response for callers without cursor or search', async () => {
      const res = await request(app).get('/api/brain/memories');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1500); // Legacy returns all records
    });

    it('preserves legacy limit/offset envelope for callers passing limit/offset without cursor or search', async () => {
      const res = await request(app).get('/api/brain/memories?limit=10&offset=5');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        total: 1500,
        limit: 10,
        offset: 5
      });
      expect(res.body.memories).toHaveLength(10);
      expect(res.body.nextCursor).toBeUndefined();
    });
  });
});
