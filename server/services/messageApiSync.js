/**
 * API-based message sync for Outlook and Teams.
 * Uses bearer tokens extracted from the browser session to call REST APIs directly.
 * Falls back to Playwright scraping if token extraction fails.
 */

import { v4 as uuidv4 } from '../lib/uuid.js';
import crypto from 'crypto';
import { getToken } from './messageTokenExtractor.js';

function makeExternalId(prefix, id) {
  // For API sync, use a stable ID from the API response
  const hash = crypto.createHash('md5').update(id).digest('hex').slice(0, 12);
  return `api-${prefix}-${hash}`;
}

/**
 * Fetch Outlook inbox messages via the REST API.
 * @param {object} account - Account config
 * @param {object} cache - Existing cache
 * @param {object} io - Socket.IO instance
 * @param {object} options - { mode: 'unread' | 'full' }
 * @returns {{ messages, status, syncMethod }} or null if token unavailable
 */
export async function syncOutlookApi(account, cache, io, options = {}) {
  const mode = options.mode || 'unread';
  const tokenResult = await getToken('outlook');

  if (tokenResult.error) {
    console.log(`📧 API sync unavailable for ${account.email}: ${tokenResult.message}`);
    return null; // Signal to fall back to Playwright
  }

  const token = tokenResult.token;
  const maxMessages = mode === 'full' ? 200 : 100;
  console.log(`📧 API sync (${mode}) for ${account.email}`);

  // Build query — unread mode filters to unread only
  let filter = '';
  if (mode === 'unread') {
    filter = '&$filter=IsRead eq false';
  }

  const select = '$select=Subject,From,ToRecipients,CcRecipients,ReceivedDateTime,IsRead,BodyPreview,Body,Flag,Categories,ConversationId,Importance,IsDeliveryReceiptRequested';
  const orderBy = '$orderby=ReceivedDateTime desc';
  const baseUrl = `https://outlook.office.com/api/v2.0/me/mailfolders/inbox/messages?${select}&${orderBy}&$top=${maxMessages}${filter}`;

  const messages = [];
  let url = baseUrl;
  let page = 0;

  while (url && messages.length < maxMessages) {
    page++;
    io?.emit('messages:sync:progress', { accountId: account.id, current: messages.length, total: maxMessages, page });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="Text"' },
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`📧 API sync failed (${response.status}): ${text.slice(0, 200)}`);
      if (response.status === 401) {
        // Token expired — clear cache so next sync re-extracts
        const { clearTokenCache } = await import('./messageTokenExtractor.js');
        clearTokenCache('outlook');
        return null; // Fall back to Playwright
      }
      return { messages: [], status: 'api-error' };
    }

    const data = await response.json();
    const items = data.value || [];

    for (const m of items) {
      const extId = makeExternalId('ol', m.Id);
      const msg = {
        id: uuidv4(),
        externalId: extId,
        apiId: m.Id,
        conversationId: m.ConversationId || null,
        threadId: m.ConversationId ? `conv-${crypto.createHash('md5').update(m.ConversationId).digest('hex').slice(0, 12)}` : null,
        from: {
          name: m.From?.EmailAddress?.Name || '',
          email: m.From?.EmailAddress?.Address || ''
        },
        to: (m.ToRecipients || []).map(r => r.EmailAddress?.Address || r.EmailAddress?.Name || ''),
        cc: (m.CcRecipients || []).map(r => r.EmailAddress?.Address || r.EmailAddress?.Name || ''),
        subject: m.Subject || '',
        bodyText: m.Body?.Content || m.BodyPreview || '',
        bodyFull: !!(m.Body?.Content),
        date: m.ReceivedDateTime || new Date().toISOString(),
        isRead: m.IsRead ?? true,
        isUnread: !(m.IsRead ?? true),
        isPinned: false,
        isFlagged: m.Flag?.FlagStatus === 'Flagged',
        isReplied: false, // Not directly available in this endpoint
        hasMeetingInvite: (m.Subject || '').toLowerCase().includes('meeting') || false,
        importance: m.Importance || 'Normal',
        categories: m.Categories || [],
        labels: m.Categories || [],
        source: 'outlook',
        syncMethod: 'api',
        syncedAt: new Date().toISOString()
      };
      messages.push(msg);
    }

    // Follow @odata.nextLink for pagination
    url = data['@odata.nextLink'] || null;
    if (messages.length >= maxMessages) break;
  }

  // Emit messages in real-time
  if (io && messages.length > 0) {
    io.emit('messages:sync:message', { accountId: account.id, messages });
  }

  console.log(`📧 API sync complete: ${messages.length} messages fetched in ${page} page(s)`);
  return { messages, status: 'success', syncMethod: 'api' };
}

/**
 * Teams API sync is not yet available.
 * Teams v2 is a fully offline-first PWA using service workers and WebSocket (SignalR)
 * for data. The Graph API token from the browser lacks Chat.Read scope, and the
 * chatsvcagg token doesn't map to documented REST endpoints.
 * Teams continues to use Playwright scraping for now.
 * @returns null (signals fallback to Playwright)
 */
export async function syncTeamsApi() {
  return null;
}
