/**
 * Music Video publishing (#9287): WHERE the director posts, and what they
 * learned from posting there.
 *
 * Every platform is opt-in (`settings.musicVideoPublishing.platforms[target]
 * = { enabled, account }`), off until the director turns it on, so the Publish
 * stage never offers to post everywhere. `account` optionally names the
 * handle they post as; adapters that can read the signed-in account refuse a
 * mismatch. Each post they make (or record by hand) can carry a reception
 * rating and notes; `publishHistory` rolls those up across every project so
 * the director, and the copy prompt, can see what landed.
 */
import { MUSIC_VIDEO_PUBLISH_TARGETS } from '../../../lib/musicVideoValidation.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { getSettings, updateSettingsWith } from '../../settings.js';
import { listProjects } from '../projects.js';

const SETTINGS_KEY = 'musicVideoPublishing';
const RECEPTIONS = ['good', 'mixed', 'poor'];
const RECENT_NOTES = 5;

const cleanAccount = (v) => (typeof v === 'string' ? v.trim().replace(/^@/, '').slice(0, 100) : '') || null;

/** Every target's `{ enabled, account }`, defaulting to off. */
function normalizePlatforms(stored) {
  const source = stored && typeof stored === 'object' ? stored : {};
  return Object.fromEntries(MUSIC_VIDEO_PUBLISH_TARGETS.map((target) => {
    const entry = source[target] && typeof source[target] === 'object' ? source[target] : {};
    return [target, { enabled: entry.enabled === true, account: cleanAccount(entry.account) }];
  }));
}

export async function getPublishPlatforms() {
  const settings = await getSettings().catch(() => ({}));
  return normalizePlatforms(settings?.[SETTINGS_KEY]?.platforms);
}

/** Merge `{ [target]: { enabled?, account? } }` into the saved platforms; resolves the full set. */
export async function updatePublishPlatforms(patch = {}) {
  let next = null;
  await updateSettingsWith((current) => {
    const section = current?.[SETTINGS_KEY] && typeof current[SETTINGS_KEY] === 'object' ? current[SETTINGS_KEY] : {};
    const platforms = normalizePlatforms(section.platforms);
    for (const [target, change] of Object.entries(patch || {})) {
      if (!platforms[target] || !change || typeof change !== 'object') continue;
      if (typeof change.enabled === 'boolean') platforms[target].enabled = change.enabled;
      if ('account' in change) platforms[target].account = cleanAccount(change.account);
    }
    next = platforms;
    return { ...current, [SETTINGS_KEY]: { ...section, platforms } };
  });
  return next;
}

/** Refuse a platform the director has not turned on. */
export function assertPlatformEnabled(platforms, target) {
  if (!platforms?.[target]?.enabled) {
    throw new ServerError(`${target} is not one of your publishing platforms — turn it on under "Where you post" first`, { status: 409, code: 'PUBLISH_PLATFORM_DISABLED', context: { target } });
  }
}

/** Refuse a draft filled while signed in as someone other than the configured account. */
export function assertAccount(platforms, target, detected) {
  const want = platforms?.[target]?.account;
  const have = cleanAccount(detected);
  if (want && have && want.toLowerCase() !== have.toLowerCase()) {
    throw new ServerError(`The PortOS Browser is signed in to ${target} as @${have}, not @${want} — switch accounts and fill again`, {
      status: 409, code: 'PUBLISH_WRONG_ACCOUNT', context: { target, expected: want, signedInAs: have },
    });
  }
}

/** A post record with only the known fields, or null when `input` names nothing. */
export function normalizePost(existing = {}, input = {}) {
  const post = { ...(existing && typeof existing === 'object' ? existing : {}) };
  if ('url' in input) post.url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null;
  if ('reception' in input) post.reception = RECEPTIONS.includes(input.reception) ? input.reception : null;
  if ('notes' in input) post.notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 2000) : null;
  if (!post.postedAt && (post.url || input.posted === true)) post.postedAt = new Date().toISOString();
  if ('reception' in input || 'notes' in input) post.ratedAt = new Date().toISOString();
  return post;
}

/**
 * Per platform, across every project: how many posts, how they were received,
 * and the most recent notes (newest first). Pure over `projects`.
 */
function summarizePublishHistory(projects = []) {
  const history = Object.fromEntries(MUSIC_VIDEO_PUBLISH_TARGETS.map((t) => [t, { posts: 0, good: 0, mixed: 0, poor: 0, notes: [] }]));
  for (const project of projects) {
    const posts = project?.publishKit?.posts;
    if (!posts || typeof posts !== 'object') continue;
    for (const [target, post] of Object.entries(posts)) {
      const h = history[target];
      if (!h || !post || typeof post !== 'object') continue;
      h.posts += 1;
      if (RECEPTIONS.includes(post.reception)) h[post.reception] += 1;
      if (post.notes || post.reception) h.notes.push({ project: project.name || 'Untitled', reception: post.reception || null, notes: post.notes || '', at: post.ratedAt || post.postedAt || null });
    }
  }
  for (const h of Object.values(history)) {
    h.notes.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    h.notes = h.notes.slice(0, RECENT_NOTES);
  }
  return history;
}

/** Post history per platform across every project (or across `projects` when given). */
export async function publishHistory(projects = null) {
  return summarizePublishHistory(projects || await listProjects().catch(() => []));
}
