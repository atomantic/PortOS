import { createHash } from 'node:crypto';

/** DOM reader shared by Outlook ingestion and destructive browser actions.
 * Self-contained so it can be serialized into a CDP evaluation. */
export function readOutlookMessageRow(row) {
  const ariaLabel = row.getAttribute('aria-label') || '';
  const isUnread = !!row.querySelector('button[aria-label="Mark as read"]');
  const isPinned = !!row.querySelector('button[aria-label*="Unpin"]');
  const isFlagged = !!row.querySelector('button[aria-label*="Unflag"]');
  const isReplied = ariaLabel.includes('Replied');
  const hasMeetingInvite = !!row.querySelector('button[aria-label="RSVP"]');

  const avatarSpan = row.querySelector('div[aria-label="Select a conversation"] > span[aria-label]');
  const from = avatarSpan?.getAttribute('aria-label') || '';

  const checkbox = row.querySelector('div[aria-label="Select a conversation"]');
  const contentArea = checkbox?.parentElement?.nextElementSibling;
  const contentDivs = contentArea ? Array.from(contentArea.children) : [];

  let subject = '', date = '', preview = '', fromEmail = '';

  if (contentDivs.length >= 3) {
    const senderDiv = contentDivs[0];
    const emailSpan = senderDiv?.querySelector('span[title*="@"]');
    fromEmail = emailSpan?.getAttribute('title') || '';

    const subDateDiv = contentDivs[1];
    const spans = subDateDiv ? Array.from(subDateDiv.querySelectorAll('span')) : [];
    subject = spans[0]?.textContent?.trim() || '';
    const dateSpan = spans.find(s => s.getAttribute('title')?.match(/\d{4}/));
    date = dateSpan?.getAttribute('title') || spans[spans.length - 1]?.textContent?.trim() || '';

    preview = contentDivs[2]?.textContent?.trim() || '';
  } else if (contentDivs.length >= 1) {
    const allSpans = contentDivs[0]?.querySelectorAll('span[title]') || [];
    const spanArr = Array.from(allSpans);
    const emailSpan = spanArr.find(s => (s.getAttribute('title') || '').includes('@'));
    fromEmail = emailSpan?.getAttribute('title') || '';
    // In compact layout: first titled span is sender, second is subject
    const titledSpans = spanArr.filter(s => s.closest('[class]'));
    subject = titledSpans.length > 1 ? titledSpans[titledSpans.length - 1]?.textContent?.trim() || '' : '';
    // Fallback: find span whose text differs from sender name
    if (!subject) {
      subject = spanArr.find(s => s.textContent?.trim() && s.textContent.trim() !== from && !(s.getAttribute('title') || '').includes('@'))?.textContent?.trim() || '';
    }
    const dateMatch = ariaLabel.match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/);
    date = dateMatch?.[1] || '';
  }

  const providerRowId = row.getAttribute('data-itemid') || row.getAttribute('data-convid') || null;
  return { providerRowId, from, fromEmail, subject, date, preview, isUnread, isPinned, isFlagged, isReplied, hasMeetingInvite };
}

/** All values are serialized as JSON, never interpolated as executable text. */
export function buildMessageBrowserActionScript(provider, message, action) {
  const identity = {
    id: message.id,
    providerRowId: message.providerRowId || null,
    subject: message.subject,
    from: message.from,
    date: message.date
  };
  return `(${actOnMessageRow.toString()})(${JSON.stringify(provider)}, ${JSON.stringify(identity)}, ${JSON.stringify(action)}, ${readOutlookMessageRow.toString()})`;
}

// Runs entirely inside the provider page. No keyboard shortcuts or global bulk
// actions: those can act on a different focused message or an existing selection.
async function actOnMessageRow(provider, identity, action, readOutlookRow) {
  const conflict = () => ({ code: 'MESSAGE_IDENTITY_CONFLICT' });
  const list = document.querySelector(provider === 'outlook' ? '[role="listbox"]' : '[role="main"]');
  if (!list || !['archive', 'delete'].includes(action)) return conflict();
  const rowSelector = provider === 'outlook' ? '[role="option"]' : 'tr.zA';
  const rows = () => [...list.querySelectorAll(rowSelector)];
  function read(row) {
    if (provider === 'outlook') return readOutlookRow(row);
    const sender = row.querySelector('[email]');
    const dated = row.querySelector('td.xW [title]');
    const idNode = row.matches('[data-legacy-message-id], [data-legacy-thread-id]')
      ? row : row.querySelector('[data-legacy-message-id], [data-legacy-thread-id]');
    return {
      providerRowId: idNode?.getAttribute('data-legacy-message-id') || idNode?.getAttribute('data-legacy-thread-id') || null,
      subject: row.querySelector('.bog')?.textContent?.trim() || '',
      from: sender?.getAttribute('name') || sender?.textContent?.trim() || '',
      fromEmail: sender?.getAttribute('email') || '',
      date: dated?.getAttribute('title') || ''
    };
  }
  function sameTimestamp(actual, expected) {
    if (actual === expected) return true;
    // Normalize only complete, timezone-qualified timestamps. Relative dates,
    // date-only labels and timezone-less wall clocks are not exact identities.
    const complete = value => typeof value === 'string' && /\d{4}/.test(value)
      && /\d{1,2}:\d{2}/.test(value) && /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)(?:\s|$)/i.test(value);
    if (!complete(actual) || !complete(expected)) return false;
    const actualTime = Date.parse(actual);
    return Number.isFinite(actualTime) && actualTime === Date.parse(expected);
  }
  function matches(row) {
    const actual = read(row);
    if (identity.providerRowId) return actual.providerRowId === identity.providerRowId;
    // Legacy records must supply every identity dimension. Do not normalize
    // case, truncate subjects, or guess missing dates/senders.
    if (!identity.subject?.trim() || !identity.date || !(identity.from?.email || identity.from?.name)) return false;
    return actual.subject === identity.subject && sameTimestamp(actual.date, identity.date)
      && (!identity.from.email || actual.fromEmail === identity.from.email)
      && (!identity.from.name || actual.from === identity.from.name);
  }
  // A virtualized/scrolling list cannot establish legacy uniqueness outside the
  // rendered window. A fresh sync may supply an ID; otherwise use the provider UI.
  if (!identity.providerRowId) {
    const visibleCount = rows().length;
    if (list.scrollHeight > list.clientHeight
      || Number(list.getAttribute('aria-rowcount')) > visibleCount
      || rows().some(row => Number(row.getAttribute('aria-setsize')) > visibleCount)) return conflict();
  }
  const candidates = rows().filter(matches);
  if (candidates.length !== 1) return conflict();
  const target = candidates[0];
  const label = action === 'archive' ? 'Archive' : 'Delete';
  const controls = [...target.querySelectorAll('button, [role="button"]')].filter(button =>
    [button.getAttribute('aria-label'), button.getAttribute('data-tooltip'), button.getAttribute('title')].includes(label)
    && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  if (controls.length !== 1) return conflict();
  // Recheck immediately before the side effect, without an intervening await.
  if (!target.isConnected || !matches(target) || rows().filter(matches).length !== 1) return conflict();
  const url = location.href;
  controls[0].click();
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    // Navigation or a missing list is not evidence that this message was removed.
    if (location.href !== url || !list.isConnected) return { code: 'MESSAGE_ACTION_UNCONFIRMED' };
    if (rows().filter(matches).length === 0) return { success: true, messageId: identity.id };
  }
  return { code: 'MESSAGE_ACTION_UNCONFIRMED' };
}

/** Compatibility hash: existing no-provider-ID messages keep their IDs. */
export function browserSummaryId(date, sender, subject) {
  return 'pw-' + createHash('md5').update(`${date}|${sender}|${subject}`).digest('hex').slice(0, 12);
}

/** A conversation row and its expanded messages are different identity domains. */
export function messageIngestionIdentity(message) {
  if (!message.providerRowId) return message.externalId || message.id;
  const row = message.providerRowId;
  const member = message.browserMessageKind === 'member'
    || (!message.browserMessageKind && message.bodyFull && message.threadId);
  if (!member) return `browser-row:${JSON.stringify(row)}`;
  if (message.providerMessageId) return `browser-member:${JSON.stringify([row, message.providerMessageId])}`;
  const parsed = Date.parse(message.date);
  const date = Number.isFinite(parsed) ? new Date(parsed).toISOString() : message.date;
  const sender = message.from?.email?.trim().toLowerCase() || message.from?.name || '';
  return `browser-member:${JSON.stringify([row, date || '', sender, message.browserMemberDisambiguator || ''])}`;
}

/** Shared detail mapping for initial browser sync and explicit refresh. */
export function browserDetailIdentities(summary, details) {
  const members = details.map(detail => {
    const date = detail.date || summary.date || '';
    const name = detail.from || summary.from?.name || '';
    return {
      externalId: browserSummaryId(date, name, summary.subject || ''),
      providerRowId: summary.providerRowId || null,
      providerMessageId: detail.providerMessageId || null,
      browserMessageKind: 'member',
      from: { name, email: detail.fromEmail || summary.from?.email || '' },
      date
    };
  });
  const counts = new Map();
  for (const member of members) {
    const key = messageIngestionIdentity(member);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // A timestamp/sender collision is not permission to overwrite a sibling.
  // Exact body + occurrence preserves distinct observed members on replay;
  // a changed ambiguous body gets a new record instead of stealing an old one.
  const occurrences = new Map();
  return members.map((member, index) => {
    const key = messageIngestionIdentity(member);
    if (member.providerRowId && !member.providerMessageId && counts.get(key) > 1) {
      const body = createHash('sha256').update(details[index].body || '').digest('hex');
      const occurrenceKey = `${key}:${body}`;
      const occurrence = occurrences.get(occurrenceKey) || 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      member.browserMemberDisambiguator = `${body}:${occurrence}`;
    }
    return member;
  });
}

/** Match only unique identities; a summary fallback may never cross known rows. */
export function matchBrowserMessage(messages, incoming, batch = [incoming]) {
  const key = messageIngestionIdentity(incoming);
  const exact = messages.filter(message => messageIngestionIdentity(message) === key);
  if (exact.length === 1 && batch.filter(message => messageIngestionIdentity(message) === key).length === 1) return exact[0];
  if (exact.length) return null;
  const compatible = (message, candidate) => {
    const summaryBecomesMember = message.providerRowId && message.providerRowId === candidate.providerRowId
      && candidate.browserMessageKind === 'member' && !message.bodyFull
      && Number.isFinite(Date.parse(message.date)) && Date.parse(message.date) === Date.parse(candidate.date)
      && (message.from?.email && candidate.from?.email
        ? message.from.email.trim().toLowerCase() === candidate.from.email.trim().toLowerCase()
        : message.from?.name && message.from.name === candidate.from?.name);
    return (message.externalId === candidate.externalId || summaryBecomesMember)
      && !(candidate.browserMessageKind === 'row' && (message.browserMessageKind === 'member' || (message.bodyFull && message.threadId)))
      && (!message.providerRowId || !candidate.providerRowId || message.providerRowId === candidate.providerRowId)
      && !message.browserMemberDisambiguator && !candidate.browserMemberDisambiguator;
  };
  const fallback = messages.filter(message => compatible(message, incoming));
  return fallback.length === 1 && batch.filter(candidate => compatible(fallback[0], candidate)).length === 1 ? fallback[0] : null;
}

/** Pin unambiguous legacy activity keys before changing display-derived hashes.
 * This additive cache alias keeps the existing DB event and its ID intact. */
export function retainLegacyActivityIdentities(messages) {
  const counts = new Map();
  for (const message of messages) counts.set(message.externalId, (counts.get(message.externalId) || 0) + 1);
  for (const message of messages) {
    if (!message.browserMessageKind && !message.activityIdentity && message.externalId && counts.get(message.externalId) === 1) {
      message.activityIdentity = message.externalId;
    }
  }
}
