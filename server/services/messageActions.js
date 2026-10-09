import { ServerError } from '../lib/errorHandler.js';
import { buildMessageBrowserActionScript } from '../lib/messageBrowserIdentity.js';
import { getAccount } from './messageAccounts.js';
import { getMessage, removeMessageFromCache } from './messageSync.js';
import { findOrOpenPage, getPages, isAuthPage, evaluateOnPage } from './messagePlaywrightSync.js';
import { recordCorrection } from './messageTriageRules.js';
import { UUID_RE, sleep } from '../lib/fileUtils.js';

const PROVIDER_URLS = {
  outlook: 'https://outlook.office.com/mail/',
  gmail: 'https://mail.google.com/'
};

/**
 * Wait for a provider page to be ready (past auth screens).
 * Auto-launches the tab if not open, then polls until auth completes or timeout.
 */
async function ensureProviderPage(accountType) {
  const url = PROVIDER_URLS[accountType];
  if (!url) throw new Error(`Unsupported provider: ${accountType}`);

  // Launch or find the tab
  console.log(`📧 Ensuring ${accountType} browser tab is ready...`);
  let page = await findOrOpenPage(url).catch(() => null);
  if (!page) throw new Error(`Failed to open ${accountType} browser tab — is portos-browser running?`);

  // If already on the mail page (not auth), we're good
  if (!isAuthPage(page)) return page;

  // Auth page detected — poll until the user logs in (up to 2 minutes)
  console.log(`📧 Auth page detected for ${accountType} — waiting for login...`);
  const maxWait = 120000;
  const pollInterval = 3000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(pollInterval);
    const pages = await getPages().catch(() => []);
    const hostname = new URL(url).hostname;
    page = pages.find(p => p.url?.includes(hostname));
    if (page && !isAuthPage(page)) {
      console.log(`📧 ${accountType} auth complete, proceeding`);
      return page;
    }
  }

  throw new Error(`Login timed out — please sign into ${accountType} and try again`);
}

/**
 * Execute an action (archive/delete) on a message via CDP browser automation.
 * Auto-launches the browser tab and waits for auth if needed.
 */
export async function executeAction(accountId, messageId, action) {
  if (!UUID_RE.test(accountId)) throw new ServerError('Invalid accountId', { status: 400, code: 'VALIDATION_ERROR' });
  if (!['archive', 'delete'].includes(action)) throw new ServerError(`Unsupported action: ${action}`, { status: 400, code: 'VALIDATION_ERROR' });

  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });

  const message = await getMessage(accountId, messageId);
  if (!message) throw new ServerError('Message not found', { status: 404, code: 'NOT_FOUND' });

  // Gmail: use API directly instead of browser automation
  if (account.type === 'gmail' && message.apiId) {
    await executeGmailApiAction(message, action);
  } else if (account.type === 'outlook' || account.type === 'gmail') {
    const page = await ensureProviderPage(account.type);
    console.log(`📧 ${action} message ${message.id} via ${account.type} browser`);
    const result = await evaluateOnPage(page, buildMessageBrowserActionScript(account.type, message, action));
    if (result?.code === 'MESSAGE_IDENTITY_CONFLICT') {
      throw new ServerError('Cannot uniquely identify this message in the browser. Sync the account and retry, or archive/delete it directly in your mail provider.', {
        status: 409, code: 'MESSAGE_IDENTITY_CONFLICT'
      });
    }
    if (result?.success !== true || result.messageId !== messageId) {
      throw new ServerError('The browser action could not be confirmed. Check your mail provider before retrying; the cached message has been kept.', {
        status: 409, code: 'MESSAGE_ACTION_UNCONFIRMED'
      });
    }
  } else {
    throw new Error(`${action} not supported for ${account.type}`);
  }

  // Record triage correction if user chose differently than the AI
  const triaged = message.evaluation?.action;
  if (triaged && triaged !== action) {
    await recordCorrection({
      from: message.from?.name || message.from?.email || 'Unknown',
      subject: message.subject || '',
      triaged,
      corrected: action
    }).catch(() => {
      // The provider action already completed. Report persistence failure without
      // leaking mailbox content or turning success into a request to retry it.
      console.error('❌ Message triage correction could not be persisted');
    });
  }

  await removeMessageFromCache(accountId, messageId);
  console.log(`📧 ${action} complete for ${message.id}`);

  return { success: true, action, messageId };
}

/**
 * Execute archive/delete on Gmail via the Google API.
 * Archive = remove INBOX label. Delete = move to trash.
 */
async function executeGmailApiAction(message, action) {
  const { gmail } = await import('@googleapis/gmail');
  const { getAuthenticatedClient } = await import('./googleAuth.js');

  const auth = await getAuthenticatedClient();
  if (!auth) throw new Error('Google OAuth not configured');

  const gmailClient = gmail({ version: 'v1', auth });

  if (action === 'delete') {
    await gmailClient.users.messages.trash({ userId: 'me', id: message.apiId });
    console.log(`📧 Gmail API: trashed ${message.id}`);
  } else if (action === 'archive') {
    await gmailClient.users.messages.modify({
      userId: 'me',
      id: message.apiId,
      requestBody: { removeLabelIds: ['INBOX'] }
    });
    console.log(`📧 Gmail API: archived ${message.id}`);
  }
}
