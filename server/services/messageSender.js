import { getDraft, updateDraft } from './messageDrafts.js';
import { getAccount } from './messageAccounts.js';

const ACCOUNT_TYPE_TO_SEND_VIA = {
  gmail: 'api',
  outlook: 'playwright',
  teams: 'playwright'
};

export async function sendDraft(draftId, io) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, status: 404, code: 'DRAFT_NOT_FOUND', error: 'Draft not found' };
  if (draft.status !== 'approved') return { success: false, status: 400, code: 'INVALID_STATUS', error: `Draft status is "${draft.status}", must be "approved"` };

  const account = await getAccount(draft.accountId);
  if (!account) return { success: false, status: 404, code: 'ACCOUNT_NOT_FOUND', error: 'Account not found' };

  const expectedSendVia = ACCOUNT_TYPE_TO_SEND_VIA[account.type];
  if (draft.sendVia !== expectedSendVia) {
    return { success: false, status: 400, code: 'SEND_VIA_MISMATCH', error: `sendVia "${draft.sendVia}" does not match account type "${account.type}" (expected "${expectedSendVia}")` };
  }

  await updateDraft(draftId, { status: 'sending' });
  console.log(`📧 Sending draft "${draft.subject}" via ${draft.sendVia}`);

  const dispatch = async () => {
    if (draft.sendVia === 'api') {
      const { sendGmail } = await import('./messageGmailSync.js');
      return sendGmail(account, draft);
    }
    const { sendPlaywright } = await import('./messagePlaywrightSync.js');
    return sendPlaywright(account, draft);
  };

  const result = await dispatch().catch(async (error) => {
    console.error(`📧 Draft send threw for "${draft.subject}": ${error.message}`);
    return { success: false, status: 502, code: 'SEND_FAILED', error: error.message };
  });

  if (result?.success) {
    await updateDraft(draftId, { status: 'sent' });
    io?.emit('messages:draft:sent', { draftId });
    io?.emit('messages:changed', {});
    console.log(`📧 Draft sent successfully: "${draft.subject}"`);
  } else {
    await updateDraft(draftId, { status: 'failed' }).catch(err => console.warn(`⚠️ Failed to mark draft as failed: ${err.message}`));
    const errorMsg = result?.error ?? 'Unknown error sending draft';
    console.log(`📧 Draft send failed: ${errorMsg}`);
    return { success: false, status: result?.status ?? 500, code: result?.code ?? 'SEND_FAILED', error: errorMsg };
  }

  return result;
}
