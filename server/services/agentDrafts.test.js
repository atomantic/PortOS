import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (path) => {
    if (!fileStore.has(path)) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return fileStore.get(path);
  }),
  writeFile: vi.fn(async (path, data) => {
    fileStore.set(path, data);
  })
}));

vi.mock('../lib/uuid.js', () => {
  let counter = 0;
  return { v4: () => `uuid-${++counter}` };
});

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  PATHS: { agentPersonalities: '/mock/agents' },
  safeJSONParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } }
}));

const { listDrafts, getDraft, createDraft, updateDraft, deleteDraft } = await import('./agentDrafts.js');

describe('agentDrafts service', () => {
  beforeEach(() => {
    fileStore.clear();
  });

  it('listDrafts returns an empty array when no drafts file exists', async () => {
    expect(await listDrafts('agent-1')).toEqual([]);
  });

  it('createDraft persists the draft with generated id, timestamp, and defaults', async () => {
    const entry = await createDraft('agent-1', {
      type: 'post',
      title: 'Hello',
      content: 'Body here'
    });
    expect(entry.id).toMatch(/^uuid-/);
    expect(entry.type).toBe('post');
    expect(entry.title).toBe('Hello');
    expect(entry.content).toBe('Body here');
    expect(entry.status).toBe('draft');
    expect(entry.accountId).toBeNull();
    expect(typeof entry.createdAt).toBe('string');

    const persisted = await listDrafts('agent-1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(entry.id);
  });

  it('listDrafts returns drafts sorted by createdAt descending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const older = await createDraft('agent-1', { type: 'post', content: 'first' });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const newer = await createDraft('agent-1', { type: 'comment', content: 'second' });
    vi.useRealTimers();

    const result = await listDrafts('agent-1');
    expect(result.map(d => d.id)).toEqual([newer.id, older.id]);
  });

  it('getDraft returns the matching draft or null', async () => {
    const entry = await createDraft('agent-2', { type: 'post', content: 'x' });
    const found = await getDraft('agent-2', entry.id);
    expect(found.id).toBe(entry.id);

    const missing = await getDraft('agent-2', 'nope');
    expect(missing).toBeNull();
  });

  it('updateDraft merges updates, stamps updatedAt, and returns the new record', async () => {
    const entry = await createDraft('agent-3', { type: 'post', content: 'original' });
    const updated = await updateDraft('agent-3', entry.id, {
      content: 'edited',
      status: 'queued'
    });
    expect(updated.id).toBe(entry.id);
    expect(updated.content).toBe('edited');
    expect(updated.status).toBe('queued');
    expect(typeof updated.updatedAt).toBe('string');

    const persisted = await getDraft('agent-3', entry.id);
    expect(persisted.content).toBe('edited');
  });

  it('updateDraft returns null when the draft id is unknown', async () => {
    await createDraft('agent-4', { type: 'post', content: 'a' });
    expect(await updateDraft('agent-4', 'missing', { content: 'b' })).toBeNull();
  });

  it('deleteDraft removes the draft and returns true', async () => {
    const entry = await createDraft('agent-5', { type: 'post', content: 'x' });
    expect(await deleteDraft('agent-5', entry.id)).toBe(true);
    expect(await listDrafts('agent-5')).toEqual([]);
  });

  it('deleteDraft returns false when the draft id does not exist', async () => {
    await createDraft('agent-6', { type: 'post', content: 'x' });
    expect(await deleteDraft('agent-6', 'nope')).toBe(false);
    expect(await listDrafts('agent-6')).toHaveLength(1);
  });

  it('drafts are scoped per agent — different agentIds do not share drafts', async () => {
    await createDraft('agent-A', { type: 'post', content: 'A' });
    await createDraft('agent-B', { type: 'post', content: 'B' });
    const a = await listDrafts('agent-A');
    const b = await listDrafts('agent-B');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].content).toBe('A');
    expect(b[0].content).toBe('B');
  });
});
