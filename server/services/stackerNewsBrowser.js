import { isPrivateAddress } from '../lib/safeUrlFetch.js';
import { navigateToUrlPinned } from './browserService.js';

const ORIGIN = 'https://stacker.news';
// The ONE signed-in-identity extractor. Both the handoff identity check and the
// browser read transport (integrations/stackerNews/browserReader.js) run it, so
// they can never disagree about who the pinned browser is signed in as. `id` is
// null on the profile-link fallback — ownership verification then fails closed
// rather than matching a territory owner it could not confirm.
export const STACKER_NEWS_IDENTITY_EXPRESSION = `(() => {
  const data = document.querySelector('#__NEXT_DATA__')?.textContent;
  if (data) {
    const parsed = JSON.parse(data);
    const me = parsed?.props?.pageProps?.me || parsed?.props?.me;
    if (typeof me?.name === 'string') return { username: me.name, id: me.id == null ? null : String(me.id) };
  }
  const link = [...document.querySelectorAll('a[href]')].find((node) => {
    const href = node.getAttribute('href') || '';
    return node.getAttribute('aria-label')?.toLowerCase().includes('profile') && /^\\\/[a-zA-Z0-9_-]+$/.test(href);
  });
  return { username: link ? link.getAttribute('href').slice(1) : null, id: null };
})()`;

const fixedUrl = (kind, value) => {
  if (kind === 'item') return `${ORIGIN}/items/${encodeURIComponent(String(value))}`;
  if (kind === 'territory_settings') return `${ORIGIN}/~${encodeURIComponent(String(value))}/edit`;
  throw new Error('Unsupported Stacker News browser destination');
};

// Exported so every Stacker News browser path (handoffs AND the read transport
// in integrations/stackerNews/browserReader.js) fails closed on the same check —
// a redirect that leaves the fixed origin must never be treated as SN data.
export const verifyFinalOrigin = (url) => {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN) throw new Error('Stacker News browser navigation left the fixed origin');
};

export async function getStackerNewsBrowserIdentity() {
  const page = await navigateToUrlPinned(ORIGIN, {
    verifyRemoteIp: (ip) => !isPrivateAddress(ip),
    settleMs: 1_000,
    evaluateExpression: STACKER_NEWS_IDENTITY_EXPRESSION,
  });
  // The identity tab is scratch, like the read transport's (browserReader.js):
  // supplying `evaluateExpression` means `navigateToUrlPinned` already read it
  // and tore it down. Only a handoff (below, no expression) leaves a tab for the
  // user — otherwise every "Check browser identity" click, and every handoff,
  // which checks identity first, would pile another stacker.news tab into their
  // browser. `page.id` names a closed tab here; do not reuse it.
  verifyFinalOrigin(page.url);
  return { username: page.evalResult?.username || null, url: page.url };
}

export async function openStackerNewsHandoff({ kind, value, expectedUsername }) {
  const identity = await getStackerNewsBrowserIdentity();
  if (!identity.username) throw new Error('Could not verify the signed-in Stacker News browser identity');
  if (identity.username.toLowerCase() !== expectedUsername.toLowerCase()) throw new Error(`Pinned browser is signed in as @${identity.username}, not the selected account`);
  const target = fixedUrl(kind, value);
  const page = await navigateToUrlPinned(target, {
    verifyRemoteIp: (ip) => !isPrivateAddress(ip),
    settleMs: 500,
  });
  verifyFinalOrigin(page.url);
  return { username: identity.username, pageId: page.id, url: page.url };
}

export const stackerNewsBrowserOrigin = ORIGIN;
