import { getAccount } from './messageAccounts.js';
import { getMessage } from './messageSync.js';
import { findOrOpenPage, getPages, isAuthPage, evaluateOnPage } from './messagePlaywrightSync.js';
import { recordCorrection } from './messageTriageRules.js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';

const CACHE_DIR = join(PATHS.messages, 'cache');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROVIDER_URLS = {
  outlook: 'https://outlook.office.com/mail/',
  gmail: 'https://mail.google.com/'
};

async function loadCache(accountId) {
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  const content = await readFile(filePath, 'utf-8').catch(() => null);
  if (!content) return { syncCursor: null, messages: [] };
  return safeJSONParse(content, { syncCursor: null, messages: [] }, { context: `messageCache:${accountId}` });
}

async function saveCache(accountId, cache) {
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  await writeFile(filePath, JSON.stringify(cache, null, 2));
}

async function removeFromCache(accountId, messageId) {
  const cache = await loadCache(accountId);
  cache.messages = cache.messages.filter(m => m.id !== messageId);
  await saveCache(accountId, cache);
}

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
    await new Promise(r => setTimeout(r, pollInterval));
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
  if (!UUID_RE.test(accountId)) throw new Error('Invalid accountId');
  if (!['archive', 'delete'].includes(action)) throw new Error(`Unsupported action: ${action}`);

  const account = await getAccount(accountId);
  if (!account) throw new Error('Account not found');

  const message = await getMessage(accountId, messageId);
  if (!message) throw new Error('Message not found');

  if (!PROVIDER_URLS[account.type]) {
    throw new Error(`${action} not supported for ${account.type}`);
  }

  const page = await ensureProviderPage(account.type);

  const safeSubject = (message.subject || '').replace(/'/g, "\\'").replace(/\n/g, ' ');
  const script = account.type === 'outlook'
    ? buildOutlookActionScript(safeSubject, action)
    : buildGmailActionScript(safeSubject, action);

  console.log(`📧 ${action} message "${message.subject}" via ${account.type} browser`);
  const result = await evaluateOnPage(page, script);

  if (!result || result.error) {
    const errorMsg = result?.error || `${action} failed — script returned no result`;
    // If message genuinely not in inbox, just clean up local cache
    if (result?.notInInbox) {
      console.log(`📧 "${message.subject}" not found in inbox, cleaning up local cache`);
    } else {
      throw new Error(errorMsg);
    }
  } else {
    console.log(`📧 ${action} executed in browser for "${message.subject}"`);
  }

  // Record triage correction if user chose differently than the AI
  const triaged = message.evaluation?.action;
  if (triaged && triaged !== action) {
    await recordCorrection({
      from: message.from?.name || message.from?.email || 'Unknown',
      subject: message.subject || '',
      triaged,
      corrected: action
    }).catch(() => {});
  }

  await removeFromCache(accountId, messageId);
  console.log(`📧 ${action} complete for "${message.subject}"`);

  return { success: true, action, messageId };
}

function buildOutlookActionScript(subject, action) {
  // Use the same listbox/option approach proven by the sync scraper,
  // then use keyboard shortcuts (Delete key or Backspace for archive)
  const keyCode = action === 'delete' ? 'Delete' : 'Backspace';
  return `(async () => {
    const listbox = document.querySelector("[role='listbox']");
    if (!listbox) return { error: 'No message list found — is Outlook inbox visible?' };

    const targetSubject = ${JSON.stringify(subject)}.toLowerCase();
    const scrollContainer = listbox.closest('[role="region"]') || listbox.parentElement;

    function findMatch() {
      const rows = listbox.querySelectorAll('[role="option"]');
      for (const row of rows) {
        const label = (row.getAttribute('aria-label') || '').toLowerCase();
        const text = (row.innerText || '').toLowerCase();
        if (label.includes(targetSubject) || text.includes(targetSubject)) return row;
      }
      return null;
    }

    // Search visible rows, then scroll to find
    let matched = findMatch();
    if (!matched && scrollContainer) {
      for (let i = 0; i < 15; i++) {
        scrollContainer.scrollBy(0, 600);
        await new Promise(r => setTimeout(r, 300));
        matched = findMatch();
        if (matched) break;
      }
    }
    if (!matched) return { error: 'Message not found in inbox view', notInInbox: true };

    // Select the message
    matched.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 200));
    matched.click();
    await new Promise(r => setTimeout(r, 500));

    // Use keyboard shortcut — most reliable in Outlook web
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: '${keyCode}', code: '${keyCode}', bubbles: true }));
    await new Promise(r => setTimeout(r, 500));

    // Fallback: try toolbar button if keyboard didn't work
    const label = '${action === 'delete' ? 'Delete' : 'Archive'}';
    const btn = [...document.querySelectorAll('button[aria-label]')].find(b =>
      b.getAttribute('aria-label')?.toLowerCase().includes(label.toLowerCase()) && b.offsetParent !== null
    );
    if (btn) {
      btn.click();
      await new Promise(r => setTimeout(r, 500));
    }

    // Verify the message is gone from the list
    await new Promise(r => setTimeout(r, 500));
    const stillThere = findMatch();
    if (stillThere) return { error: 'Message still in inbox after ${action} attempt — action may not have worked' };

    return { success: true };
  })()`;
}

function buildGmailActionScript(subject, action) {
  const ariaLabel = action === 'archive' ? 'Archive' : 'Delete';
  return `(async () => {
    const rows = [...document.querySelectorAll('tr.zA, [role="row"]')];
    const row = rows.find(r => r.textContent?.includes('${subject}'));
    if (!row) return { error: 'Message not found in inbox view' };

    const checkbox = row.querySelector('[role="checkbox"], input[type="checkbox"]');
    if (checkbox) checkbox.click();
    await new Promise(r => setTimeout(r, 300));

    const btn = document.querySelector('[aria-label="${ariaLabel}"], [data-tooltip="${ariaLabel}"]');
    if (!btn) return { error: '${ariaLabel} button not found' };

    btn.click();
    await new Promise(r => setTimeout(r, 1000));
    return { success: true };
  })()`;
}
