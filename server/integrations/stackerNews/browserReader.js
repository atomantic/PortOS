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
import { navigateToUrlPinned } from '../../services/browserService.js';
import { STACKER_NEWS_IDENTITY_EXPRESSION, stackerNewsBrowserOrigin as ORIGIN, verifyFinalOrigin } from '../../services/stackerNewsBrowser.js';

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

// Every expression returns `null` ONLY when extraction itself failed (no
// `#__NEXT_DATA__`, or Stacker News moved the server-rendered payload) so
// `readPage` can throw. A successful extraction that simply found no territory
// returns `{ sub: null }` — "nothing there" must never look like "we could not
// look", or a sync would clear `last_error` and advance `last_sync_at` after
// silently ingesting nothing.
const SUB_EXPRESSION = `(() => {
  const raw = document.querySelector('#__NEXT_DATA__')?.textContent;
  if (!raw) return null;
  const props = JSON.parse(raw)?.props?.pageProps;
  if (!props) return null;
  const sub = props.ssrData?.sub || props.sub;
  if (!sub || typeof sub.name !== 'string') return { sub: null };
  return {
    sub: {
      name: sub.name,
      userId: sub.userId == null ? null : String(sub.userId),
      baseCost: sub.baseCost ?? null,
      postsSatsFilter: sub.postsSatsFilter ?? null,
      replyCost: sub.replyCost ?? null,
      postTypes: Array.isArray(sub.postTypes) ? sub.postTypes.map((type) => String(type)) : [],
      status: sub.status == null ? null : String(sub.status),
      nsfw: Boolean(sub.nsfw),
    },
  };
})()`;

// Projects in-page so a 21-item SSR payload (each item carries nested sub, user,
// and comment trees) does not cross CDP whole. The server still re-normalizes
// the result below — this projection is a size guard, not the trust boundary.
const ITEMS_EXPRESSION = `(() => {
  const raw = document.querySelector('#__NEXT_DATA__')?.textContent;
  if (!raw) return null;
  const page = JSON.parse(raw)?.props?.pageProps?.ssrData?.items;
  // The /recent page always server-renders this list, so its absence means the
  // extraction failed rather than that the territory is empty.
  if (!page || !Array.isArray(page.items)) return null;
  const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  return {
    items: {
      cursor: typeof page.cursor === 'string' ? page.cursor.slice(0, ${MAX_CURSOR_LENGTH}) : null,
      items: page.items.slice(0, ${MAX_ITEMS_PER_PAGE}).map((item) => ({
        id: item?.id ?? null,
        createdAt: str(item?.createdAt, 64) || null,
        updatedAt: str(item?.updatedAt, 64) || null,
        title: str(item?.title, ${MAX_TITLE_LENGTH}),
        text: str(item?.text, ${MAX_TEXT_LENGTH}),
        url: str(item?.url, 2000),
        parentId: item?.parentId ?? null,
        user: { name: str(item?.user?.name, 120) },
        subName: str(item?.subName, 120),
      })),
    },
  };
})()`;

const comparablePath = (url) => new URL(url).pathname.replace(/\/+$/, '').toLowerCase();

// Origin alone is not enough for a read: Stacker News redirects a renamed or
// merged territory to a DIFFERENT same-origin territory, and the caller would
// then file that territory's settings, owner ID, and items under the configured
// slug. Refuse anything that did not land on the page we asked for.
const verifyFinalLocation = (requestedUrl, finalUrl) => {
  verifyFinalOrigin(finalUrl);
  if (comparablePath(requestedUrl) !== comparablePath(finalUrl)) {
    throw new Error('Stacker News browser navigation landed on a different page than the one requested');
  }
};

// Every read: pinned navigation, public-address check, location verification.
// Read tabs are scratch — a five-page sync would otherwise leave five tabs open
// in the user's browser per territory — and supplying `evaluateExpression` is
// what makes `navigateToUrlPinned` tear the tab down itself, on the throwing
// paths too. `page.id` therefore names a closed tab; do not reuse it.
async function readPage(url, evaluateExpression) {
  const page = await navigateToUrlPinned(url, {
    verifyRemoteIp: (ip) => !isPrivateAddress(ip),
    settleMs: SETTLE_MS,
    evaluateExpression,
  });
  verifyFinalLocation(url, page.url);
  // Anything but the envelope our own expression returns means the extractor
  // found no server-rendered payload, or `Runtime.evaluate` itself threw. Fail
  // loudly: a swallowed extraction failure would look like a clean empty sync
  // and quietly stop monitoring.
  if (!page.evalResult || typeof page.evalResult !== 'object') throw new Error('Could not read Stacker News data from the pinned browser page');
  return page.evalResult;
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
const normalizeItemsPage = (page, limit) => ({
  cursor: nullableString(page?.cursor, MAX_CURSOR_LENGTH),
  items: (Array.isArray(page?.items) ? page.items : [])
    .slice(0, Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_ITEMS_PER_PAGE) : MAX_ITEMS_PER_PAGE)
    .map((item) => ({
      // `boundedString` rejects anything that is not a string or finite number,
      // so an id of `true` / `{}` normalizes to '' and the item is dropped below
      // rather than ingested as "true" / "[object Object]".
      id: boundedString(item?.id, 200),
      createdAt: nullableString(item?.createdAt, 64),
      updatedAt: nullableString(item?.updatedAt, 64),
      title: boundedString(item?.title, MAX_TITLE_LENGTH),
      text: boundedString(item?.text, MAX_TEXT_LENGTH),
      url: boundedString(item?.url, 2_000),
      parentId: nullableString(item?.parentId, 200),
      user: { name: boundedString(item?.user?.name, 120) },
      subName: boundedString(item?.subName, 120),
    }))
    .filter((item) => item.id),
});

export async function readMe() {
  // Shares the handoff's identity extractor, so "Check browser identity" and a
  // keyless sync can never disagree about who is signed in.
  const identity = await readPage(ORIGIN, STACKER_NEWS_IDENTITY_EXPRESSION);
  const name = boundedString(identity?.username, 120);
  if (!name) throw new Error('The pinned browser is not signed in to Stacker News');
  return { me: { id: nullableString(identity.id, 200), name } };
}

export async function readSub(slug) {
  const { sub } = await readPage(slugPath(slug), SUB_EXPRESSION);
  const name = boundedString(sub?.name, 120);
  if (!name) return { sub: null };
  // The stored `userId` becomes this territory's ownership evidence, which gates
  // the territory-settings handoff — so a payload naming a different territory
  // is refused rather than filed under the requested slug.
  if (name.toLowerCase() !== slug.trim().toLowerCase()) {
    throw new Error(`Stacker News returned territory ~${name} for a different requested territory`);
  }
  return {
    sub: {
      name,
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

// `limit` mirrors the GraphQL transport's page bound so both transports ingest
// the same number of items per page, even though the SSR page size is fixed.
export async function readItems(slug, cursor = null, limit = null) {
  const { items } = await readPage(itemsUrl(slug, cursor), ITEMS_EXPRESSION);
  // A page without a list is an extraction failure, not an empty territory — an
  // empty territory arrives as `items: []`.
  if (!Array.isArray(items?.items)) throw new Error('Could not read Stacker News data from the pinned browser page');
  return { items: normalizeItemsPage(items, limit) };
}

const BROWSER_READS = Object.freeze({
  me: () => readMe(),
  sub: ({ name }) => readSub(name),
  items: ({ sub, cursor = null, limit = null }) => readItems(sub, cursor, limit),
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
