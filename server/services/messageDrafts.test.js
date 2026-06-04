import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../lib/uuid.js', () => {
  let counter = 0;
  return { v4: () => `uuid-${++counter}` };
});

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn(async (path) => fileStore.has(path) ? fileStore.get(path) : null),
  atomicWrite: vi.fn(async (path, data) => {
    fileStore.set(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  PATHS: { messages: '/mock/messages' },
  safeJSONParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } }
}));

const { listDrafts, createDraft } = await import('./messageDrafts.js');

// Seed the file store directly so we control accountId/status without relying on
// createDraft (which always stamps status 'draft').
function seed(drafts) {
  fileStore.set('/mock/messages/drafts.json', JSON.stringify(drafts));
}

describe('messageDrafts.listDrafts', () => {
  beforeEach(() => {
    fileStore.clear();
  });

  it('returns an empty array when no drafts file exists', async () => {
    expect(await listDrafts()).toEqual([]);
  });

  it('returns all drafts sorted by createdAt descending when no filter', async () => {
    seed([
      { id: 'a', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', status: 'sent', createdAt: '2026-03-01T00:00:00.000Z' }
    ]);
    const result = await listDrafts();
    expect(result.map(d => d.id)).toEqual(['b', 'a']);
  });

  it('filters by a single status string', async () => {
    seed([
      { id: 'a', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', status: 'sent', createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'c', status: 'draft', createdAt: '2026-03-01T00:00:00.000Z' }
    ]);
    const result = await listDrafts({ status: 'draft' });
    expect(result.map(d => d.id)).toEqual(['c', 'a']);
  });

  it('filters by an array of statuses (OR)', async () => {
    seed([
      { id: 'a', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', status: 'sent', createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'c', status: 'pending_review', createdAt: '2026-03-01T00:00:00.000Z' }
    ]);
    const result = await listDrafts({ status: ['draft', 'pending_review'] });
    expect(result.map(d => d.id)).toEqual(['c', 'a']);
  });

  it('treats an explicit empty status array as "match nothing"', async () => {
    seed([
      { id: 'a', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', status: 'sent', createdAt: '2026-02-01T00:00:00.000Z' }
    ]);
    expect(await listDrafts({ status: [] })).toEqual([]);
  });

  it('combines accountId and a multi-status filter', async () => {
    seed([
      { id: 'a', accountId: 'acct-1', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', accountId: 'acct-2', status: 'draft', createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'c', accountId: 'acct-1', status: 'sent', createdAt: '2026-03-01T00:00:00.000Z' }
    ]);
    const result = await listDrafts({ accountId: 'acct-1', status: ['draft', 'pending_review'] });
    expect(result.map(d => d.id)).toEqual(['a']);
  });

  it('round-trips a created draft and finds it by status', async () => {
    const draft = await createDraft({ accountId: 'acct-1', subject: 'hi' });
    const result = await listDrafts({ status: ['draft', 'pending_review'] });
    expect(result.map(d => d.id)).toEqual([draft.id]);
  });
});
