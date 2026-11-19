/**
 * Spotify extended-history import through the PortOS-managed browser.
 *
 * Spotify's privacy export is an authenticated, user-facing flow rather than
 * a public API. Keep the integration deliberately narrow: the destination is
 * fixed to Spotify's privacy page, the CDP page is opened in the user's
 * persistent browser profile, and only the page's fixed controls are clicked.
 * No Spotify password, API credential, or arbitrary URL crosses this service.
 */

import { isPrivateAddress } from '../lib/safeUrlFetch.js';
import { sleep } from '../lib/fileUtils.js';
import { analyzeImportedData } from './digital-twin-import.js';
import { readSpotifyRecords } from './spotifyImport.js';
import {
  closeCdpPage,
  deleteDownload,
  evaluateOnPage,
  getDownloads,
  listCdpPages,
  navigateToUrlPinned,
  resolveDownload,
} from './browserService.js';

export const SPOTIFY_PRIVACY_URL = 'https://www.spotify.com/account/privacy/';

const SPOTIFY_WEB_ORIGIN = 'https://www.spotify.com';
const SPOTIFY_ACCOUNTS_ORIGIN = 'https://accounts.spotify.com';
const PAGE_SETTLE_MS = 1200;
const DOWNLOAD_WAIT_MS = 10000;
const DOWNLOAD_POLL_MS = 500;

const SPOTIFY_PAGE_STATE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const controls = [...document.querySelectorAll('button, a, [role="button"], label, input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]')];
  const labels = controls.map((node) => normalize(node.innerText || node.textContent || node.getAttribute('aria-label')));
  const bodyText = normalize(document.body?.innerText);
  const hasExtendedHistory = labels.some((label) => label.includes('extended streaming history'));
  const hasDownloadAction = labels.some((label) => (
    label.includes('request data')
    || label.includes('request your data')
    || label.includes('request my data')
    || label.includes('request extended streaming history')
    || label === 'request'
    || label.includes('download your data')
    || label.includes('download extended streaming history')
  ));
  return {
    privacyPage: /\\/account\\/privacy(?:\\/|$)/i.test(location.pathname),
    loginForm: Boolean(document.querySelector('input[type="password"], form[action*="login"]')),
    hasExtendedHistory,
    hasDownloadAction,
    requestPending: /request(?:ed|ing)|being prepared|we(?:'|’)ll email you/.test(bodyText),
  };
})()`;

// This expression is intentionally closed over no caller data. It only clicks
// the named Extended Streaming History option and one of the known data-request
// controls on Spotify's privacy page. The action is still user-triggered from
// the Digital Twin UI, so a provider call never starts in the background.
const SPOTIFY_REQUEST_DOWNLOAD_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const controls = () => [...document.querySelectorAll('button, a, [role="button"], label, input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]')];
  const bodyText = normalize(document.body?.innerText);
  if (/request(?:ed|ing)|being prepared|we(?:'|’)ll email you/.test(bodyText)) {
    return { clicked: false, requestPending: true, extendedSelected: false };
  }
  const extended = controls().find((node) => normalize(node.innerText || node.textContent || node.getAttribute('aria-label')).includes('extended streaming history'));
  if (!extended) return { clicked: false, optionMissing: true, extendedSelected: false };
  let selected = false;
  if (extended) {
    const input = extended.matches('input')
      ? extended
      : (extended.querySelector('input[type="checkbox"], input[type="radio"]')
        || (extended.htmlFor ? document.getElementById(extended.htmlFor) : null));
    if (input) {
      if (!input.checked) input.click();
      selected = Boolean(input.checked);
    } else if (extended.getAttribute('aria-checked') !== 'true') {
      extended.click();
      selected = true;
    } else {
      selected = true;
    }
  }
  return new Promise((resolve) => setTimeout(() => {
    const action = controls().find((node) => {
      const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
      return label.includes('request data')
        || label.includes('request your data')
        || label.includes('request my data')
        || label === 'request'
        || label.includes('request extended streaming history')
        || label.includes('download your data')
        || label.includes('download extended streaming history');
    });
    if (!action) return resolve({ clicked: false, extendedSelected: selected });
    const actionLabel = normalize(action.innerText || action.textContent || action.getAttribute('aria-label'));
    if (!selected && !actionLabel.includes('extended streaming history')) {
      return resolve({ clicked: false, extendedSelected: selected });
    }
    action.click();
    resolve({ clicked: true, extendedSelected: selected });
  }, 250));
})()`;

const isSpotifyWebPage = (page) => typeof page?.url === 'string'
  && page.url.startsWith(`${SPOTIFY_WEB_ORIGIN}/`);

export const isSpotifyLoginPage = (page) => typeof page?.url === 'string'
  && page.url.startsWith(`${SPOTIFY_ACCOUNTS_ORIGIN}/`);

export const isSpotifyPrivacyPage = (page) => isSpotifyWebPage(page)
  && /\/account\/privacy(?:\/|$)/i.test(page.url);

const isAllowedSpotifyPage = (page) => isSpotifyWebPage(page) || isSpotifyLoginPage(page);

export const isSpotifyDownloadName = (name) => typeof name === 'string'
  && /\.(?:zip|json)$/i.test(name)
  && /(spotify|streaming[ _-]?history|my[ _-]?spotify)/i.test(name);

async function findSpotifyPage() {
  const pages = await listCdpPages();
  return pages.find(isSpotifyPrivacyPage) || pages.find(isSpotifyLoginPage) || null;
}

async function ensureSpotifyPrivacyPage() {
  const existing = await findSpotifyPage();
  if (existing) return existing;

  // A new page is navigated through the pinned CDP path so Spotify's fixed
  // origin is checked against Chrome's actual network connections before the
  // page is handed to the user for authentication.
  const page = await navigateToUrlPinned(SPOTIFY_PRIVACY_URL, {
    verifyRemoteIp: (ip) => !isPrivateAddress(ip),
    settleMs: PAGE_SETTLE_MS,
    closeAfterRead: false,
  }).catch(() => null);
  if (page && !isAllowedSpotifyPage(page)) {
    await closeCdpPage(page.id).catch((err) => {
      console.error(`⚠️ Failed to close unexpected Spotify browser tab: ${err?.message || String(err)}`);
    });
    return null;
  }
  return page;
}

async function inspectSpotifyPage(page) {
  if (!page) {
    return {
      status: 'no-browser',
      message: 'The PortOS managed browser is not available. Start it from Dev Tools → Browser.',
    };
  }

  if (isSpotifyLoginPage(page)) {
    return {
      status: 'auth-required',
      pageId: page.id,
      url: page.url,
      message: 'Sign in to Spotify in the PortOS managed browser, then check the connection again.',
    };
  }

  const state = await evaluateOnPage(page, SPOTIFY_PAGE_STATE_EXPRESSION);
  if (!state) {
    return {
      status: 'unavailable',
      pageId: page.id,
      url: page.url,
      message: 'Spotify privacy page could not be read. Leave the tab open and try again.',
    };
  }

  if (state.loginForm) {
    return {
      status: 'auth-required',
      pageId: page.id,
      url: page.url,
      message: 'Sign in to Spotify in the PortOS managed browser, then check the connection again.',
    };
  }

  return {
    status: state.privacyPage ? 'ready' : 'loading',
    pageId: page.id,
    url: page.url,
    hasExtendedHistory: Boolean(state.hasExtendedHistory),
    hasDownloadAction: Boolean(state.hasDownloadAction),
    requestPending: Boolean(state.requestPending),
    message: state.privacyPage
      ? 'Spotify privacy page is ready in the PortOS managed browser.'
      : 'Spotify is still loading. Check the connection again in a moment.',
  };
}

export async function openSpotifyBrowser() {
  const page = await ensureSpotifyPrivacyPage();
  return inspectSpotifyPage(page);
}

const downloadSnapshot = async () => {
  const result = await getDownloads();
  return new Map((result.files || []).map((file) => [file.name, file.modified]));
};

const changedSince = (file, before, startedAt) => {
  if (!isSpotifyDownloadName(file?.name)) return false;
  const modifiedAt = Date.parse(file.modified || '');
  if (!Number.isFinite(modifiedAt) || modifiedAt < startedAt - 1000) return false;
  const previous = before.get(file.name);
  return !previous || file.modified !== previous;
};

async function findDownload(before = new Map(), startedAt = 0) {
  const result = await getDownloads();
  const files = (result.files || []).filter((file) => changedSince(file, before, startedAt));
  for (const file of files) {
    const resolved = await resolveDownload(file.name);
    if (!resolved) continue;
    const records = await readSpotifyRecords({
      path: resolved.absPath,
      originalname: resolved.name,
      mimetype: resolved.mime,
    }).catch(() => null);
    if (Array.isArray(records) && records.length > 0) return { file: resolved, records };
  }
  return null;
}

async function waitForDownload(before, startedAt, waitMs = DOWNLOAD_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = await findDownload(before, startedAt);
    if (found) return found;
    await sleep(DOWNLOAD_POLL_MS);
  }
  return findDownload(before, startedAt);
}

const resultForPage = (page, result) => ({
  ...result,
  pageId: page?.id,
  url: page?.url,
});

let importInFlight = null;

async function doImportSpotifyFromBrowser(providerId, model, { waitMs = DOWNLOAD_WAIT_MS } = {}) {
  const page = await ensureSpotifyPrivacyPage();
  const state = await inspectSpotifyPage(page);
  if (state.status !== 'ready') return state;

  const startedAt = Date.now();
  const before = await downloadSnapshot();
  const action = await evaluateOnPage(page, SPOTIFY_REQUEST_DOWNLOAD_EXPRESSION);

  // A direct browser download can close the CDP evaluation socket before it
  // returns its `{ clicked: true }` value. Keep watching the download directory
  // in that case instead of reporting a false action-required state.
  const downloadWaitMs = action?.clicked || action?.requestPending || action == null || state.requestPending ? waitMs : 0;
  const found = await waitForDownload(before, startedAt, downloadWaitMs);
  if (!found) {
    const pending = Boolean(action?.clicked || action?.requestPending || action == null || state.requestPending);
    return resultForPage(page, {
      status: pending ? 'pending' : 'action-required',
      message: pending
        ? 'Spotify is preparing or confirming the data package. Complete any confirmation/download step in the managed browser, then check again.'
        : 'Spotify privacy page is open. Select Extended Streaming History and start the download there, then check again.',
      downloadTriggered: Boolean(action?.clicked),
    });
  }

  const analysis = await analyzeImportedData(
    'spotify',
    JSON.stringify(found.records),
    providerId,
    model,
  ).finally(() => deleteDownload(found.file.name).catch((err) => {
    console.error(`⚠️ Spotify browser import cleanup failed: ${err?.message || String(err)}`);
  }));
  return resultForPage(page, {
    status: analysis.error ? 'error' : 'complete',
    ...analysis,
    downloaded: true,
  });
}

export async function importSpotifyFromBrowser(providerId, model, options = {}) {
  if (importInFlight) return importInFlight;
  importInFlight = doImportSpotifyFromBrowser(providerId, model, options).finally(() => {
    importInFlight = null;
  });
  return importInFlight;
}

