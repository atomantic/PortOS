import { messageLogError } from '../lib/messageLogError.js';
import { getDraft, claimDraftForSend, finishDraftSend, releaseDraftSend } from './messageDrafts.js';
import { getAccount } from './messageAccounts.js';

const ACCOUNT_TYPE_TO_SEND_VIA = {
  gmail: 'api',
  outlook: 'playwright',
  teams: 'playwright'
};

export async function sendDraft(draftId, io) {
  let draft = await getDraft(draftId);
  if (!draft) return { success: false, status: 404, code: 'DRAFT_NOT_FOUND', error: 'Draft not found' };
  if (draft.status !== 'approved') return { success: false, status: 409, code: 'DRAFT_STATE_CONFLICT', error: `Draft status is "${draft.status}", must be "approved"` };

  // accountId and sendVia are immutable after creation (updateDraft's allowlist).
  // Validate those before claiming so configuration errors leave approval intact.
  const account = await getAccount(draft.accountId);
  if (!account) return { success: false, status: 404, code: 'ACCOUNT_NOT_FOUND', error: 'Account not found' };

  if (account.canSend === false) {
    return { success: false, status: 501, code: 'SEND_NOT_SUPPORTED', error: "Sending from this account isn't supported yet — copy the draft" };
  }

  const expectedSendVia = ACCOUNT_TYPE_TO_SEND_VIA[account.type];
  if (draft.sendVia !== expectedSendVia) {
    return { success: false, status: 400, code: 'SEND_VIA_MISMATCH', error: `sendVia "${draft.sendVia}" does not match account type "${account.type}" (expected "${expectedSendVia}")` };
  }

  draft = await claimDraftForSend(draftId);
  console.log(`📧 Sending draft ${draft.id} via ${draft.sendVia}`);

  const dispatch = async () => {
    if (draft.sendVia === 'api') {
      const { sendGmail } = await import('./messageGmailSync.js');
      return sendGmail(account, draft);
    }
    const { sendPlaywright } = await import('./messagePlaywrightSync.js');
    return sendPlaywright(account, draft);
  };

  const complete = async () => {
    const result = await dispatch().catch(async (error) => {
      console.error(`📧 Draft send threw for ${draft.id}: ${messageLogError(error)}`);
      return { success: false, status: 502, code: 'SEND_FAILED', error: error.message };
    });

    if (result?.success) {
      await finishDraftSend(draftId, draft.sendAttemptId, true);
      io?.emit('messages:draft:sent', { draftId });
      io?.emit('messages:changed', {});
      console.log(`📧 Draft sent successfully: ${draft.id}`);
    } else {
      await finishDraftSend(draftId, draft.sendAttemptId, false).catch(err => console.warn(`⚠️ Failed to mark draft as failed: ${messageLogError(err)}`));
      const errorMsg = result?.error ?? 'Unknown error sending draft';
      console.error(`📧 Draft send failed: ${messageLogError(result)}`);
      return { success: false, status: result?.status ?? 500, code: result?.code ?? 'SEND_FAILED', error: errorMsg };
    }

    return result;
  };
  return complete().finally(() => releaseDraftSend(draftId, draft.sendAttemptId));
}
