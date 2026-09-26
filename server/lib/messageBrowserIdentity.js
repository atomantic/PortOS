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
    for (let node = list; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight) return conflict();
    }
    if (rows().some(row => Number(row.getAttribute('aria-setsize')) > rows().length)) return conflict();
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
