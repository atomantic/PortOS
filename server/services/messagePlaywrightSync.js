import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { loadConfig } from './browserService.js';

const SELECTORS_FILE = join(PATHS.messages, 'selectors.json');

const OUTLOOK_URL = 'https://outlook.office.com/mail/';
const TEAMS_URL = 'https://teams.microsoft.com/';

// Auth detection patterns in page titles/URLs
const AUTH_PATTERNS = ['login.microsoftonline.com', 'okta.com', 'login.live.com', 'Sign in'];

function makeExternalId(date, sender, subject) {
  const hash = crypto.createHash('md5')
    .update(`${date}|${sender}|${subject}`)
    .digest('hex')
    .slice(0, 12);
  return `pw-${hash}`;
}

// TODO: Extract shared CDP helpers (getCdpConnectHost, cdpFetch, getPages, findOrOpenPage)
// into browserService.js to avoid duplication with existing CDP logic there
async function getCdpConnectHost() {
  const config = await loadConfig();
  const host = (config.cdpHost === '0.0.0.0' || config.cdpHost === '::') ? '127.0.0.1' : config.cdpHost;
  return { host, port: config.cdpPort };
}

async function cdpFetch(path, options = {}) {
  const { host, port } = await getCdpConnectHost();
  const url = `http://${host}:${port}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 10000);
  const response = await fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
  return response;
}

export async function getPages() {
  const response = await cdpFetch('/json/list');
  if (!response.ok) return [];
  return response.json();
}

export async function findOrOpenPage(targetUrl) {
  const pages = await getPages();
  // Find existing tab matching the target
  const existing = pages.find(p => p.url?.includes(new URL(targetUrl).hostname));
  if (existing) return existing;
  // Open new tab
  const response = await cdpFetch(`/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!response.ok) return null;
  return response.json();
}

export function isAuthPage(page) {
  const url = page.url || '';
  const title = page.title || '';
  return AUTH_PATTERNS.some(p => url.includes(p) || title.includes(p));
}

export async function evaluateOnPage(page, expression) {
  const wsUrl = page.webSocketDebuggerUrl;
  if (!wsUrl) return null;

  const { default: WebSocket } = await import('ws');

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve(null); }, 60000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });

    ws.on('message', (data) => {
      const msg = safeJSONParse(data.toString(), null, { context: 'cdp-ws' });
      if (!msg || msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error || msg.result?.exceptionDetails) return resolve(null);
      resolve(msg.result?.result?.value ?? null);
    });

    ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(null); });
  });
}

export async function getSelectors() {
  const content = await readFile(SELECTORS_FILE, 'utf-8').catch(() => null);
  if (!content) return {};
  const parsed = safeJSONParse(content, {}, { context: 'messageSelectors' });
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

export async function updateSelectors(provider, selectors) {
  const all = await getSelectors();
  all[provider] = selectors;
  await ensureDir(PATHS.messages);
  await writeFile(SELECTORS_FILE, JSON.stringify(all, null, 2));
  return all[provider];
}

/**
 * Open the provider's web app in the CDP browser for login
 */
export async function launchProvider(accountType) {
  const url = accountType === 'teams' ? TEAMS_URL : OUTLOOK_URL;
  const page = await findOrOpenPage(url).catch(() => null);
  if (!page) return { success: false, error: 'Failed to open browser tab — is portos-browser running?' };
  console.log(`📧 Launched ${accountType} in CDP browser: ${page.url}`);
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
  console.log(`📧 Playwright sync (${mode}) for ${account.email} (${account.type})`);

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
    threadId: null,
    from: { name: msg.from || '', email: msg.fromEmail || '' },
    to: [], cc: [],
    subject: msg.subject || '',
    bodyText: msg.preview || '',
    bodyFull: false,
    date: msg.date || new Date().toISOString(),
    isRead: !(msg.isUnread ?? false),
    isUnread: msg.isUnread ?? false,
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
      const detail = await fetchOutlookConversationDetail(page, msg.subject, msg.from);
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
  return { messages, status: 'success' };
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
async function fetchOutlookConversationDetail(page, subject, sender) {
  // Find and click the row by matching subject text (not index, since Outlook virtualizes the list)
  const safeSubject = JSON.stringify(subject || '');
  const safeSender = JSON.stringify(sender || '');
  const clickResult = await evaluateOnPage(page, `
    (async function() {
      const listbox = document.querySelector("[role='listbox']");
      if (!listbox) return { found: false, hasListbox: false };
      const targetSubject = ${safeSubject}.toLowerCase();
      const targetSender = ${safeSender}.toLowerCase();
      const scrollContainer = listbox.closest('[role="region"]') || listbox.parentElement;

      function findMatch() {
        const rows = listbox.querySelectorAll('[role="option"]');
        let fallback = null;
        for (const row of rows) {
          const label = (row.getAttribute('aria-label') || '').toLowerCase();
          const text = (row.innerText || '').toLowerCase();
          if (targetSubject && (label.includes(targetSubject) || text.includes(targetSubject))) {
            if (!targetSender || label.includes(targetSender) || text.includes(targetSender)) {
              return row;
            }
            if (!fallback) fallback = row;
          }
        }
        return fallback;
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

        function extractRow(row) {
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
            const dateSpan = spans.find(s => s.getAttribute('title')?.match(/\\d{4}/));
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
            const dateMatch = ariaLabel.match(/(\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)/);
            date = dateMatch?.[1] || '';
          }

          return { from, fromEmail, subject, date, preview, isUnread, isPinned, isFlagged, isReplied, hasMeetingInvite };
        }

        function scrapeVisible() {
          const rows = listbox.querySelectorAll('[role="option"]');
          let added = 0;
          for (const row of rows) {
            if (seen.size >= maxMsg) break;
            const data = extractRow(row);
            if (!data.from && !data.subject) continue;
            const key = data.from + '|' + data.subject + '|' + data.date;
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
            isUnread: false,
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

  console.log(`📧 Refresh: clicking into "${message.subject}"`);
  const detail = await fetchOutlookConversationDetail(page, message.subject, message.from?.name);
  if (!detail) {
    console.log(`📧 Refresh: click/extraction failed for "${message.subject}"`);
  } else {
    console.log(`📧 Refresh: extracted ${detail.length} thread messages`);
  }
  return detail;
}

/**
 * Send message via Playwright browser automation
 */
export async function sendPlaywright(account, draft) {
  console.log(`📧 Playwright send for ${account.email} (${account.type}) — automation pending`);
  return { success: false, error: 'Playwright send not yet implemented', status: 501, code: 'NOT_IMPLEMENTED' };
}

/**
 * Test selectors against the current page
 */
export async function testSelectors(provider) {
  const targetUrl = provider === 'teams' ? TEAMS_URL : OUTLOOK_URL;
  const pages = await getPages().catch(() => []);
  const page = pages.find(p => p.url?.includes(new URL(targetUrl).hostname));
  if (!page) return { provider, results: {}, status: 'no_page', error: 'No browser tab open for this provider' };

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
