/**
 * Gmail API sync — fetches messages and sends drafts via the Google API.
 * Uses the shared Google OAuth client from googleAuth.js (same credentials as Calendar).
 */

import { gmail } from '@googleapis/gmail';
import { v4 as uuidv4 } from '../lib/uuid.js';
import crypto from 'crypto';
import { getAuthenticatedClient } from './googleAuth.js';
import { htmlToText as sharedHtmlToText } from '../lib/htmlToText.js';

function makeExternalId(gmailId) {
  return 'api-gmail-' + crypto.createHash('md5').update(gmailId).digest('hex').slice(0, 12);
}

// How far back to pull sent mail when reply-detection ingestion is on. Must stay
// >= tribeOutreach's DEFAULT_WITHIN_DAYS (14) — a reply older than the detection
// window can't answer an inbound that's still actionable, so no need to ingest it;
// but if this were SHORTER than the window, a reply inside the window would be
// missed and its inbound would falsely read as unanswered. The coupling is pinned
// by a test in messageGmailSync.test.js.
export const SENT_INGEST_DAYS = 14;

// Sent mail gets its OWN fetch budget (a separate list pass), never a share of the
// inbox cap — sent is activity-only and must not crowd inbox out of the primary
// sync. The sent pass paginates the ENTIRE `in:sent newer_than:14d` window up to
// this generous ceiling (#2820) so a heavy sender's reply beyond the first page
// still gets ingested and can cancel its inbound — a reply un-ingested here would
// falsely read as unanswered. The ceiling only bounds the pathological case (>1000
// sent in 14 days); if it's actually hit, coverage is partial for that sync — the
// per-account reliability watermark (`sentIngestedAt`) plus the detector's own
// row-cap fail-closed keep a truncated window from producing false nudges. Sent
// isn't cached, so this also bounds the per-sync detail-fetch cost.
export const SENT_INGEST_MAX = 1000;

// The inbox search query for a sync mode. `unread` scopes to unread inbox; `full`
// takes the whole inbox (capped downstream).
export function inboxQuery(mode) {
  return mode === 'unread' ? 'is:unread in:inbox' : 'in:inbox';
}

// Recent sent mail — no unread state, bounded by date instead. Ingested so it lands
// in the same cache the human-activity timeline reads, recording `message.sent`
// events that let Tribe-outreach detection see a Gmail thread as replied (#2796).
export function sentQuery() {
  return `in:sent newer_than:${SENT_INGEST_DAYS}d`;
}

/**
 * The ordered (query, cap) list-passes for one Gmail sync. Inbox always runs with
 * the full `inboxCap`; recent sent mail runs as a SEPARATE pass with its own
 * `SENT_INGEST_MAX` budget when the account opts into reply-detection ingestion
 * (the per-account default, opt out via `syncConfig.ingestSent === false`). Separate
 * passes mean sent volume never crowds the inbox out of a shared cap.
 */
export function gmailSyncPasses(mode, ingestSent, inboxCap) {
  const passes = [{ query: inboxQuery(mode), cap: inboxCap }];
  if (ingestSent) passes.push({ query: sentQuery(), cap: SENT_INGEST_MAX });
  return passes;
}

/**
 * List message ids across every pass, paginating each pass FULLY up to its cap
 * (#2820) — the sent pass must walk past the first page or a heavy sender's reply
 * beyond page 1 goes un-ingested and its inbound falsely reads as unanswered.
 * Dedupes by gmail id across passes (a thread can appear in both inbox and sent).
 *
 * `listFn({ q, maxResults, pageToken })` returns `{ messages: [{ id }], nextPageToken }`.
 * Injected so the pagination is unit-testable without a live Gmail client.
 *
 * @returns {Promise<Array<{ id: string }>>} deduped message-id items, in fetch order
 */
export async function collectMessageIds(passes, listFn, { onProgress } = {}) {
  const messageIds = [];
  const seen = new Set();
  for (const pass of passes) {
    let pageToken = null;
    let fetched = 0;
    do {
      onProgress?.(messageIds.length);
      const { messages = [], nextPageToken = null } = await listFn({
        q: pass.query,
        maxResults: Math.min(100, pass.cap - fetched),
        pageToken,
      });
      fetched += messages.length;
      for (const item of messages) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        messageIds.push(item);
      }
      pageToken = nextPageToken;
    } while (pageToken && fetched < pass.cap);
  }
  return messageIds;
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
 * Convert HTML to readable plain text via the shared strip-tags pipeline.
 * Mail-specific options: `&zwnj;` decodes to nothing, `</p>` keeps a blank
 * line between paragraphs, and space/tab runs collapse (email HTML is
 * whitespace-noisy and carries no meaningful column alignment).
 */
function htmlToText(html) {
  return sharedHtmlToText(html, { extraEntities: { zwnj: '' }, paragraphBreak: '\n\n', collapseSpaces: true });
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

  const gmailClient = gmail({ version: 'v1', auth });
  const maxMessages = mode === 'full' ? 200 : 100;
  // Ingest sent mail unless the account explicitly opted out — the default-on
  // capability powers per-account Tribe-outreach reply detection (#2796).
  const ingestSent = account?.syncConfig?.ingestSent !== false;
  const passes = gmailSyncPasses(mode, ingestSent, maxMessages);
  const totalCap = passes.reduce((sum, p) => sum + p.cap, 0);

  console.log(`📧 Gmail API sync (${mode}${ingestSent ? '+sent' : ''}) for ${account.email}`);

  // Step 1: List message IDs — one pass per (query, cap), each paginated fully up
  // to its cap and deduped across passes (a thread can appear in both inbox and
  // sent). See `collectMessageIds` for the pagination contract (#2820).
  const messageIds = await collectMessageIds(
    passes,
    async ({ q, maxResults, pageToken }) => {
      const listResult = await gmailClient.users.messages.list({
        userId: 'me',
        q,
        maxResults,
        ...(pageToken && { pageToken }),
      });
      return { messages: listResult.data.messages || [], nextPageToken: listResult.data.nextPageToken || null };
    },
    { onProgress: (current) => io?.emit('messages:sync:progress', { accountId: account.id, current, total: totalCap }) },
  );

  console.log(`📧 Gmail: found ${messageIds.length} message IDs, fetching details`);

  // Step 2: Fetch full message details in parallel batches
  const messages = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    io?.emit('messages:sync:progress', { accountId: account.id, current: i, total: messageIds.length });

    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(({ id: gmailId }) =>
      gmailClient.users.messages.get({ userId: 'me', id: gmailId, format: 'full' })
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

  // Split inbox vs sent: sent mail is ingested ONLY for the human-activity timeline
  // (reply detection, #2796) — it must NOT enter the inbox cache, or it would show
  // up in /api/messages/inbox, run through triage/eval, and compete with real inbox
  // mail under the maxMessages trim (which could evict a message before its activity
  // is recorded). A message the user sent carries Gmail's SENT label and no INBOX
  // label; anything with INBOX (including a self-addressed SENT+INBOX message) stays
  // inbox. syncAccount records sent activity from `sentMessages` separately.
  const inboxMessages = [];
  const sentMessages = [];
  for (const m of messages) {
    const lbl = m.labels || [];
    if (lbl.includes('SENT') && !lbl.includes('INBOX')) sentMessages.push(m);
    else inboxMessages.push(m);
  }

  if (io && inboxMessages.length > 0) {
    io.emit('messages:sync:message', { accountId: account.id, messages: inboxMessages });
  }

  console.log(`📧 Gmail API sync complete: ${inboxMessages.length} inbox, ${sentMessages.length} sent (activity-only)`);
  return { messages: inboxMessages, sentMessages, status: 'success', syncMethod: 'api' };
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

  const gmailClient = gmail({ version: 'v1', auth });

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

  const result = await gmailClient.users.messages.send({
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
