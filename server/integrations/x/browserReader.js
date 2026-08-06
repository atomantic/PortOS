// Read-only X transport over the managed browser. The browser expression is a
// closed DOM projection: it does not accept selectors, scripts, or URLs from a
// caller, and its result is normalized again before it reaches the database.
import { isPrivateAddress } from '../../lib/safeUrlFetch.js';
import { navigateToUrlPinned } from '../../services/browserService.js';
import { fixedXUrl, verifyFinalXPath } from '../../services/xBrowser.js';

const SETTLE_MS = 1_500;
const MAX_POSTS = 100;
const MAX_BODY_LENGTH = 40_000;
const MAX_BIO_LENGTH = 2_000;
const MAX_INTEGER = 2_147_483_647;
const X_STATUS_URL = /^https:\/\/x\.com\/(?:(?:[A-Za-z0-9_]{1,15}|i)\/)?status\/\d+$/;

const POST_HELPERS = String.raw`
  const parseCount = (value) => {
    const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)(?:\s*([KMB]))?/i);
    if (!match) return null;
    const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[String(match[2] || '').toUpperCase()] || 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const labelledCount = (article, pattern) => {
    const node = [...article.querySelectorAll('button, a')].find((candidate) => pattern.test(candidate.getAttribute('aria-label') || ''));
    return parseCount(node?.getAttribute('aria-label') || '0') || 0;
  };
  const postRows = () => [...document.querySelectorAll('article')].map((article) => {
    const statusLink = [...article.querySelectorAll('a[href]')].find((node) => /\/status\/\d+/.test(node.getAttribute('href') || ''));
    const analyticsLink = [...article.querySelectorAll('a[href]')].find((node) => /\/analytics$/.test(node.getAttribute('href') || ''));
    const handleLink = [...article.querySelectorAll('a[href]')].find((node) => /^@[A-Za-z0-9_]{1,15}$/.test((node.textContent || '').trim()));
    const time = article.querySelector('time');
    const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')].map((node) => node.innerText || '').filter(Boolean);
    const body = (textNodes.length ? textNodes.join('\n') : article.innerText || '').slice(0, ${MAX_BODY_LENGTH});
    const analyticsLabel = analyticsLink?.getAttribute('aria-label') || analyticsLink?.textContent || '';
    return {
      remoteId: statusLink?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] || '',
      sourceUrl: statusLink ? new URL(statusLink.getAttribute('href'), location.origin).href : '',
      authorHandle: (handleLink?.textContent || '').trim().replace(/^@/, ''),
      body,
      kind: /Replying to/i.test(article.innerText || '') ? 'reply' : 'post',
      remoteCreatedAt: time?.getAttribute('datetime') || null,
      impressions: parseCount(analyticsLabel),
      replies: labelledCount(article, /Replies?\. Reply/i),
      reposts: labelledCount(article, /reposts?\. Repost/i),
      likes: labelledCount(article, /Likes?\. Like/i),
      bookmarks: labelledCount(article, /Bookmarks?\. Bookmark/i),
    };
  }).filter((post) => post.remoteId);
`;

export const PROFILE_EXPRESSION = `(() => {
  ${POST_HELPERS}
  const pageText = document.body.innerText || '';
  const links = [...document.querySelectorAll('a[href]')];
  const handleLink = links.find((node) => /^@[A-Za-z0-9_]{1,15}$/.test((node.textContent || '').trim()));
  const followerLink = links.find((node) => /\/(?:followers|verified_followers)$/.test(node.getAttribute('href') || ''));
  const followingLink = links.find((node) => /\/following$/.test(node.getAttribute('href') || ''));
  const parseProfileCount = (value) => {
    const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)(?:\s*([KMB]))?/i);
    if (!match) return null;
    const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[String(match[2] || '').toUpperCase()] || 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const heading = [...document.querySelectorAll('main h2')].map((node) => (node.innerText || '').trim()).find((value) => value && !/posts?$/i.test(value));
  return {
    profile: {
      displayName: (heading || '').replace(/\s+Verified account$/i, '').trim(),
      username: (handleLink?.textContent || '').trim().replace(/^@/, ''),
      bio: (document.querySelector('[data-testid="UserDescription"]')?.innerText || '').slice(0, ${MAX_BIO_LENGTH}),
      followers: parseProfileCount(followerLink?.textContent),
      following: parseProfileCount(followingLink?.textContent),
      postCount: parseProfileCount(pageText.match(/([\d,.]+)\s+posts?/i)?.[1]),
      url: location.href,
    },
    posts: postRows(),
  };
})()`;

export const SEARCH_EXPRESSION = `(() => {
  ${POST_HELPERS}
  return { posts: postRows(), url: location.href };
})()`;

export const PEOPLE_EXPRESSION = `(() => ({
  handles: [...document.querySelectorAll('a[href]')]
    .map((node) => (node.textContent || '').trim().match(/^@([A-Za-z0-9_]{1,15})$/i)?.[1] || '')
    .filter(Boolean)
    .slice(0, 200),
  url: location.href,
}))()`;

const boundedString = (value, max) => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : '';
const nullableCount = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_INTEGER ? value : null;
const normalizedHandle = (value) => boundedString(value, 15).replace(/^@/, '').toLowerCase();

const normalizePost = (post) => {
  const remoteId = boundedString(post?.remoteId, 80);
  if (!remoteId || !/^\d+$/.test(remoteId)) return null;
  const sourceUrl = boundedString(post?.sourceUrl, 2_000);
  const safeUrl = X_STATUS_URL.test(sourceUrl) ? sourceUrl : '';
  const replies = nullableCount(post?.replies) ?? 0;
  const reposts = nullableCount(post?.reposts) ?? 0;
  const likes = nullableCount(post?.likes) ?? 0;
  const bookmarks = nullableCount(post?.bookmarks) ?? 0;
  return {
    remoteId,
    kind: post?.kind === 'reply' ? 'reply' : 'post',
    body: boundedString(post?.body, MAX_BODY_LENGTH),
    sourceUrl: safeUrl,
    authorHandle: normalizedHandle(post?.authorHandle),
    remoteCreatedAt: typeof post?.remoteCreatedAt === 'string' ? post.remoteCreatedAt.slice(0, 64) : null,
    impressions: nullableCount(post?.impressions),
    engagements: nullableCount(replies + reposts + likes + bookmarks),
    replies,
    reposts,
    likes,
    bookmarks,
  };
};

const normalizePosts = (posts) => [...new Map((Array.isArray(posts) ? posts : [])
  .map(normalizePost)
  .filter(Boolean)
  .map((post) => [post.remoteId, post])).values()].slice(0, MAX_POSTS);

async function readPage(url, expression, expectedPath) {
  const page = await navigateToUrlPinned(url, {
    verifyRemoteIp: (ip) => !isPrivateAddress(ip),
    settleMs: SETTLE_MS,
    evaluateExpression: expression,
  });
  verifyFinalXPath(url, page.url);
  if (!page.evalResult || typeof page.evalResult !== 'object') throw new Error('Could not read X data from the managed browser');
  const landedPath = new URL(page.url).pathname.replace(/\/+$/, '').toLowerCase();
  if (expectedPath && landedPath !== expectedPath.replace(/\/+$/, '').toLowerCase()) throw new Error('X returned an unexpected page');
  return page.evalResult;
}

export async function readProfile(username) {
  const requested = username.trim();
  const result = await readPage(fixedXUrl('profile', requested), PROFILE_EXPRESSION, `/${requested}`);
  const profile = result.profile || {};
  const posts = normalizePosts(result.posts);
  return {
    profile: {
      displayName: boundedString(profile.displayName, 200),
      username: normalizedHandle(profile.username),
      bio: boundedString(profile.bio, MAX_BIO_LENGTH),
      followers: nullableCount(profile.followers),
      following: nullableCount(profile.following),
      postCount: nullableCount(profile.postCount),
      url: fixedXUrl('profile', requested),
    },
    posts,
  };
}

export async function readLatest(username) {
  const result = await readPage(fixedXUrl('latest', username), SEARCH_EXPRESSION, '/search');
  return { posts: normalizePosts(result.posts) };
}

export async function readPeople(username) {
  const result = await readPage(fixedXUrl('people', username), PEOPLE_EXPRESSION, '/search');
  const handles = [...new Set((Array.isArray(result.handles) ? result.handles : []).map(normalizedHandle).filter(Boolean))];
  return { handles, exactMatch: handles.includes(username.trim().toLowerCase()) };
}

const BROWSER_READS = Object.freeze({
  profile: ({ username }) => readProfile(username),
  latest: ({ username }) => readLatest(username),
  people: ({ username }) => readPeople(username),
});

export async function executeXBrowserRead(name, input = {}) {
  const read = BROWSER_READS[name];
  if (!read) throw new Error(`Unsupported X browser read: ${name}`);
  return read(input);
}

export const xBrowserReads = Object.freeze(Object.keys(BROWSER_READS));
