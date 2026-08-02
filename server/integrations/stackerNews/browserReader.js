// Stacker News read transport over the signed-in pinned browser.
//
// Stacker News API keys are not self-serve — the SN team grants them on request
// — so a key-gated read path leaves a normal user unable to sync at all. Every
// field the three named GraphQL reads select is already server-rendered into the
// page's `#__NEXT_DATA__`, so a pinned, origin-verified navigation can produce
// the same data with no key.
//
// Same closed-registry discipline as the GraphQL client: callers name an
// operation and supply a slug/cursor. They never supply a URL, selector, or
// script. URLs are built here from a fixed origin and template; the evaluate
// expressions are module constants with no interpolation.
//
// The returned shapes deliberately mirror `executeStackerNewsOperation`'s so a
// browser-sourced item is indistinguishable downstream from an API-sourced one:
// same hashing, same `inspectUntrustedContent` treatment, same columns.
import { isPrivateAddress } from '../../lib/safeUrlFetch.js';
import { closeCdpPage, navigateToUrlPinned } from '../../services/browserService.js';
import { stackerNewsBrowserOrigin as ORIGIN, verifyFinalOrigin } from '../../services/stackerNewsBrowser.js';

const SETTLE_MS = 1_500;
const MAX_ITEMS_PER_PAGE = 100;
const MAX_CURSOR_LENGTH = 400;
const MAX_TEXT_LENGTH = 40_000;
const MAX_TITLE_LENGTH = 2_000;

const slugPath = (slug) => {
  if (typeof slug !== 'string' || !slug.trim() || !/^[a-zA-Z0-9_-]{1,120}$/.test(slug.trim())) {
    throw new Error('Invalid Stacker News territory name');
  }
  return `${ORIGIN}/~${encodeURIComponent(slug.trim())}/recent`;
};

const itemsUrl = (slug, cursor) => {
  const url = new URL(slugPath(slug));
  if (cursor != null) {
    if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH) throw new Error('Invalid Stacker News cursor');
    // Stacker News' SSR merges the query string into the page's GraphQL
    // variables, so this is how the second and later pages are requested
    // without a client-side "more" click.
    url.searchParams.set('cursor', cursor);
  }
  return url.toString();
};

const ME_EXPRESSION = `(() => {
  const raw = document.querySelector('#__NEXT_DATA__')?.textContent;
  if (!raw) return null;
  const props = JSON.parse(raw)?.props;
  const me = props?.pageProps?.me || props?.me;
  if (!me || typeof me.name !== 'string') return null;
  return { id: me.id == null ? null : String(me.id), name: me.name };
})()`;

const SUB_EXPRESSION = `(() => {
  const raw = document.querySelector('#__NEXT_DATA__')?.textContent;
  if (!raw) return null;
  const props = JSON.parse(raw)?.props?.pageProps;
  const sub = props?.ssrData?.sub || props?.sub;
  if (!sub || typeof sub.name !== 'string') return null;
  return {
    name: sub.name,
    userId: sub.userId == null ? null : String(sub.userId),
    baseCost: sub.baseCost ?? null,
    postsSatsFilter: sub.postsSatsFilter ?? null,
    replyCost: sub.replyCost ?? null,
    postTypes: Array.isArray(sub.postTypes) ? sub.postTypes.map((type) => String(type)) : [],
    status: sub.status == null ? null : String(sub.status),
    nsfw: Boolean(sub.nsfw),
  };
})()`;

// Projects in-page so a 21-item SSR payload (each item carries nested sub, user,
// and comment trees) does not cross CDP whole. The server still re-normalizes
// the result below — this projection is a size guard, not the trust boundary.
const ITEMS_EXPRESSION = `(() => {
  const raw = document.querySelector('#__NEXT_DATA__')?.textContent;
  if (!raw) return null;
  const page = JSON.parse(raw)?.props?.pageProps?.ssrData?.items;
  if (!page) return null;
  const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  return {
    cursor: typeof page.cursor === 'string' ? page.cursor.slice(0, ${MAX_CURSOR_LENGTH}) : null,
    items: (Array.isArray(page.items) ? page.items : []).slice(0, ${MAX_ITEMS_PER_PAGE}).map((item) => ({
      id: item?.id == null ? null : String(item.id),
      createdAt: str(item?.createdAt, 64) || null,
      updatedAt: str(item?.updatedAt, 64) || null,
      title: str(item?.title, ${MAX_TITLE_LENGTH}),
      text: str(item?.text, ${MAX_TEXT_LENGTH}),
      url: str(item?.url, 2000),
      parentId: item?.parentId == null ? null : String(item.parentId),
      user: { name: str(item?.user?.name, 120) },
      subName: str(item?.subName, 120),
    })),
  };
})()`;

// Every read: pinned navigation, public-address check, origin verification, then
// tear the tab down. Read tabs are scratch — a five-page sync would otherwise
// leave five tabs open in the user's browser per territory.
async function readPage(url, evaluateExpression) {
  const page = await navigateToUrlPinned(url, {
    verifyRemoteIp: (ip) => !isPrivateAddress(ip),
    settleMs: SETTLE_MS,
    evaluateExpression,
  });
  const originError = await Promise.resolve(page.url).then(verifyFinalOrigin).then(() => null, (error) => error);
  await closeCdpPage(page.id);
  if (originError) throw originError;
  return page.evalResult ?? null;
}

// Numbers are accepted and stringified because Stacker News serves numeric IDs
// (item, user, territory owner) and the API transport already stringifies them
// — anything else (object, boolean, null) collapses to absent.
const boundedString = (value, max) => {
  if (typeof value === 'string') return value.slice(0, max);
  return typeof value === 'number' && Number.isFinite(value) ? String(value).slice(0, max) : '';
};
const nullableString = (value, max) => {
  const text = boundedString(value, max);
  return text || null;
};

// Re-normalizes what the page returned. The evaluate expression runs inside an
// untrusted document, so its output is treated as remote data, not as a trusted
// projection — the shape below is what the rest of PortOS is allowed to see.
const normalizeItemsPage = (page) => ({
  cursor: nullableString(page?.cursor, MAX_CURSOR_LENGTH),
  items: (Array.isArray(page?.items) ? page.items : [])
    .slice(0, MAX_ITEMS_PER_PAGE)
    .filter((item) => item?.id != null && String(item.id).length)
    .map((item) => ({
      id: boundedString(String(item.id), 200),
      createdAt: nullableString(item.createdAt, 64),
      updatedAt: nullableString(item.updatedAt, 64),
      title: boundedString(item.title, MAX_TITLE_LENGTH),
      text: boundedString(item.text, MAX_TEXT_LENGTH),
      url: boundedString(item.url, 2_000),
      parentId: nullableString(item.parentId, 200),
      user: { name: boundedString(item.user?.name, 120) },
      subName: boundedString(item.subName, 120),
    })),
});

export async function readMe() {
  const me = await readPage(ORIGIN, ME_EXPRESSION);
  if (!me?.name) throw new Error('The pinned browser is not signed in to Stacker News');
  return { me: { id: nullableString(me.id, 200), name: boundedString(me.name, 120) } };
}

export async function readSub(slug) {
  const sub = await readPage(slugPath(slug), SUB_EXPRESSION);
  if (!sub?.name) return { sub: null };
  return {
    sub: {
      name: boundedString(sub.name, 120),
      userId: nullableString(sub.userId, 200),
      baseCost: Number.isFinite(sub.baseCost) ? sub.baseCost : null,
      postsSatsFilter: Number.isFinite(sub.postsSatsFilter) ? sub.postsSatsFilter : null,
      replyCost: Number.isFinite(sub.replyCost) ? sub.replyCost : null,
      postTypes: (Array.isArray(sub.postTypes) ? sub.postTypes : []).slice(0, 20).map((type) => boundedString(type, 40)),
      status: nullableString(sub.status, 40),
      nsfw: Boolean(sub.nsfw),
    },
  };
}

export async function readItems(slug, cursor = null) {
  const page = await readPage(itemsUrl(slug, cursor), ITEMS_EXPRESSION);
  return { items: normalizeItemsPage(page) };
}

const BROWSER_READS = Object.freeze({
  me: () => readMe(),
  sub: ({ name }) => readSub(name),
  items: ({ sub, cursor = null }) => readItems(sub, cursor),
});

/**
 * Transport-shaped sibling of `executeStackerNewsOperation` so callers can pick
 * a transport without branching per operation. Same operation names, same
 * inputs, same returned envelope.
 */
export async function executeStackerNewsBrowserRead(name, input = {}) {
  const read = BROWSER_READS[name];
  if (!read) throw new Error(`Unsupported Stacker News browser read: ${name}`);
  return read(input);
}

export const stackerNewsBrowserReads = Object.freeze(Object.keys(BROWSER_READS));
