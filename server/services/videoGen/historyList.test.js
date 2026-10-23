import { describe, it, expect, vi, beforeEach } from 'vitest';

const withMediaFileSizes = vi.hoisted(() => vi.fn());
vi.mock('../../lib/mediaFileInfo.js', () => ({ withMediaFileSizes }));

const { listVideoHistoryQuery, historyListQuerySchema, isHistoryListQuery } = await import('./historyList.js');

const parse = query => historyListQuerySchema.parse(query);
const long = 'x'.repeat(400);
const history = [
  { id: 'old', filename: 'old.mp4', createdAt: '2026-01-01T00:00:00Z', prompt: 'a fox', numFrames: 49, fps: 24 },
  { id: 'new', filename: 'new.mp4', createdAt: '2026-03-01T00:00:00Z', prompt: `${long} needle`, numFrames: 97, fps: 30, timelineProjectId: 'p1', hidden: true },
  { id: 'mid', filename: 'mid.mp4', createdAt: '2026-02-01T00:00:00Z', prompt: 'a bear' },
];

describe('listVideoHistoryQuery', () => {
  beforeEach(() => {
    withMediaFileSizes.mockReset();
    withMediaFileSizes.mockImplementation(async rows => rows.map(r => ({ ...r, fileSizeBytes: 1 })));
  });

  it('recognises only the opt-in query keys', () => {
    expect(isHistoryListQuery({})).toBe(false);
    expect(isHistoryListQuery({ compact: 'true' })).toBe(true);
  });

  it('serves the whole compact catalog without stat-ing and keeps what the timeline editor reads', async () => {
    const rows = await listVideoHistoryQuery(parse({ compact: 'true' }), history);
    expect(withMediaFileSizes).not.toHaveBeenCalled();
    expect(rows.map(r => r.id)).toEqual(['old', 'new', 'mid']);
    expect(rows[0]).toMatchObject({ id: 'old', filename: 'old.mp4', numFrames: 49, fps: 24 });
    expect(rows[1].timelineProjectId).toBe('p1');
    expect(rows[1].prompt.length).toBeLessThan(long.length);
  });

  it('stats only the requested page, newest first', async () => {
    const page = await listVideoHistoryQuery(parse({ limit: '1', offset: '1' }), history);
    expect(page.map(r => r.id)).toEqual(['mid']);
    expect(withMediaFileSizes).toHaveBeenCalledWith([history[2]], 'video');
  });

  it('searches the full prompt beyond the compact preview and honors hidden', async () => {
    const hit = await listVideoHistoryQuery(parse({ q: 'needle', compact: 'true' }), history);
    expect(hit.map(r => r.id)).toEqual(['new']);
    const keyName = await listVideoHistoryQuery(parse({ q: 'createdat', compact: 'true' }), history);
    expect(keyName).toEqual([]);
    const visible = await listVideoHistoryQuery(parse({ hidden: 'false', compact: 'true' }), history);
    expect(visible.map(r => r.id)).toEqual(['old', 'mid']);
  });

  it('rejects an oversized page', () => {
    expect(() => parse({ limit: '500' })).toThrow();
    expect(() => parse({ offset: '5' })).toThrow();
  });
});
