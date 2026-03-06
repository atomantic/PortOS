import { getDraft, updateDraft } from './messageDrafts.js';
import { getAccount } from './messageAccounts.js';

export async function sendDraft(draftId, io) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, error: 'Draft not found' };
  if (draft.status !== 'approved') return { success: false, error: `Draft status is "${draft.status}", must be "approved"` };

  const account = await getAccount(draft.accountId);
  if (!account) return { success: false, error: 'Account not found' };

  await updateDraft(draftId, { status: 'sending' });
  console.log(`📧 Sending draft "${draft.subject}" via ${draft.sendVia}`);

  let result;
  const dispatch = async () => {
    if (draft.sendVia === 'mcp') {
      const { sendGmail } = await import('./messageGmailSync.js');
      return sendGmail(account, draft);
    }
    const { sendPlaywright } = await import('./messagePlaywrightSync.js');
    return sendPlaywright(account, draft);
  };

  result = await dispatch().catch(async (error) => {
    console.error(`📧 Draft send threw for "${draft.subject}": ${error.message}`);
    await updateDraft(draftId, { status: 'failed' }).catch(() => {});
    return { success: false, error: error.message };
  });

  if (result.success) {
    await updateDraft(draftId, { status: 'sent' });
    io?.emit('messages:draft:sent', { draftId });
    io?.emit('messages:changed', {});
    console.log(`📧 Draft sent successfully: "${draft.subject}"`);
  } else if (result.error) {
    await updateDraft(draftId, { status: 'failed' }).catch(() => {});
    console.log(`📧 Draft send failed: ${result.error}`);
  }

  return result;
}
