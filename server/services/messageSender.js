import { messageLogError } from '../lib/messageLogError.js';
import { sendViaForAccountType } from '../lib/messageTransport.js';
import { planDelivery } from '../lib/messageBrowserCompose.js';
import { getDraft, claimDraftForSend, finishDraftSend, releaseDraftSend } from './messageDrafts.js';
import { getAccount, listAccounts } from './messageAccounts.js';

// Everything a browser delivery needs that can be refused WITHOUT consuming the
// draft's approval: whether it can be delivered at all and to whom, the message it
// answers (looked up in the draft's OWN account cache, so a draft can never answer
// another account's thread), and whether the shared browser sign-in could be a
// different account of the same type.
async function prepareBrowserDelivery(account, draft) {
  let replyTarget = null;
  if (draft.replyToMessageId) {
    const { getMessage } = await import('./messageSync.js');
    replyTarget = await getMessage(account.id, draft.replyToMessageId);
  }
  const planned = planDelivery(account.type, draft, replyTarget);
  if (!planned.ok) return { refusal: { success: false, status: planned.status, code: planned.code, error: planned.error } };
  const sameType = (await listAccounts()).filter(other => other.type === account.type && other.enabled !== false);
  return { delivery: { replyTarget, requireIdentity: sameType.length > 1 } };
}

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

  const expectedSendVia = sendViaForAccountType(account.type);
  if (draft.sendVia !== expectedSendVia) {
    return { success: false, status: 400, code: 'SEND_VIA_MISMATCH', error: `sendVia "${draft.sendVia}" does not match account type "${account.type}" (expected "${expectedSendVia}")` };
  }

  let delivery = null;
  if (draft.sendVia === 'playwright') {
    const prepared = await prepareBrowserDelivery(account, draft);
    if (prepared.refusal) return prepared.refusal;
    delivery = prepared.delivery;
  }

  draft = await claimDraftForSend(draftId);
  console.log(`📧 Sending draft ${draft.id} via ${draft.sendVia}`);

  const dispatch = async () => {
    if (draft.sendVia === 'api') {
      const { sendGmail } = await import('./messageGmailSync.js');
      return sendGmail(account, draft);
    }
    const { sendPlaywright } = await import('./messagePlaywrightSync.js');
    return sendPlaywright(account, draft, delivery);
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
    } else if (result?.deliveryUnknown) {
      // The transport cannot say whether it left. Park the draft in the same
      // human-reconciled state a crash leaves — never `failed`, which can be re-approved and resent.
      await finishDraftSend(draftId, draft.sendAttemptId, 'delivery_unknown').catch(err => console.warn(`⚠️ Failed to mark draft delivery unknown: ${messageLogError(err)}`));
      io?.emit('messages:changed', {});
      console.warn(`⚠️ Draft delivery unconfirmed: ${draft.id} awaits reconciliation`);
      return { success: false, status: result.status ?? 502, code: 'DELIVERY_UNKNOWN', error: result.error };
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
