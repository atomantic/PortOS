import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';

const doubles = vi.hoisted(() => ({
  files: new Map(), failTerminal: false, getAccount: vi.fn(), listAccounts: vi.fn(), getMessage: vi.fn(), sendGmail: vi.fn(), sendPlaywright: vi.fn()
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { messages: '/mock/messages' },
  ensureDir: async () => {},
  tryReadFile: async path => doubles.files.get(path) ?? null,
  atomicWrite: async (path, data) => {
    if (doubles.failTerminal && data.some(d => d.status === 'sent')) throw new Error('Example disk failure');
    doubles.files.set(path, JSON.stringify(data));
  },
  safeJSONParse: JSON.parse
}));
vi.mock('./messageAccounts.js', () => ({ getAccount: doubles.getAccount, listAccounts: doubles.listAccounts }));
vi.mock('./messageSync.js', () => ({ getMessage: doubles.getMessage }));
vi.mock('./messageGmailSync.js', () => ({ sendGmail: doubles.sendGmail }));
vi.mock('./messagePlaywrightSync.js', () => ({ sendPlaywright: doubles.sendPlaywright }));

import { sendDraft } from './messageSender.js';
import { getDraft, approveDraft, updateDraft, deleteDraft, deleteDraftsByAccountId, initializeMessageDrafts, reconcileDraftSend } from './messageDrafts.js';

function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function seed(...drafts) {
  doubles.files.set(join('/mock/messages', 'drafts.json'), JSON.stringify(drafts.map(draft => ({
    accountId: 'account-1', status: 'approved', sendVia: 'api', body: 'Example message', ...draft
  }))));
}

beforeEach(() => {
  vi.resetAllMocks();
  doubles.files.clear();
  doubles.failTerminal = false;
  doubles.getAccount.mockResolvedValue({ id: 'account-1', type: 'gmail' });
  doubles.listAccounts.mockResolvedValue([{ id: 'account-1', type: 'gmail' }]);
  doubles.getMessage.mockResolvedValue(null);
  doubles.sendGmail.mockResolvedValue({ success: true });
  doubles.sendPlaywright.mockResolvedValue({ success: true });
});

describe('draft send workflow', () => {
  it('refuses unsupported sends without consuming approval or dispatching', async () => {
    seed({ id: 'outlook-draft', sendVia: 'playwright' });
    doubles.getAccount.mockResolvedValueOnce({ id: 'account-1', type: 'outlook', canSend: false });
    expect(await sendDraft('outlook-draft')).toMatchObject({ status: 501, code: 'SEND_NOT_SUPPORTED' });
    expect(await getDraft('outlook-draft')).toMatchObject({ status: 'approved' });
    expect(doubles.sendPlaywright).not.toHaveBeenCalled();
  });

  it('claims once after overlapping reads and prevents edits from reopening the send', async () => {
    seed({ id: 'draft-1' });
    const bothRead = barrier();
    const dispatchStarted = barrier();
    const releaseDispatch = barrier();
    let reads = 0;
    doubles.getAccount.mockImplementation(async () => {
      if (++reads === 2) bothRead.resolve();
      await bothRead.promise;
      return { id: 'account-1', type: 'gmail' };
    });
    doubles.sendGmail.mockImplementation(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return { success: true };
    });

    const sends = Promise.allSettled([sendDraft('draft-1'), sendDraft('draft-1')]);
    await dispatchStarted.promise;
    const active = await getDraft('draft-1');
    expect(active.status).toBe('sending');
    await initializeMessageDrafts();
    await expect(reconcileDraftSend('draft-1', { attemptId: active.sendAttemptId, outcome: 'not_sent' })).rejects.toMatchObject({ status: 409 });
    expect((await getDraft('draft-1')).status).toBe('sending');
    await expect(approveDraft('draft-1')).rejects.toMatchObject({ status: 409, code: 'DRAFT_STATE_CONFLICT' });
    await expect(updateDraft('draft-1', { status: 'draft', body: 'Changed' })).rejects.toMatchObject({ status: 409 });
    await expect(deleteDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    await expect(deleteDraftsByAccountId('account-1')).rejects.toMatchObject({ status: 409 });
    releaseDispatch.resolve();
    const results = await sends;
    expect(results.filter(result => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: { success: true } }]);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ status: 409, code: 'DRAFT_STATE_CONFLICT' });
    expect(doubles.sendGmail).toHaveBeenCalledTimes(1);
    expect((await getDraft('draft-1')).status).toBe('sent');
    await expect(approveDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    await expect(updateDraft('draft-1', { status: 'approved' })).rejects.toMatchObject({ status: 409 });
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, status: 409, code: 'DRAFT_STATE_CONFLICT' });
    expect(doubles.sendGmail).toHaveBeenCalledTimes(1);
  });

  it('lets another draft complete while one provider dispatch is blocked', async () => {
    seed({ id: 'draft-1' }, { id: 'draft-2' });
    const dispatchStarted = barrier();
    const releaseDispatch = barrier();
    doubles.sendGmail.mockImplementation(async (_account, draft) => {
      if (draft.id === 'draft-1') {
        dispatchStarted.resolve();
        await releaseDispatch.promise;
      }
      return { success: true };
    });
    const first = sendDraft('draft-1');
    await dispatchStarted.promise;
    expect(await sendDraft('draft-2')).toEqual({ success: true });
    expect((await getDraft('draft-2')).status).toBe('sent');
    releaseDispatch.resolve();
    await first;
    expect(doubles.sendGmail).toHaveBeenCalledTimes(2);
  });

  it('persists a returned dispatch failure and permits explicit reapproval', async () => {
    seed({ id: 'draft-1', sendVia: 'playwright', to: ['alice@example.com'], subject: 'Example subject' });
    doubles.getAccount.mockResolvedValue({ id: 'account-1', type: 'outlook' });
    doubles.listAccounts.mockResolvedValue([{ id: 'account-1', type: 'outlook' }]);
    doubles.sendPlaywright.mockResolvedValueOnce({ success: false, status: 502, code: 'SEND_FAILED', error: 'Example transport failure' });
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, code: 'SEND_FAILED' });
    expect((await getDraft('draft-1')).status).toBe('failed');
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    await approveDraft('draft-1');
    expect(await sendDraft('draft-1')).toEqual({ success: true });
    expect((await getDraft('draft-1')).status).toBe('sent');
  });

  it('parks a thrown dispatch as delivery unknown rather than a re-approvable failure', async () => {
    seed({ id: 'draft-1' });
    doubles.sendGmail.mockRejectedValueOnce(new Error('Example transport failure'));
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, status: 502, code: 'DELIVERY_UNKNOWN' });
    expect((await getDraft('draft-1')).status).toBe('delivery_unknown');
    await expect(approveDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    expect(doubles.sendGmail).toHaveBeenCalledTimes(1);
  });

  it('rechecks eligibility after account lookup and dispatches only the claimed snapshot', async () => {
    seed({ id: 'draft-1' });
    doubles.getAccount.mockImplementationOnce(async () => {
      await updateDraft('draft-1', { status: 'draft' });
      return { id: 'account-1', type: 'gmail' };
    });
    await expect(sendDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    expect(doubles.sendGmail).not.toHaveBeenCalled();
    await approveDraft('draft-1');
    doubles.getAccount.mockImplementationOnce(async () => {
      await updateDraft('draft-1', { body: 'Latest approved content', accountId: 'other-account', sendVia: 'playwright' });
      return { id: 'account-1', type: 'gmail' };
    });
    await sendDraft('draft-1');
    expect(doubles.sendGmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: 'Latest approved content', status: 'sending', accountId: 'account-1', sendVia: 'api' }));
  });

  it('leaves validation failures unsent and does not call a provider', async () => {
    seed({ id: 'unapproved', status: 'draft' }, { id: 'missing-account' }, { id: 'mismatch', sendVia: 'playwright' });
    expect(await sendDraft('absent')).toMatchObject({ status: 404, code: 'DRAFT_NOT_FOUND' });
    expect(await sendDraft('unapproved')).toMatchObject({ status: 409, code: 'DRAFT_STATE_CONFLICT' });
    doubles.getAccount.mockResolvedValueOnce(null);
    expect(await sendDraft('missing-account')).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(await sendDraft('mismatch')).toMatchObject({ code: 'SEND_VIA_MISMATCH' });
    expect((await getDraft('missing-account')).status).toBe('approved');
    expect((await getDraft('mismatch')).status).toBe('approved');
    expect(doubles.sendGmail).not.toHaveBeenCalled();
    expect(doubles.sendPlaywright).not.toHaveBeenCalled();
  });
});

const OUTLOOK = { id: 'account-1', type: 'outlook', enabled: true };
const browserDraft = (overrides = {}) => ({ sendVia: 'playwright', to: ['alice@example.com'], subject: 'Example subject', ...overrides });
const cachedMessage = (overrides = {}) => ({
  id: 'msg-1', threadId: 'thread-1', providerRowId: 'row-1', subject: 'Example', from: { name: 'Bob Example', email: 'bob@example.com' }, ...overrides
});

describe('browser draft delivery', () => {
  beforeEach(() => {
    doubles.getAccount.mockResolvedValue(OUTLOOK);
    doubles.listAccounts.mockResolvedValue([OUTLOOK]);
  });

  it('dispatches an approved draft once and returns the provider confirmation', async () => {
    seed({ id: 'draft-1', ...browserDraft() });
    doubles.sendPlaywright.mockResolvedValueOnce({ success: true, confirmed: true });
    expect(await sendDraft('draft-1')).toEqual({ success: true, confirmed: true });
    expect((await getDraft('draft-1')).status).toBe('sent');
    expect(doubles.sendPlaywright).toHaveBeenCalledWith(OUTLOOK, expect.objectContaining({ id: 'draft-1', status: 'sending' }), { replyTarget: null, requireIdentity: false });
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    expect(doubles.sendPlaywright).toHaveBeenCalledTimes(1);
  });

  it('resolves the reply target inside the draft\'s own account only', async () => {
    seed({ id: 'reply', replyToMessageId: 'msg-1', threadId: 'thread-1', ...browserDraft({ to: [] }) });
    doubles.getMessage.mockResolvedValueOnce(cachedMessage());
    expect(await sendDraft('reply')).toEqual({ success: true });
    expect(doubles.getMessage).toHaveBeenCalledWith('account-1', 'msg-1');
    expect(doubles.sendPlaywright).toHaveBeenCalledWith(OUTLOOK, expect.anything(), expect.objectContaining({ replyTarget: expect.objectContaining({ id: 'msg-1', providerRowId: 'row-1' }) }));
  });

  it.each([
    ['a reply target that belongs to another account', { replyToMessageId: 'msg-1' }, null, 'REPLY_TARGET_NOT_FOUND'],
    ['a reply whose thread differs from its target', { replyToMessageId: 'msg-1', threadId: 'thread-2' }, cachedMessage(), 'THREAD_MISMATCH'],
    ['a draft with no recipient', { to: [] }, null, 'DRAFT_NOT_DELIVERABLE'],
    ['a recipient that is not an email address', { to: ['Alice'] }, null, 'DRAFT_NOT_DELIVERABLE']
  ])('refuses %s without consuming approval or touching the provider', async (_label, overrides, target, code) => {
    seed({ id: 'draft-1', ...browserDraft(overrides) });
    doubles.getMessage.mockResolvedValue(target);
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, code });
    expect((await getDraft('draft-1')).status).toBe('approved');
    expect(doubles.sendPlaywright).not.toHaveBeenCalled();
  });

  it('flags a shared browser sign-in when several accounts of the provider are enabled', async () => {
    seed({ id: 'draft-1', ...browserDraft() });
    doubles.listAccounts.mockResolvedValue([OUTLOOK, { id: 'account-2', type: 'outlook', enabled: true }, { id: 'account-3', type: 'gmail' }]);
    await sendDraft('draft-1');
    expect(doubles.sendPlaywright).toHaveBeenCalledWith(OUTLOOK, expect.anything(), { replyTarget: null, requireIdentity: true });
  });

  it('parks an unconfirmed delivery for reconciliation instead of a re-approvable failure', async () => {
    seed({ id: 'draft-1', ...browserDraft() });
    const io = { emit: vi.fn() };
    doubles.sendPlaywright.mockResolvedValueOnce({ success: false, deliveryUnknown: true, status: 502, code: 'DELIVERY_UNKNOWN', error: 'Example unconfirmed' });
    expect(await sendDraft('draft-1', io)).toEqual({ success: false, status: 502, code: 'DELIVERY_UNKNOWN', error: 'Example unconfirmed' });
    const unknown = await getDraft('draft-1');
    expect(unknown.status).toBe('delivery_unknown');
    expect(unknown.sendAttempts).toEqual([expect.objectContaining({ id: unknown.sendAttemptId, outcome: 'delivery_unknown', finishedAt: expect.any(String) })]);
    expect(io.emit).toHaveBeenCalledWith('messages:changed', {});
    expect(io.emit).not.toHaveBeenCalledWith('messages:draft:sent', expect.anything());

    // Neither a second send nor a re-approval can duplicate it; only a mailbox-checked reconciliation reopens it.
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    await expect(approveDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    expect(doubles.sendPlaywright).toHaveBeenCalledTimes(1);
    await reconcileDraftSend('draft-1', { attemptId: unknown.sendAttemptId, outcome: 'not_sent' });
    await approveDraft('draft-1');
    doubles.sendPlaywright.mockResolvedValueOnce({ success: true, confirmed: true });
    expect(await sendDraft('draft-1')).toMatchObject({ success: true });
    expect(doubles.sendPlaywright).toHaveBeenCalledTimes(2);
  });
});

describe('interrupted send reconciliation', () => {
  it.each(['before dispatch', 'after external success'])('recovers a restart %s without dispatching and fences reconciliation by attempt', async point => {
    vi.resetModules();
    const original = await import('./messageDrafts.js');
    seed({ id: 'draft-1' });
    if (point === 'before dispatch') {
      await original.claimDraftForSend('draft-1');
    } else {
      const sender = await import('./messageSender.js');
      doubles.failTerminal = true;
      await expect(sender.sendDraft('draft-1')).rejects.toThrow('Example disk failure');
      doubles.failTerminal = false;
      expect(doubles.sendGmail).toHaveBeenCalledTimes(1);
    }
    const dispatchCount = doubles.sendGmail.mock.calls.length;
    vi.resetModules(); // a new process has no active dispatch leases
    const restarted = await import('./messageDrafts.js');
    const sender = await import('./messageSender.js');
    await restarted.initializeMessageDrafts();
    const unknown = await restarted.getDraft('draft-1');
    expect(unknown.status).toBe('delivery_unknown');
    expect(unknown.sendAttempts).toEqual([expect.objectContaining({
      id: unknown.sendAttemptId, outcome: 'delivery_unknown', interruptedAt: expect.any(String)
    })]);
    await restarted.initializeMessageDrafts();
    expect(await restarted.getDraft('draft-1')).toEqual(unknown);
    await expect(restarted.approveDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    await expect(restarted.updateDraft('draft-1', { status: 'draft', body: 'Changed' })).rejects.toMatchObject({ status: 409 });
    await expect(restarted.deleteDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    await expect(restarted.deleteDraftsByAccountId('account-1')).rejects.toMatchObject({ status: 409 });
    expect(await sender.sendDraft('draft-1')).toMatchObject({ status: 409 });
    expect(doubles.sendGmail).toHaveBeenCalledTimes(dispatchCount);
    expect(doubles.sendPlaywright).not.toHaveBeenCalled();

    await expect(restarted.reconcileDraftSend('draft-1', { attemptId: 'stale', outcome: 'not_sent' })).rejects.toMatchObject({ status: 409 });
    const outcome = point === 'before dispatch' ? 'not_sent' : 'sent';
    const reconciled = await restarted.reconcileDraftSend('draft-1', { attemptId: unknown.sendAttemptId, outcome });
    expect(reconciled.status).toBe(outcome === 'sent' ? 'sent' : 'draft');
    expect(reconciled.sendAttempts[0]).toMatchObject({ reconciliation: outcome, reconciledAt: expect.any(String) });
    expect(await sender.sendDraft('draft-1')).toMatchObject({ status: 409 });
    await expect(restarted.reconcileDraftSend('draft-1', { attemptId: unknown.sendAttemptId, outcome })).rejects.toMatchObject({ status: 409 });
    if (outcome === 'sent') {
      await expect(restarted.approveDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    } else {
      await restarted.updateDraft('draft-1', { body: 'Updated after mailbox check' });
      await restarted.approveDraft('draft-1');
      expect(await sender.sendDraft('draft-1')).toEqual({ success: true });
      const sent = await restarted.getDraft('draft-1');
      expect(sent.sendAttemptId).not.toBe(unknown.sendAttemptId);
      expect(sent.sendAttempts).toHaveLength(2);
      await expect(restarted.finishDraftSend('draft-1', unknown.sendAttemptId, true)).rejects.toMatchObject({ status: 409 });
    }
  });

  it('recovers legacy sends and bounds retained attempt history', async () => {
    vi.resetModules();
    const drafts = await import('./messageDrafts.js');
    seed({ id: 'legacy', status: 'sending' }, {
      id: 'retry', sendAttempts: Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, outcome: 'failed' }))
    });
    await drafts.initializeMessageDrafts();
    const legacy = await drafts.getDraft('legacy');
    expect(legacy).toMatchObject({ status: 'delivery_unknown', body: 'Example message' });
    expect(legacy.sendAttempts).toHaveLength(1);
    expect(legacy.sendAttempts[0].id).toBe(legacy.sendAttemptId);
    const attempt = await drafts.claimDraftForSend('retry');
    expect(attempt.sendAttempts).toHaveLength(20);
    expect(attempt.sendAttempts.at(-1).id).toBe(attempt.sendAttemptId);
    expect(doubles.sendGmail).not.toHaveBeenCalled();
    expect(doubles.sendPlaywright).not.toHaveBeenCalled();
  });
});
