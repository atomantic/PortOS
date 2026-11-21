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

const {
  listDrafts, createDraft, updateDraft, claimDraftForSend, releaseDraftSend,
  erasePrivacyDrafts, scrubLegacyPrivacyDraftValues, PRIVACY_DRAFT_REDACTION_NOTICE
} = await import('./messageDrafts.js');

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

describe('privacy draft erasure (#17233)', () => {
  const stored = () => JSON.parse(fileStore.get('/mock/messages/drafts.json'));
  const priv = (id, status, extra = {}) => ({
    id, status, generatedBy: 'privacy-optout', subject: 'Request', body: 'Name: Alex Example',
    createdAt: '2026-01-01T00:00:00.000Z', privacyMeta: { subjectId: 's1', caseId: 'c1' }, ...extra
  });
  const attempt = { id: 'att-1', startedAt: '2026-01-01T00:00:00.000Z' };

  beforeEach(() => fileStore.clear());

  it('createDraft persists privacyMeta and omits the key for ordinary drafts', async () => {
    const withMeta = await createDraft({ accountId: 'a', generatedBy: 'privacy-optout', privacyMeta: { subjectId: 's1' } });
    const plain = await createDraft({ accountId: 'a' });
    expect(withMeta.privacyMeta).toEqual({ subjectId: 's1' });
    expect('privacyMeta' in plain).toBe(false);
  });

  it('deletes unsent matches, redacts sent bodies, and leaves locked and unrelated drafts untouched', async () => {
    seed([
      priv('d', 'draft'), priv('a', 'approved'), priv('f', 'failed'),
      priv('sent', 'sent', { sendAttempts: [attempt] }),
      priv('sending', 'sending', { sendAttemptId: 'att-1', sendAttempts: [attempt] }),
      priv('other-subject', 'draft', { privacyMeta: { subjectId: 's2' } }),
      { id: 'manual', status: 'draft', generatedBy: 'manual', body: 'Name: Alex Example', privacyMeta: { subjectId: 's1' } }
    ]);
    // The sending draft has no live dispatcher, so loadDrafts reclassifies it
    // delivery_unknown; either way it must survive untouched.
    const result = await erasePrivacyDrafts(d => d.privacyMeta?.subjectId === 's1');
    expect(result).toEqual({ deleted: 3, redacted: 1, skipped: 1 });
    const left = Object.fromEntries(stored().map(d => [d.id, d]));
    expect(Object.keys(left).sort()).toEqual(['manual', 'other-subject', 'sending', 'sent']);
    expect(left.sent).toMatchObject({ status: 'sent', body: PRIVACY_DRAFT_REDACTION_NOTICE, sendAttempts: [attempt] });
    expect(left.sending.body).toBe('Name: Alex Example');
    expect(left.manual.body).toBe('Name: Alex Example');
  });

  it('onlyUnsent revokes queued opt-outs but keeps sent drafts as-is', async () => {
    seed([priv('a', 'approved'), priv('sent', 'sent'), priv('chg', 'draft', { generatedBy: 'privacy-change' })]);
    const result = await erasePrivacyDrafts(d => d.privacyMeta?.subjectId === 's1', { onlyUnsent: true, generatedBy: ['privacy-optout'] });
    expect(result).toMatchObject({ deleted: 1, redacted: 0 });
    expect(stored().map(d => d.id).sort()).toEqual(['chg', 'sent']);
    expect(stored().find(d => d.id === 'sent').body).toBe('Name: Alex Example');
  });

  it('scrubs revoked values from legacy untagged privacy drafts only on whole-token matches', async () => {
    seed([
      priv('legacy', 'draft', { privacyMeta: undefined, body: 'Name: Alex Example, Alex Examples Jr' }),
      { id: 'manual', status: 'draft', generatedBy: 'manual', body: 'Alex Example' },
    ]);
    expect(await scrubLegacyPrivacyDraftValues(['Alex Example', ' '])).toBe(1);
    const left = Object.fromEntries(stored().map(d => [d.id, d]));
    expect(left.legacy.body).toBe('Name: [redacted], Alex Examples Jr');
    expect(left.manual.body).toBe('Alex Example');
  });
});
