import { isPrivateAddress } from '../lib/safeUrlFetch.js';
import { closeCdpPage, navigateToUrlPinned } from './browserService.js';

const ORIGIN = 'https://x.com';
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

const assertUsername = (username) => {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim())) {
    throw new Error('Invalid X username');
  }
  return username.trim();
};

export const xBrowserOrigin = ORIGIN;

export const fixedXUrl = (kind, value = '') => {
  if (kind === 'profile') return `${ORIGIN}/${encodeURIComponent(assertUsername(value))}`;
  if (kind === 'latest') {
    const url = new URL(`${ORIGIN}/search`);
    url.searchParams.set('q', `from:${assertUsername(value)} -filter:replies`);
    url.searchParams.set('src', 'typed_query');
    url.searchParams.set('f', 'live');
    return url.toString();
  }
  if (kind === 'people') {
    const url = new URL(`${ORIGIN}/search`);
    url.searchParams.set('q', assertUsername(value));
    url.searchParams.set('src', 'typed_query');
    url.searchParams.set('f', 'user');
    return url.toString();
  }
  if (kind === 'settings') return `${ORIGIN}/settings/account`;
  if (kind === 'compose') {
    const url = new URL(`${ORIGIN}/compose/post`);
    url.searchParams.set('text', String(value).slice(0, 4_000));
    return url.toString();
  }
  throw new Error('Unsupported X browser destination');
};

export const verifyFinalXOrigin = (url) => {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN) throw new Error('X browser navigation left the fixed origin');
};

export const verifyFinalXPath = (requestedUrl, finalUrl) => {
  verifyFinalXOrigin(finalUrl);
  const requested = new URL(requestedUrl);
  const final = new URL(finalUrl);
  if (requested.pathname.replace(/\/+$/, '').toLowerCase() !== final.pathname.replace(/\/+$/, '').toLowerCase()) {
    throw new Error('X browser navigation landed on a different page than the one requested');
  }
};

export async function openXHandoff({ kind, value = '' }) {
  const target = fixedXUrl(kind, value);
  const page = await navigateToUrlPinned(target, {
    verifyRemoteIp: (ip) => !isPrivateAddress(ip),
    settleMs: 500,
    closeAfterRead: false,
  });
  // `closeAfterRead: false` means THIS function owns the tab from here on. If
  // the final-path check rejects the landing page (an X redirect, a login wall),
  // nobody downstream ever learns the page id — so close it here before the
  // throw bubbles, or every failed handoff leaks a Chrome tab. try/finally, not
  // try/catch: the verification error still bubbles to the error middleware.
  let verified = false;
  try {
    verifyFinalXPath(target, page.url);
    verified = true;
  } finally {
    if (!verified) {
      await closeCdpPage(page.id).catch((err) => {
        console.error(`❌ Failed to close redirected X handoff tab ${page.id}: ${err.message}`);
      });
    }
  }
  return { pageId: page.id, url: page.url };
}
