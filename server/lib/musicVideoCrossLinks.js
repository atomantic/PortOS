/**
 * Cross-links between a music video's release posts. Pure, shared by the
 * publish payloads (a new draft lists the posts already made) and the
 * Publish stage's "Backfill cross-links" card (which posts already up are
 * missing links to the ones made after them).
 *
 * A post record may carry `links`: the targets whose links it already shows.
 * Posts recorded before that field existed are read with what their draft
 * always linked (`LEGACY_LINKS`), counted only when that link existed first.
 */

/** Every post another post can link to, in the order a link list shows them. */
export const CROSS_LINK_LABELS = Object.freeze({
  suno: 'Song', youtube: 'Music video', x: 'X', tiktok: 'TikTok', instagram: 'Instagram',
  reddit: 'Reddit', stackerNews: 'Stacker News', substack: 'Substack', distrokid: 'Streaming',
});

/** Posts whose text can still take links after posting: an edit, or a reply/comment under it. */
export const CROSS_LINK_EDIT_TARGETS = Object.freeze(['youtube', 'suno', 'x', 'stackerNews']);

// What each draft linked before posts recorded their links.
const LEGACY_LINKS = { youtube: [], suno: ['youtube'], x: ['suno', 'youtube'], stackerNews: ['youtube'] };

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const kitOf = (kit) => (kit && typeof kit === 'object' ? kit : {});

/** The public link for `target`: its recorded post, else (song, full video) the link given the kit. */
export function releaseLinkUrl(kit, target, { songUrl } = {}) {
  const k = kitOf(kit);
  if (target === 'suno') return str(songUrl) || str(k.posts?.suno?.url) || str(k.links?.song);
  if (target === 'youtube') return str(k.posts?.youtube?.url) || str(k.links?.youtube);
  return str(k.posts?.[target]?.url);
}

/** Whether new drafts list the release's other posts (on unless the director turned it off). */
export const crossLinksEnabled = (kit) => kitOf(kit).crossLinks !== false;

/** `[{ target, label, url }]` for every linkable post except `exclude`. */
export function releaseLinks(kit, { exclude = [], songUrl } = {}) {
  return Object.keys(CROSS_LINK_LABELS)
    .filter((target) => !exclude.includes(target))
    .map((target) => ({ target, label: CROSS_LINK_LABELS[target], url: releaseLinkUrl(kit, target, { songUrl }) }))
    .filter((link) => link.url);
}

/**
 * Split `links` into the ones `text` already shows (`carried`) and the
 * `Label: url` lines still to add (`lines`, with their `targets`).
 */
export function crossLinkLines(links, text = '') {
  const carried = [];
  const added = [];
  for (const link of links) (String(text).includes(link.url) ? carried : added).push(link);
  return { carried: carried.map((l) => l.target), targets: added.map((l) => l.target), lines: added.map((l) => `${l.label}: ${l.url}`) };
}

/** The targets a posted record already links to. */
export function carriedLinks(kit, target) {
  const posts = kitOf(kit).posts || {};
  const post = posts[target];
  if (Array.isArray(post?.links)) return post.links;
  const at = post?.postedAt || '';
  return (LEGACY_LINKS[target] || []).filter((other) => {
    const earlier = posts[other];
    if (earlier) return !!earlier.postedAt && earlier.postedAt <= at;
    // A link given the kit by hand (song, full video) was there from the start.
    return !!releaseLinkUrl(kit, other);
  });
}

/**
 * Per posted, still-editable platform: the links it lacks and the text that
 * adds them (`Label: url` lines). `[{ target, url, missing, text }]`.
 */
export function crossLinkBackfill(kit) {
  const posts = kitOf(kit).posts || {};
  return CROSS_LINK_EDIT_TARGETS.filter((target) => str(posts[target]?.url)).map((target) => {
    const exclude = [target, ...carriedLinks(kit, target)];
    const missing = releaseLinks(kit, { exclude });
    return { target, url: str(posts[target].url), missing, text: missing.map((l) => `${l.label}: ${l.url}`).join('\n') };
  });
}

/** `existing` links plus `added`, known targets only, without repeats. */
export function mergeCarriedLinks(existing, added) {
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(added) ? added : [])];
  return [...new Set(all.filter((t) => Object.hasOwn(CROSS_LINK_LABELS, t)))];
}

/**
 * `posts` with `target` struck from every other post's carried links: those
 * posts show the old URL (or a removed post), not whatever `target` becomes.
 * Posts reading their links from the legacy defaults are given an explicit list.
 * `kit` is the kit as it was before the change.
 */
export function dropCarriedLink(kit, posts, target) {
  const out = { ...posts };
  for (const [other, post] of Object.entries(posts)) {
    if (other === target || !post || typeof post !== 'object') continue;
    const carried = carriedLinks(kit, other);
    if (carried.includes(target)) out[other] = { ...post, links: carried.filter((t) => t !== target) };
  }
  return out;
}
