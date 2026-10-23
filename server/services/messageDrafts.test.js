import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posixPath as toPosix } from '../lib/testHelper.js';

const fileStore = new Map();

vi.mock('../lib/uuid.js', () => {
  let counter = 0;
  return { v4: () => `uuid-${++counter}` };
});

vi.mock('../lib/fileUtils.js', () => ({
  readJSONFileStrict: async (path, fallback) => ({
    ok: true, value: fileStore.has(toPosix(path)) ? JSON.parse(fileStore.get(toPosix(path))) : fallback
  }),
  tryReadFile: vi.fn(async (path) => fileStore.has(toPosix(path)) ? fileStore.get(toPosix(path)) : null),
  atomicWrite: vi.fn(async (path, data) => {
    fileStore.set(toPosix(path), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  PATHS: { messages: '/mock/messages' },
  safeJSONParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } }
}));

const { listDrafts, createDraft, updateDraft, claimDraftForSend, releaseDraftSend } = await import('./messageDrafts.js');

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

// Approval is the send intent claimDraftForSend checks, so it must bind to the
// content that was approved (#13055): an edit to who or what gets sent drops it.
describe('messageDrafts.updateDraft approval binding', () => {
  const approved = {
    id: 'approved-draft', status: 'approved', to: ['alice@example.com'], cc: [],
    subject: 'Example subject', body: 'Example reply', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const { id, status: _status, createdAt: _createdAt, ...content } = approved;

  beforeEach(() => {
    fileStore.clear();
    seed([structuredClone(approved)]);
  });

  it.each([
    ['to', ['bob@example.com']],
    ['cc', ['carol@example.com']],
    ['subject', 'Changed subject'],
    ['body', 'Changed reply'],
  ])('drops approval when %s changes, so the edited draft cannot be claimed for send', async (key, value) => {
    expect(await updateDraft(id, { [key]: value })).toMatchObject({ [key]: value, status: 'draft' });
    await expect(claimDraftForSend(id)).rejects.toMatchObject({ status: 409, code: 'DRAFT_STATE_CONFLICT' });
  });

  it('keeps approval for an unchanged resend and for an edit that re-approves in the same update', async () => {
    expect((await updateDraft(id, structuredClone(content))).status).toBe('approved');
    expect(await updateDraft(id, { body: 'Re-approved reply', status: 'approved' }))
      .toMatchObject({ body: 'Re-approved reply', status: 'approved' });
    const claimed = await claimDraftForSend(id);
    expect(claimed).toMatchObject({ body: 'Re-approved reply', status: 'sending' });
    releaseDraftSend(id, claimed.sendAttemptId);
  });
});
