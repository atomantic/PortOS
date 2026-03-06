import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
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

async function getPages() {
  const response = await cdpFetch('/json/list');
  if (!response.ok) return [];
  return response.json();
}

async function findOrOpenPage(targetUrl) {
  const pages = await getPages();
  // Find existing tab matching the target
  const existing = pages.find(p => p.url?.includes(new URL(targetUrl).hostname));
  if (existing) return existing;
  // Open new tab
  const response = await cdpFetch(`/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!response.ok) return null;
  return response.json();
}

function isAuthPage(page) {
  const url = page.url || '';
  const title = page.title || '';
  return AUTH_PATTERNS.some(p => url.includes(p) || title.includes(p));
}

async function evaluateOnPage(page, expression) {
  const wsUrl = page.webSocketDebuggerUrl;
  if (!wsUrl) return null;

  const { default: WebSocket } = await import('ws');

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve(null); }, 15000);

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
 * and scrapes messages using DOM evaluation
 */
export async function syncPlaywright(account, cache, io) {
  const targetUrl = account.type === 'teams' ? TEAMS_URL : OUTLOOK_URL;
  console.log(`📧 Playwright sync for ${account.email} (${account.type})`);

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
  const extractScript = buildExtractionScript(account.type, sels);
  const extracted = await evaluateOnPage(page, extractScript);

  if (!extracted || !Array.isArray(extracted)) {
    console.log(`📧 No messages extracted from ${account.type} page`);
    io?.emit('messages:sync:progress', { accountId: account.id, current: 0, total: 0 });
    return { messages: [], status: 'extraction-failed' };
  }

  io?.emit('messages:sync:progress', { accountId: account.id, current: extracted.length, total: extracted.length });

  // Convert extracted data to message format
  const messages = extracted.map(msg => ({
    id: uuidv4(),
    externalId: makeExternalId(msg.date || '', msg.from || '', msg.subject || ''),
    threadId: null,
    from: { name: msg.from || '', email: msg.fromEmail || '' },
    to: [],
    cc: [],
    subject: msg.subject || '',
    bodyText: msg.preview || '',
    date: msg.date || new Date().toISOString(),
    isRead: msg.isRead ?? true,
    labels: [],
    source: account.type,
    syncedAt: new Date().toISOString()
  }));
  return { messages, status: 'success' };
}

function buildExtractionScript(type, sels) {
  if (type === 'outlook') {
    const listSel = sels.messageRow || "[role='listitem']";
    return `
      (function() {
        const rows = document.querySelectorAll(${JSON.stringify(listSel)});
        return Array.from(rows).slice(0, 50).map(row => {
          const text = row.innerText || '';
          const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
          return {
            from: lines[0] || '',
            subject: lines[1] || '',
            preview: lines[2] || '',
            date: lines[3] || '',
            isRead: !row.querySelector('[aria-label*="Unread"]')
          };
        });
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
            isRead: true
          };
        });
      })()
    `;
  }
  return '[]';
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
