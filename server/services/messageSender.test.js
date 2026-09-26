import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';

const doubles = vi.hoisted(() => ({
  files: new Map(), getAccount: vi.fn(), sendGmail: vi.fn(), sendPlaywright: vi.fn()
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { messages: '/mock/messages' },
  ensureDir: async () => {},
  tryReadFile: async path => doubles.files.get(path) ?? null,
  atomicWrite: async (path, data) => { doubles.files.set(path, JSON.stringify(data)); },
  safeJSONParse: JSON.parse
}));
vi.mock('./messageAccounts.js', () => ({ getAccount: doubles.getAccount }));
vi.mock('./messageGmailSync.js', () => ({ sendGmail: doubles.sendGmail }));
vi.mock('./messagePlaywrightSync.js', () => ({ sendPlaywright: doubles.sendPlaywright }));

import { sendDraft } from './messageSender.js';
import { getDraft, approveDraft, updateDraft, deleteDraft, deleteDraftsByAccountId } from './messageDrafts.js';

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
  doubles.getAccount.mockResolvedValue({ id: 'account-1', type: 'gmail' });
  doubles.sendGmail.mockResolvedValue({ success: true });
  doubles.sendPlaywright.mockResolvedValue({ success: true });
});

describe('draft send workflow', () => {
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

  it.each(['returned', 'thrown'])('persists a %s dispatch failure and permits explicit reapproval', async kind => {
    seed({ id: 'draft-1', sendVia: 'playwright' });
    doubles.getAccount.mockResolvedValue({ id: 'account-1', type: 'outlook' });
    if (kind === 'thrown') doubles.sendPlaywright.mockRejectedValueOnce(new Error('Example transport failure'));
    else doubles.sendPlaywright.mockResolvedValueOnce({ success: false, status: 502, code: 'SEND_FAILED', error: 'Example transport failure' });
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, code: 'SEND_FAILED' });
    expect((await getDraft('draft-1')).status).toBe('failed');
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    await approveDraft('draft-1');
    expect(await sendDraft('draft-1')).toEqual({ success: true });
    expect((await getDraft('draft-1')).status).toBe('sent');
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
