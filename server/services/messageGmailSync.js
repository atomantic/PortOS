/**
 * Gmail API sync — fetches messages and sends drafts via the Google API.
 * Uses the shared Google OAuth client from googleAuth.js (same credentials as Calendar).
 */

import { google } from 'googleapis';
import { v4 as uuidv4 } from '../lib/uuid.js';
import crypto from 'crypto';
import { getAuthenticatedClient } from './googleAuth.js';

function makeExternalId(gmailId) {
  return 'api-gmail-' + crypto.createHash('md5').update(gmailId).digest('hex').slice(0, 12);
}

function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBase64Url(str) {
  if (!str) return '';
  let padded = str.replace(/-/g, '+').replace(/_/g, '/');
  padded += '=='.slice(0, (4 - (padded.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

/**
 * Convert HTML to readable plain text by stripping style/script/head blocks, then tags.
 */
function htmlToText(html) {
  return html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&zwnj;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Extract text and HTML body from Gmail message payload.
 * Returns { text, html } — prefers text/plain for text, keeps raw HTML separately.
 */
function extractBody(payload) {
  if (!payload) return { text: '', html: '' };

  // Simple message with body data directly
  if (payload.body?.data) {
    const content = decodeBase64Url(payload.body.data);
    const isHtml = payload.mimeType === 'text/html';
    return {
      text: isHtml ? htmlToText(content) : content,
      html: isHtml ? content : ''
    };
  }

  // Multipart — collect both text/plain and text/html
  if (payload.parts) {
    let text = '';
    let html = '';

    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data && !text) {
        text = decodeBase64Url(part.body.data);
      }
      if (part.mimeType === 'text/html' && part.body?.data && !html) {
        html = decodeBase64Url(part.body.data);
      }
      // Recurse into nested multipart
      if (part.parts && !text && !html) {
        const nested = extractBody(part);
        if (nested.text) text = nested.text;
        if (nested.html) html = nested.html;
      }
    }

    // If no plain text but have HTML, derive text from HTML
    if (!text && html) {
      text = htmlToText(html);
    }

    return { text, html };
  }

  return { text: '', html: '' };
}

/**
 * Parse recipient string "Name <email>" or just "email"
 */
function parseRecipients(headerValue) {
  if (!headerValue) return [];
  return headerValue.split(',').map(r => {
    const match = r.trim().match(/<([^>]+)>/);
    return match ? match[1] : r.trim();
  }).filter(Boolean);
}

/**
 * Parse sender into { name, email }
 */
function parseSender(fromHeader) {
  if (!fromHeader) return { name: '', email: '' };
  const match = fromHeader.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].replace(/^"|"$/g, '').trim(), email: match[2] };
  return { name: '', email: fromHeader.trim() };
}

/**
 * Sync Gmail messages via the Google API.
 * @param {object} account - Account config
 * @param {object} cache - Existing cache
 * @param {object} io - Socket.IO instance
 * @param {object} options - { mode: 'unread' | 'full' }
 * @returns {{ messages, status, syncMethod }}
 */
export async function syncGmail(account, cache, io, options = {}) {
  const mode = options.mode || 'unread';
  const auth = await getAuthenticatedClient();

  if (!auth) {
    console.log(`📧 Gmail sync for ${account.email}: Google OAuth not configured`);
    return { messages: [], status: 'not-configured' };
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const maxMessages = mode === 'full' ? 200 : 100;
  const query = mode === 'unread' ? 'is:unread in:inbox' : 'in:inbox';

  console.log(`📧 Gmail API sync (${mode}) for ${account.email}`);

  // Step 1: List message IDs
  const messageIds = [];
  let pageToken = null;

  do {
    io?.emit('messages:sync:progress', { accountId: account.id, current: messageIds.length, total: maxMessages });

    const listResult = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(100, maxMessages - messageIds.length),
      ...(pageToken && { pageToken })
    });

    const items = listResult.data.messages || [];
    messageIds.push(...items);
    pageToken = listResult.data.nextPageToken;
  } while (pageToken && messageIds.length < maxMessages);

  console.log(`📧 Gmail: found ${messageIds.length} message IDs, fetching details`);

  // Step 2: Fetch full message details in parallel batches
  const messages = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    io?.emit('messages:sync:progress', { accountId: account.id, current: i, total: messageIds.length });

    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(({ id: gmailId }) =>
      gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' })
        .catch(err => { console.log(`📧 Gmail: failed to fetch ${gmailId}: ${err.message}`); return null; })
    ));

    for (let j = 0; j < results.length; j++) {
      if (!results[j]) continue;
      const data = results[j].data;
      const { id: gmailId, threadId: gmailThreadId } = batch[j];
      const headers = data.payload?.headers || [];
      const from = parseSender(getHeader(headers, 'From'));
      const labelIds = data.labelIds || [];
      const body = extractBody(data.payload);

      messages.push({
        id: uuidv4(),
        externalId: makeExternalId(gmailId),
        apiId: gmailId,
        conversationId: gmailThreadId || null,
        threadId: gmailThreadId ? `conv-${crypto.createHash('md5').update(gmailThreadId).digest('hex').slice(0, 12)}` : null,
        from,
        to: parseRecipients(getHeader(headers, 'To')),
        cc: parseRecipients(getHeader(headers, 'Cc')),
        subject: getHeader(headers, 'Subject'),
        bodyText: body.text,
        bodyHtml: body.html || undefined,
        bodyFull: !!(body.text || body.html),
        date: data.internalDate ? new Date(parseInt(data.internalDate)).toISOString() : new Date().toISOString(),
        isRead: !labelIds.includes('UNREAD'),
        isUnread: labelIds.includes('UNREAD'),
        isPinned: false,
        isFlagged: labelIds.includes('STARRED'),
        isReplied: false,
        hasMeetingInvite: (getHeader(headers, 'Subject') || '').toLowerCase().includes('invitation'),
        importance: labelIds.includes('IMPORTANT') ? 'High' : 'Normal',
        categories: labelIds.filter(l => !['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT'].includes(l)),
        labels: labelIds,
        source: 'gmail',
        syncMethod: 'api',
        syncedAt: new Date().toISOString()
      });
    }
  }

  if (io && messages.length > 0) {
    io.emit('messages:sync:message', { accountId: account.id, messages });
  }

  console.log(`📧 Gmail API sync complete: ${messages.length} messages fetched`);
  return { messages, status: 'success', syncMethod: 'api' };
}

/**
 * Send email via Gmail API.
 * @param {object} account - Account config
 * @param {object} draft - Draft with to, cc, subject, body
 * @returns {{ success: boolean, error?: string }}
 */
export async function sendGmail(account, draft) {
  const auth = await getAuthenticatedClient();
  if (!auth) {
    return { success: false, error: 'Google OAuth not configured', status: 502, code: 'GMAIL_NOT_CONFIGURED' };
  }

  const gmail = google.gmail({ version: 'v1', auth });

  // Build RFC 2822 message
  const toLine = Array.isArray(draft.to) ? draft.to.join(', ') : draft.to;
  const lines = [
    `To: ${toLine}`,
    `Subject: ${draft.subject || ''}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0'
  ];
  if (draft.cc) {
    const ccLine = Array.isArray(draft.cc) ? draft.cc.join(', ') : draft.cc;
    lines.push(`Cc: ${ccLine}`);
  }
  if (draft.replyToMessageId && draft.threadId) {
    // For replies, set In-Reply-To and References headers
    lines.push(`In-Reply-To: ${draft.replyToMessageId}`);
    lines.push(`References: ${draft.replyToMessageId}`);
  }
  lines.push('', draft.body || '');

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  }).catch(err => {
    console.error(`📧 Gmail send failed: ${err.message}`);
    return null;
  });

  if (!result) {
    return { success: false, error: 'Gmail API send failed', status: 502, code: 'GMAIL_SEND_FAILED' };
  }

  console.log(`📧 Gmail sent: ${draft.subject} (id: ${result.data?.id})`);
  return { success: true };
}
