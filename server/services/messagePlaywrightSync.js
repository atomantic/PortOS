import { readOutlookMessageRow } from '../lib/messageBrowserIdentity.js';
import { join } from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS, safeJSONParse, tryReadFile, atomicWrite } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { createMutex } from '../lib/asyncMutex.js';
import { messageLogError } from '../lib/messageLogError.js';
import {
  COMPOSE_PROVIDER_LABEL, SUBMIT_EVALUATE_TIMEOUT_MS, SUBMIT_OBSERVE_MS, buildComposePhaseScript, checkAccountIdentity, classifySendOutcome,
  describeComposeFailure, planDelivery, recipientsMatch, resolveComposeConfig
} from '../lib/messageBrowserCompose.js';
import { findOrOpenPage, listCdpPages, isAuthPage, evaluateOnPage } from './browserService.js';

// Compat re-exports — older consumers and test mocks import these from here
export { findOrOpenPage, isAuthPage, evaluateOnPage };
export const getPages = listCdpPages;

const SELECTORS_FILE = join(PATHS.messages, 'selectors.json');

const OUTLOOK_URL = 'https://outlook.office.com/mail/';
const TEAMS_URL = 'https://teams.microsoft.com/';

function makeExternalId(date, sender, subject) {
  const hash = crypto.createHash('md5')
    .update(`${date}|${sender}|${subject}`)
    .digest('hex')
    .slice(0, 12);
  return `pw-${hash}`;
}

export async function getSelectors() {
  const content = await tryReadFile(SELECTORS_FILE);
  if (!content) return {};
  const parsed = safeJSONParse(content, {}, { context: 'messageSelectors' });
  return isPlainObject(parsed) ? parsed : {};
}

export async function updateSelectors(provider, selectors) {
  const all = await getSelectors();
  all[provider] = selectors;
  await ensureDir(PATHS.messages);
  await atomicWrite(SELECTORS_FILE, all);
  return all[provider];
}

/**
 * Open the provider's web app in the CDP browser for login
 */
export async function launchProvider(accountType) {
  const url = accountType === 'teams' ? TEAMS_URL : OUTLOOK_URL;
  const page = await findOrOpenPage(url).catch(() => null);
  if (!page) return { success: false, error: 'Failed to open browser tab — is portos-browser running?' };
  console.log(`📧 Launched ${accountType} in CDP browser`);
  return { success: true, url: page.url, pageId: page.id, title: page.title };
}

/**
 * Sync messages via CDP browser automation
 * Connects to the portos-browser CDP instance, finds the provider page,
 * and scrapes messages using DOM evaluation.
 * @param {object} account
 * @param {object} cache
 * @param {object} io - Socket.IO instance
 * @param {object} options - { mode: 'unread' | 'full' }
 */
export async function syncPlaywright(account, cache, io, options = {}) {
  const mode = options.mode || 'unread';
  const targetUrl = account.type === 'teams' ? TEAMS_URL : OUTLOOK_URL;
  console.log(`📧 Playwright sync (${mode}) for account ${account.id} (${account.type})`);

  // Find the provider page in CDP browser
  const page = await findOrOpenPage(targetUrl).catch(() => null);
  if (!page) {
    io?.emit('messages:sync:progress', { accountId: account.id, current: 0, total: 0 });
    console.log(`📧 No CDP browser available — launch browser first`);
    return { messages: [], status: 'no-browser' };
  }

  // Check for auth/login page
  if (isAuthPage(page)) {
    console.log(`📧 Auth required for ${account.type} — login page detected`);
    io?.emit('messages:sync:auth-required', { accountId: account.id });
    return { messages: [], status: 'auth-required' };
  }

  // Load selectors for this provider
  const allSelectors = await getSelectors();
  const sels = allSelectors[account.type] || {};

  // Use CDP Runtime.evaluate to extract messages from the page DOM
  // Phase 1: Scrape list view to get message summaries
  const extractScript = buildExtractionScript(account.type, sels, mode);
  const extracted = await evaluateOnPage(page, extractScript);

  if (!extracted || !Array.isArray(extracted)) {
    console.log(`📧 No messages extracted from ${account.type} page`);
    io?.emit('messages:sync:progress', { accountId: account.id, current: 0, total: 0 });
    return { messages: [], status: 'extraction-failed' };
  }

  console.log(`📧 Found ${extracted.length} conversations in list view`);

  // Phase 2: Click into each conversation to get full body + thread messages
  // Only fetch detail for messages we haven't already cached with full body
  const existingMap = new Map(cache.messages.filter(m => m.externalId && m.bodyFull).map(m => [m.externalId, true]));
  const messages = [];
  let detailsFetched = 0;

  // Helper: build a message object from extracted data
  const buildMessage = (msg, extId, overrides = {}) => ({
    id: uuidv4(),
    externalId: extId,
    providerRowId: msg.providerRowId || null,
    threadId: null,
    from: { name: msg.from || '', email: msg.fromEmail || '' },
    to: [], cc: [],
    subject: msg.subject || '',
    bodyText: msg.preview || '',
    bodyFull: false,
    date: msg.date || new Date().toISOString(),
    // `isUnread: null` = the provider cannot measure read state (Teams): record it as
    // unknown rather than manufacturing a read message.
    isRead: msg.isUnread === null ? null : !(msg.isUnread ?? false),
    isUnread: msg.isUnread === null ? null : (msg.isUnread ?? false),
    isPinned: msg.isPinned ?? false,
    isFlagged: msg.isFlagged ?? false,
    isReplied: msg.isReplied ?? false,
    hasMeetingInvite: msg.hasMeetingInvite ?? false,
    labels: [], source: account.type,
    syncedAt: new Date().toISOString(),
    ...overrides
  });

  // Helper: emit a batch of messages to the client in real-time
  const emitMessages = (msgs) => {
    if (!io || msgs.length === 0) return;
    io.emit('messages:sync:message', { accountId: account.id, messages: msgs });
  };

  for (let i = 0; i < extracted.length; i++) {
    const msg = extracted[i];
    const extId = makeExternalId(msg.date || '', msg.from || '', msg.subject || '');
    io?.emit('messages:sync:progress', { accountId: account.id, current: i + 1, total: extracted.length });

    // Skip detail fetch if we already have full body cached
    if (existingMap.has(extId)) {
      const m = buildMessage(msg, extId, { threadId: msg.threadKey || null });
      messages.push(m);
      emitMessages([m]);
      continue;
    }

    // Click into conversation to get full body + thread
    if (account.type === 'outlook') {
      const detail = await fetchOutlookConversationDetail(page, msg.subject, msg.from, msg.date, msg.providerRowId);
      if (detail && detail.length > 0) {
        detailsFetched++;
        const threadKey = `thread-${extId}`;
        const batch = detail.map(threadMsg => buildMessage(msg, makeExternalId(threadMsg.date || msg.date || '', threadMsg.from || msg.from || '', msg.subject || ''), {
          threadId: threadKey,
          from: { name: threadMsg.from || msg.from || '', email: threadMsg.fromEmail || msg.fromEmail || '' },
          to: threadMsg.to || [],
          cc: threadMsg.cc || [],
          bodyText: threadMsg.body || msg.preview || '',
          bodyFull: true,
          date: threadMsg.date || msg.date || new Date().toISOString()
        }));
        messages.push(...batch);
        emitMessages(batch);
      } else {
        const m = buildMessage(msg, extId);
        messages.push(m);
        emitMessages([m]);
      }
    } else {
      const m = buildMessage(msg, extId);
      messages.push(m);
      emitMessages([m]);
    }
  }

  console.log(`📧 Fetched detail for ${detailsFetched}/${extracted.length} conversations`);
  // A bounded DOM scrape cannot prove complete inbox membership.
  return { messages, inboxComplete: false, status: 'success' };
}

/**
 * Click into an Outlook conversation row and extract the full body + all thread messages.
 * Uses Outlook's DOM structure:
 *   main[aria-label="Reading Pane"]
 *     > [aria-label="Email message"]   (one per thread message)
 *       > [role="document"]            ("Message body" — the actual email content)
 *       > h3[aria-label^="From:"]      (sender)
 *       > h3 with date text            (date)
 *       > h3[aria-label^="To:"]        (recipients)
 *       > h3[aria-label^="Cc:"]        (cc)
 * Returns an array of { from, fromEmail, to, cc, date, body } for each message in the thread.
 */
async function fetchOutlookConversationDetail(page, subject, sender, date, providerRowId) {
  // Preserve the same provider row identity when loading detail from a virtualized list.
  const safeSubject = JSON.stringify(subject || '');
  const safeSender = JSON.stringify(sender || '');
  const clickResult = await evaluateOnPage(page, `
    (async function() {
      const listbox = document.querySelector("[role='listbox']");
      if (!listbox) return { found: false, hasListbox: false };
      const targetSubject = ${safeSubject};
      const targetSender = ${safeSender};
      const targetDate = ${JSON.stringify(date || '')};
      const targetId = ${JSON.stringify(providerRowId || null)};
      const readRow = ${readOutlookMessageRow.toString()};
      const scrollContainer = listbox.closest('[role="region"]') || listbox.parentElement;

      function findMatch() {
        const matches = [...listbox.querySelectorAll('[role="option"]')].filter(row => {
          const data = readRow(row);
          if (targetId) return data.providerRowId === targetId;
          return targetSubject && targetSender && targetDate
            && data.subject === targetSubject && data.from === targetSender && data.date === targetDate;
        });
        return matches.length === 1 ? matches[0] : null;
      }

      // Check visible rows first, then scroll to find the message
      let matched = findMatch();
      if (!matched && scrollContainer) {
        const maxScroll = 30;
        for (let i = 0; i < maxScroll; i++) {
          scrollContainer.scrollBy(0, 600);
          await new Promise(r => setTimeout(r, 300));
          matched = findMatch();
          if (matched) break;
        }
      }
      if (!matched) return { found: false, hasListbox: true };
      matched.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 200));
      var urlBefore = location.href;
      matched.click();
      // Wait for navigation or reading pane content to change
      for (var w = 0; w < 20; w++) {
        await new Promise(r => setTimeout(r, 300));
        if (location.href !== urlBefore) break;
        var rp = document.querySelector('main[aria-label="Reading Pane"]');
        if (rp && rp.querySelector('[role="document"]')) break;
      }
      // Extra settle time for DOM to finish rendering
      await new Promise(r => setTimeout(r, 1000));
      return true;
    })()
  `);

  if (clickResult && typeof clickResult === 'object' && !clickResult.found) {
    console.log(`📧 Detail click: message not found (listbox=${clickResult.hasListbox})`);
    return null;
  }
  if (!clickResult) {
    console.log(`📧 Detail click: evaluation failed`);
    return null;
  }

  // Extract all messages from the reading pane or full-page conversation view.
  // Verify the loaded content matches the expected subject to prevent mismatch
  // from stale DOM content during full-page navigation.
  const threadMessages = await evaluateOnPage(page, `
    (function() {
      const readingPane = document.querySelector('main[aria-label="Reading Pane"]');
      const convContainer = document.querySelector('[data-app-section="ConversationContainer"]');
      const root = readingPane || convContainer;
      if (!root) return [];

      const emailContainers = root.querySelectorAll('[aria-label="Email message"]');
      const results = [];

      for (const container of emailContainers) {
        // Body: role="document" is the "Message body"
        const bodyDoc = container.querySelector('[role="document"]');
        const body = bodyDoc?.innerText?.trim() || '';
        if (!body) continue;

        // Sender: [aria-label^="From:"] (h3 in split view, span in full-page)
        let from = '', fromEmail = '';
        const fromEl = container.querySelector('[aria-label^="From:"]');
        if (fromEl) {
          const fromBtn = fromEl.querySelector('button');
          const fromText = fromBtn?.textContent?.trim() || fromEl.textContent?.replace(/^From:\\s*/, '').trim() || '';
          const emailMatch = fromText.match(/[\\w.+-]+@[\\w.-]+/);
          fromEmail = emailMatch?.[0] || '';
          from = fromText.replace(/<[^>]+>/, '').replace(emailMatch?.[0] || '', '').trim() || fromText;
        }

        // Date: look for h3/span/div with a date pattern
        let date = '';
        const candidates = container.querySelectorAll('h3, span, div');
        for (const el of candidates) {
          if (el.querySelector('*:not(br)') && el.children.length > 0) continue;
          const text = el.textContent?.trim() || '';
          if (/\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}/.test(text) && !text.startsWith('From') && !text.startsWith('To') && !text.startsWith('Cc')) {
            date = text;
            break;
          }
        }

        // To: [aria-label^="To:"] (h3 in split view, div in full-page)
        const to = [];
        const toEl = container.querySelector('[aria-label^="To:"]');
        if (toEl) {
          const btns = toEl.querySelectorAll('button');
          if (btns.length > 0) {
            btns.forEach(btn => { const t = btn.textContent?.trim(); if (t) to.push(t); });
          } else {
            const spans = toEl.querySelectorAll('span[aria-label]');
            spans.forEach(s => { const t = s.textContent?.trim(); if (t) to.push(t); });
          }
        }

        // Cc: [aria-label^="Cc:"] (h3 in split view, div in full-page)
        const cc = [];
        const ccEl = container.querySelector('[aria-label^="Cc:"]');
        if (ccEl) {
          const btns = ccEl.querySelectorAll('button');
          if (btns.length > 0) {
            btns.forEach(btn => { const t = btn.textContent?.trim(); if (t) cc.push(t); });
          } else {
            const spans = ccEl.querySelectorAll('span[aria-label]');
            spans.forEach(s => { const t = s.textContent?.trim(); if (t) cc.push(t); });
          }
        }

        results.push({ from, fromEmail, to, cc, date, body });
      }

      // Fallback: no Email message containers found — try grabbing role="document" directly
      if (results.length === 0) {
        const docs = root.querySelectorAll('[role="document"]');
        for (const doc of docs) {
          const body = doc.innerText?.trim() || '';
          if (body) results.push({ from: '', fromEmail: '', to: [], cc: [], date: '', body });
        }
      }

      // Verify content matches expected subject to prevent stale-DOM mismatches
      const expectedSubject = ${safeSubject}.toLowerCase();
      if (expectedSubject && results.length > 0) {
        const pageText = (root.innerText || '').toLowerCase();
        if (!pageText.includes(expectedSubject)) return [];
      }

      return results;
    })()
  `);

  return threadMessages;
}

function buildExtractionScript(type, sels, mode = 'unread') {
  if (type === 'outlook') {
    const maxMessages = mode === 'full' ? 200 : 100;
    const maxScrolls = mode === 'full' ? 20 : 10;
    // Scrolling extraction: scrapes visible rows, scrolls, repeats
    return `
      (async function() {
        const listbox = document.querySelector("[role='listbox']");
        if (!listbox) return [];
        const seen = new Map();
        let scrollAttempts = 0;
        const maxMsg = ${maxMessages};
        const maxScroll = ${maxScrolls};
        const unreadOnly = ${mode === 'unread'};

        const extractRow = ${readOutlookMessageRow.toString()};

        function scrapeVisible() {
          const rows = listbox.querySelectorAll('[role="option"]');
          let added = 0;
          for (const row of rows) {
            if (seen.size >= maxMsg) break;
            const data = extractRow(row);
            if (!data.from && !data.subject) continue;
            const key = data.providerRowId || data.from + '|' + data.subject + '|' + data.date;
            if (seen.has(key)) continue;
            if (unreadOnly && !data.isUnread) continue;
            seen.set(key, data);
            added++;
          }
          return added;
        }

        scrapeVisible();
        const scrollContainer = listbox.closest('[role="region"]') || listbox.parentElement;
        while (scrollAttempts < maxScroll && seen.size < maxMsg) {
          scrollContainer.scrollBy(0, 600);
          await new Promise(r => setTimeout(r, 500));
          const added = scrapeVisible();
          if (added === 0) scrollAttempts++;
          else scrollAttempts = 0;
        }
        // Scroll back to top
        scrollContainer.scrollTo(0, 0);
        return Array.from(seen.values());
      })()
    `;
  }
  if (type === 'teams') {
    const msgSel = sels.messageItem || "[role='listitem']";
    return `
      (function() {
        const items = document.querySelectorAll(${JSON.stringify(msgSel)});
        return Array.from(items).slice(0, 50).map(item => {
          const text = item.innerText || '';
          const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
          return {
            from: lines[0] || '',
            subject: '',
            preview: lines[1] || '',
            date: lines[2] || '',
            // The Teams list view exposes no read-state marker we can trust, so the
            // state is unknown — never "read" (#9968). null survives normalization.
            isUnread: null,
            isPinned: false,
            isFlagged: false,
            isReplied: false,
            hasMeetingInvite: false
          };
        });
      })()
    `;
  }
  return '[]';
}

/**
 * Re-fetch detail for a single message via CDP browser automation.
 * Returns updated thread messages array or null.
 */
export async function refreshMessageDetail(account, message) {
  if (account.type !== 'outlook') return null;

  // Find existing Outlook tab — don't open a new one (it would need to load/auth)
  const pages = await getPages().catch(() => []);
  const page = pages.find(p => p.url?.includes('outlook.office.com/mail'));
  if (!page) {
    console.log(`📧 Refresh: no Outlook tab open — launch Outlook first`);
    return { error: 'no-browser', message: 'No Outlook tab open. Open Outlook in the browser first.' };
  }
  if (!page.webSocketDebuggerUrl) {
    console.log(`📧 Refresh: Outlook tab found but no WebSocket URL`);
    return { error: 'no-ws', message: 'Cannot connect to Outlook tab' };
  }
  if (isAuthPage(page)) {
    console.log(`📧 Refresh: auth page detected — login required`);
    return { error: 'auth-required', message: 'Login required — sign into Outlook first' };
  }

  console.log(`📧 Refresh: clicking into ${message.id}`);
  const detail = await fetchOutlookConversationDetail(page, message.subject, message.from?.name, message.date, message.providerRowId);
  if (!detail) {
    console.log(`📧 Refresh: click/extraction failed for ${message.id}`);
  } else {
    console.log(`📧 Refresh: extracted ${detail.length} thread messages`);
  }
  return detail;
}

const SEND_PAGE_MATCH = { outlook: 'outlook.office.com/mail', teams: 'teams.microsoft.com' };

// One browser tab per provider, so two sends to the same provider must not
// interleave their compose steps. Claimed drafts of different providers still run in parallel.
const sendLocks = { outlook: createMutex(), teams: createMutex() };

// A send never opens a tab: a freshly opened one cannot be signed in, and the
// sign-in state the user already established is exactly what authorizes the send.
async function findExistingProviderPage(provider) {
  const pages = await getPages().catch(() => []);
  return pages.find(page => (!page.type || page.type === 'page') && page.url?.includes(SEND_PAGE_MATCH[provider])) ?? null;
}

const notSent = (status, code, error) => ({ success: false, status, code, error });

const deliveryUnknown = label => ({
  success: false,
  deliveryUnknown: true,
  status: 502,
  code: 'DELIVERY_UNKNOWN',
  error: `${label} did not confirm delivery and it may already have been sent. Check ${label === 'Teams' ? 'the conversation' : 'Sent Items'}, then record the outcome. PortOS will not resend it.`
});

/**
 * Deliver an approved draft through the provider's web UI. Every phase before the
 * single submit click is side-effect free and fails as a definite "not sent"; after
 * the click, only a positive provider acknowledgement is success and anything else
 * is `deliveryUnknown` — never retried here (see `lib/messageBrowserCompose.js`).
 */
async function deliverViaBrowser(account, draft, { replyTarget, requireIdentity }, markSubmitting) {
  const provider = account.type;
  const label = COMPOSE_PROVIDER_LABEL[provider];
  const planned = planDelivery(provider, draft, replyTarget);
  if (!planned.ok) return notSent(planned.status, planned.code, planned.error);
  const { plan } = planned;

  const page = await findExistingProviderPage(provider);
  if (!page) return notSent(409, 'PROVIDER_TAB_UNAVAILABLE', `No ${label} tab is open in the PortOS browser — open ${label}, sign in, and retry`);
  if (!page.webSocketDebuggerUrl) return notSent(502, 'PROVIDER_TAB_UNAVAILABLE', `Cannot connect to the ${label} tab`);
  if (isAuthPage(page)) return notSent(409, 'PROVIDER_LOGIN_REQUIRED', `Login required — sign into ${label} and retry`);

  const config = resolveComposeConfig(provider, (await getSelectors())[provider]);
  const token = draft.sendAttemptId || uuidv4();
  const run = (phase, extra = {}, options) =>
    evaluateOnPage(page, buildComposePhaseScript(phase, { provider, sels: config.sels, token, ...extra }), options);
  // Only used before the click: removes our own compose surface, best effort.
  const abort = async failure => {
    await run('discard').catch(() => null);
    return { success: false, ...describeComposeFailure(provider, failure) };
  };

  const identity = await run('probe');
  if (!identity) return notSent(502, 'PROVIDER_TAB_UNAVAILABLE', `The ${label} tab did not respond`);
  const who = checkAccountIdentity({ expected: account.email, observed: identity, required: requireIdentity });
  if (!who.ok) {
    return notSent(409, who.code, who.code === 'ACCOUNT_IDENTITY_MISMATCH'
      ? `The ${label} tab is signed in as a different account — sign into this account and retry`
      : `Several ${label} accounts exist and the browser tab does not show which one is signed in, so sending is blocked to keep it from going out of the wrong mailbox`);
  }

  const opened = await run('open', { to: plan.to, reply: plan.reply });
  if (opened?.ok !== true) return abort(opened);
  if (provider === 'teams' && !recipientsMatch(plan, { to: opened.resolved, cc: [] })) return abort({ code: 'RECIPIENT_MISMATCH' });

  const filled = await run('fill', { to: plan.to, cc: plan.cc, subject: plan.subject, body: plan.body, reply: plan.reply });
  if (filled?.ok !== true) return abort(filled);
  if (provider === 'outlook' && !recipientsMatch(plan, filled)) return abort({ code: 'RECIPIENT_MISMATCH' });
  if (filled.bodyOk !== true || filled.subjectOk === false) return abort({ code: 'CONTENT_MISMATCH' });

  markSubmitting(); // from here a throw can no longer prove nothing was sent
  const observed = await run('submit', {
    body: plan.body, ackPattern: config.ackPattern, refusalPattern: config.refusalPattern, timeoutMs: SUBMIT_OBSERVE_MS
  }, { timeout: SUBMIT_EVALUATE_TIMEOUT_MS });
  const verdict = classifySendOutcome(observed);
  if (verdict.outcome === 'confirmed') {
    console.log(`📧 ${label} send confirmed: draft ${draft.id}`);
    return { success: true, confirmed: true };
  }
  if (verdict.outcome === 'not_sent') return abort(verdict);
  if (verdict.outcome === 'refused') {
    return notSent(502, 'PROVIDER_REFUSED', `${label} refused the message. Close its compose window, fix the problem, and approve the draft again`);
  }
  console.warn(`⚠️ ${label} delivery unconfirmed: draft ${draft.id}`);
  return deliveryUnknown(label);
}

/**
 * Send an approved draft via the provider's web UI (Outlook / Teams).
 * `replyTarget` is the cached message the draft answers, resolved within the
 * draft's own account by the sender; `requireIdentity` is set when more than one
 * enabled account shares this provider's single browser sign-in.
 */
export async function sendPlaywright(account, draft, options) {
  const { replyTarget = null, requireIdentity = false } = options ?? {};
  const label = COMPOSE_PROVIDER_LABEL[account.type];
  if (!label) return notSent(501, 'SEND_NOT_SUPPORTED', "Sending from this account isn't supported yet — copy the draft");
  return sendLocks[account.type](async () => {
    let submitting = false;
    return deliverViaBrowser(account, draft, { replyTarget, requireIdentity }, () => { submitting = true; }).catch(error => {
      // A throw before the click is a definite failure; once Send may have been
      // clicked the same throw cannot prove the message stayed in the mailbox.
      if (submitting) {
        console.warn(`⚠️ ${label} delivery unconfirmed after error: draft ${draft.id}: ${messageLogError(error)}`);
        return deliveryUnknown(label);
      }
      console.error(`❌ ${label} send failed before submit: draft ${draft.id}: ${messageLogError(error)}`);
      return notSent(502, 'SEND_FAILED', `${label} send failed before anything was submitted — nothing was sent`);
    });
  });
}

/**
 * Test selectors against the live provider page.
 * Reuses the same page as a real sync (`findOrOpenPage`, so a not-yet-open tab
 * is opened rather than failing outright — a tab already open for this
 * provider is reused, never re-navigated) and the same auth check
 * (`isAuthPage`), so a stale login redirect is reported as `auth-required`
 * instead of silently evaluating to zero matches and reading as a broken
 * selector.
 */
export async function testSelectors(provider) {
  const targetUrl = provider === 'teams' ? TEAMS_URL : OUTLOOK_URL;
  const page = await findOrOpenPage(targetUrl).catch(() => null);
  if (!page) {
    return { provider, results: {}, status: 'no-browser', error: 'Failed to open a browser tab — is portos-browser running?' };
  }

  if (isAuthPage(page)) {
    return { provider, results: {}, status: 'auth-required', error: 'Login required — sign into the provider first' };
  }

  const allSelectors = await getSelectors();
  const sels = allSelectors[provider] || {};
  const results = {};

  for (const [name, selector] of Object.entries(sels)) {
    const count = await evaluateOnPage(page,
      `document.querySelectorAll(${JSON.stringify(selector)}).length`
    );
    results[name] = { selector, matches: count ?? 0 };
  }

  const entries = Object.values(results);
  const status = entries.length === 0 ? 'no-selectors' : entries.every(r => r.matches > 0) ? 'ok' : 'partial';
  console.log(`📧 Selector test for ${provider}: ${status}`);
  return { provider, results, status };
}
