/**
 * Prepare external platform drafts for manual review and publication.
 * Draft preparation requires an existing authenticated session, including agents.
 * PortOS never submits a draft; the operator publishes in the destination
 * platform. Where a platform lands the filled tab on the new post's own page,
 * PortOS records that link itself; otherwise the operator pastes it. Adapter
 * preparation runs in a serialized, dedicated browser tab. Existing drafts can
 * be discarded or replaced.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { ServerError } from '../../../lib/errorHandler.js';
import { PATHS, ensureDir } from '../../../lib/fileUtils.js';
import { safeUnder } from '../../../lib/ffmpeg.js';
import { getProject, mutateProjectRecord } from '../projects.js';
import { buildPublishPayload, publishPreviewParts, publishSongUrl } from './payloads.js';
import { canonicalizeSunoUrl, isSunoShareLink } from '../../sunoShareLink.js';
import { connectPortosBrowser, serializeBrowserOperation as serialize } from './browser.js';
import { assertAccount, assertPlatformEnabled, getPublishPlatforms, normalizePost } from './platforms.js';
import { youtubeAdapter, shortsAdapter } from './youtube.js';
import { tiktokAdapter } from './tiktok.js';
import { instagramAdapter } from './instagram.js';
import { xAdapter } from './x.js';
import { linkedinAdapter } from './linkedin.js';
import { redditAdapter } from './reddit.js';
import { stackerNewsAdapter } from './stackerNews.js';
import { substackAdapter } from './substack.js';
import { sunoAdapter } from './suno.js';
import { sunoHookAdapter } from './sunoHook.js';
import { distrokidAdapter } from './distrokid.js';
import { musicVideoEvents } from '../events.js';
import { CROSS_LINK_ADAPTERS } from './crossLinkEdits.js';
import { carriedLinks, crossLinkBackfill, mergeCarriedLinks } from '../../../lib/musicVideoCrossLinks.js';

export const PUBLISH_ADAPTERS = Object.freeze({
  youtube: youtubeAdapter, shorts: shortsAdapter, tiktok: tiktokAdapter, instagram: instagramAdapter,
  x: xAdapter, linkedin: linkedinAdapter, reddit: redditAdapter, stackerNews: stackerNewsAdapter, substack: substackAdapter, suno: sunoAdapter, sunoHook: sunoHookAdapter, distrokid: distrokidAdapter,
});
// The tab stays open past this: the human publishes from it. After the TTL only
// the CDP session is dropped; the tab closes on Discard, Fill again, or by hand.
const DRAFT_DETACH_MS = 30 * 60 * 1000;
const drafts = new Map();

const draftPresentation = (draft) => ({
  draftId: draft.id, projectId: draft.projectId, target: draft.target, summary: draft.summary,
  screenshot: draft.screenshot, state: draft.state, createdAt: draft.createdAt, manualPublication: true,
  // The song page a Suno share link resolved to, so the form can show it.
  songUrl: draft.payload?.songUrl ?? null,
});
const emitDraft = (draft, state = draft.state) => musicVideoEvents.emit('publish-draft', {
  projectId: draft.projectId, draftId: draft.id, target: draft.target, state,
});

/** Drop the CDP session only (the PortOS Browser and the tab keep running). */
async function detachDraft(draft) {
  clearTimeout(draft.timer);
  const { browser, page } = draft;
  if (page && !page.isClosed()) draft.url = page.url(); // the tab may have moved on while the human worked
  draft.browser = null;
  draft.page = null;
  await browser?.close().catch(() => {});
}

/** Whether the draft's tab is still open, reconnecting (never launching) when the session was dropped. */
async function findDraftPage(draft, deps = {}) {
  if (draft.page) return draft.page.isClosed() ? null : draft.page;
  let session;
  try { session = await (deps.connect || connectPortosBrowser)({ launch: false }); } catch { return null; }
  const page = session.context.pages().find((candidate) => candidate.url() === draft.url) || null;
  draft.reconnect = session;
  return page;
}

/** Re-check a detached draft's tab; mark it closed (and tell the UI) when it is gone. */
async function refreshDraft(draft, deps) {
  if (draft.state === 'closed') return;
  const page = await findDraftPage(draft, deps);
  const session = draft.reconnect;
  draft.reconnect = null;
  await session?.browser.close().catch(() => {});
  if (!page) { draft.state = 'closed'; emitDraft(draft); }
}

async function closeDraft(draft, deps) {
  drafts.delete(draft.id);
  clearTimeout(draft.timer);
  const page = await findDraftPage(draft, deps);
  await page?.close().catch(() => {});
  const session = draft.reconnect || { browser: draft.browser };
  draft.reconnect = null;
  await session.browser?.close().catch(() => {}); // disconnects; the PortOS Browser keeps running
  emitDraft(draft, 'discarded');
}

/**
 * Record the post the director just made by hand in a filled tab, and let the
 * tab go: it now shows their post, so it stays open with no session attached.
 */
async function recordDetectedPost(draft, url) {
  if (!drafts.has(draft.id)) return;
  drafts.delete(draft.id);
  draft.state = 'posted';
  // A record that fails to save leaves the draft as it was: the card keeps it, and the link can still be pasted.
  const { project } = await recordPublishPost(draft.projectId, draft.target, { url, links: draft.payload?.crossLinks }).catch((err) => {
    draft.state = 'open';
    drafts.set(draft.id, draft);
    throw err;
  });
  await detachDraft(draft);
  musicVideoEvents.emit('publish-draft', { projectId: draft.projectId, draftId: draft.id, target: draft.target, state: 'posted', url, project });
  console.log(`🔗 ${draft.target} post recorded for music-video ${draft.projectId.slice(0, 8)}: ${url}`);
}

/**
 * Follow a filled tab while its session is attached: each time it navigates,
 * the adapter's `findPost` says whether it now shows the director's new post
 * (by URL and title). PortOS presses nothing: at most it types a first comment for the director to send (LinkedIn).
 */
function watchForPost(draft, adapter) {
  const { page } = draft;
  if (typeof adapter.findPost !== 'function' || typeof page.on !== 'function') return;
  let checking = false;
  let again = false;
  const check = () => {
    if (draft.page !== page || !drafts.has(draft.id)) return;
    if (checking) { again = true; return; }
    checking = true;
    again = false;
    Promise.resolve()
      .then(() => adapter.findPost(page, draft.payload))
      .then((url) => (url ? recordDetectedPost(draft, url) : null))
      .catch((err) => console.warn(`⚠️ ${adapter.label}: could not read the new post's link (${err?.message})`))
      .finally(() => { checking = false; if (again) check(); });
  };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) check(); });
}

const DIRS = { videos: () => PATHS.videos, videoThumbnails: () => PATHS.videoThumbnails };

/** Resolve every `{ dir, name }` file ref in a payload to an existing absolute `path`. */
function resolveFiles(value) {
  if (Array.isArray(value)) return value.map(resolveFiles);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.dir === 'string' && typeof value.name === 'string') {
    const path = DIRS[value.dir] ? safeUnder(DIRS[value.dir](), value.name) : null;
    if (!path || !existsSync(path)) throw new ServerError(`A release file is missing on disk (${value.name}) — rebuild the publishing kit`, { status: 422, code: 'PUBLISH_ASSET_MISSING' });
    return { ...value, path };
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFiles(v)]));
}

// Square cover sizes: Suno shows 1500px; stores ask distributors for 3000px.
const SQUARE_COVER_PX = { suno: 1500, distrokid: 3000 };

/** Cut the frame a platform shows before play: TikTok's cover (9:16 frame), Suno's and DistroKid's (square). */
async function withCovers(target, payload, deps) {
  if (target !== 'tiktok' && !SQUARE_COVER_PX[target]) return payload;
  const source = target === 'tiktok' ? payload.video?.path : payload.cover?.path;
  if (!source) return payload;
  // Composed cover art is already a store-size square.
  if (target === 'distrokid' && payload.cover?.square) return payload;
  const { findFfmpeg, runFfmpegProcess } = await import('../../../lib/ffmpeg.js');
  // A store rejects a non-square cover, so DistroKid gets no draft rather than the 16:9 frame.
  const uncut = () => {
    if (target === 'distrokid') throw new ServerError('Could not cut the square cover art: ffmpeg is unavailable or failed', { status: 422, code: 'PUBLISH_ASSET_MISSING' });
    return payload;
  };
  const ffmpeg = await (deps.findFfmpeg || findFfmpeg)();
  if (!ffmpeg) return uncut();
  await ensureDir(PATHS.videoThumbnails);
  const out = join(PATHS.videoThumbnails, `publish-cover-${target}-${Date.now()}.jpg`);
  const args = target === 'tiktok'
    ? ['-hide_banner', '-loglevel', 'error', '-ss', String(payload.coverAtSec || 0), '-i', source, '-frames:v', '1', '-q:v', '2', '-y', out]
    : ['-hide_banner', '-loglevel', 'error', '-i', source, '-vf', `crop='min(iw,ih)':'min(iw,ih)',scale=${SQUARE_COVER_PX[target]}:${SQUARE_COVER_PX[target]}:flags=lanczos`, '-frames:v', '1', '-q:v', '2', '-y', out];
  const result = await (deps.runFfmpegProcess || runFfmpegProcess)({ bin: ffmpeg, args });
  return result.ok ? { ...payload, cover: { dir: 'videoThumbnails', name: out.split(/[\\/]/).pop(), path: out } } : uncut();
}

/** Options named once under Where you post: DistroKid's artist, Substack's publication. */
const ACCOUNT_OPTION = { distrokid: 'artistName', substack: 'publication' };
function withPlatformDefaults(target, options, platforms) {
  const key = ACCOUNT_OPTION[target];
  if (!key || options?.[key]) return options;
  return { ...options, [key]: platforms?.[target]?.account || '' };
}

// The Suno targets find the song by the id in its page URL; a share link
// (suno.com/s/…, what Suno's Share button copies) carries none until followed.
const SUNO_SONG_TARGETS = new Set(['suno', 'sunoHook']);
async function withSongPage(target, project, options, deps) {
  if (!SUNO_SONG_TARGETS.has(target)) return options;
  const url = publishSongUrl(project, options);
  if (!isSunoShareLink(url)) return options;
  const songUrl = await canonicalizeSunoUrl(url, deps).catch(() => {
    throw new ServerError('That Suno share link did not open a song page. Open it in a browser and paste the suno.com/song/… address it lands on', { status: 422, code: 'PUBLISH_ASSET_MISSING' });
  });
  return { ...options, songUrl };
}

/** The release audio a distributor uploads: the project's own source song. */
async function withAudio(target, payload, project, deps) {
  if (target !== 'distrokid') return payload;
  const resolveAudio = deps.resolveAudio || (await import('../projectAudio.js')).resolveProjectAudioPath;
  const noSong = (message) => new ServerError(message, { status: 422, code: 'PUBLISH_ASSET_MISSING' });
  // The resolver speaks in analysis terms (NO_AUDIO, a stale track link); say what publishing needs instead.
  const path = await resolveAudio(project).catch((err) => {
    throw err?.code === 'NO_AUDIO' ? noSong('Set the project\'s song (a track or an uploaded file) before sending it to DistroKid')
      : noSong(`The project's song can't be found (${err?.message || 'unknown error'}): set the project audio again`);
  });
  if (!path || !existsSync(path)) throw noSong('The song file is missing on disk: set the project audio again');
  return { ...payload, audio: { path } };
}

/**
 * Fill `target`'s post for this project and park it for the director's review.
 * Resolves `{ draftId, target, summary, screenshot }` (a data: URL).
 */
export async function preparePublishDraft(projectId, target, options = {}, deps = {}) {
  const adapter = (deps.adapters || PUBLISH_ADAPTERS)[target];
  if (!adapter) throw new ServerError(`Unknown publish target: ${target}`, { status: 400, code: 'VALIDATION_ERROR' });
  const platforms = deps.platforms || await getPublishPlatforms();
  assertPlatformEnabled(platforms, target);
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  // A platform already posted to gets a second draft only when the director says so:
  // otherwise one stray click is one duplicate post.
  const existing = project.publishKit?.posts?.[target];
  if (existing && options.again !== true) {
    const urls = existing.url ? [existing.url] : [];
    throw new ServerError(`Already posted to ${adapter.label}. Confirm "Post again" to fill another draft`, { status: 409, code: 'PUBLISH_ALREADY_POSTED', context: { target, urls } });
  }
  const resolved = await withSongPage(target, project, withPlatformDefaults(target, options, platforms), deps);
  let payload = resolveFiles(buildPublishPayload(target, project, resolved));
  payload = await withAudio(target, payload, project, deps);
  payload = await withCovers(target, payload, deps);
  for (const draft of [...drafts.values()]) if (draft.projectId === projectId && draft.target === target) await closeDraft(draft, deps);
  return serialize(async () => {
    const { browser, context } = await (deps.connect || connectPortosBrowser)();
    const page = await context.newPage();
    try {
      await page.bringToFront();
      const summary = await adapter.prepare(page, payload);
      // A dedicated account for this content must be the one signed in (where the adapter can tell).
      assertAccount(platforms, target, summary?.account);
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      const id = `mvpub-${randomUUID()}`;
      const screenshot = shot ? `data:image/jpeg;base64,${shot.toString('base64')}` : null;
      const draft = { id, projectId, target, payload, page, browser, summary, screenshot, url: page.url(), state: 'open', createdAt: Date.now() };
      draft.timer = setTimeout(() => { detachDraft(draft).catch(() => {}); }, DRAFT_DETACH_MS);
      draft.timer.unref?.();
      page.once?.('close', () => { if (draft.page === page && draft.state === 'open' && drafts.has(id)) { draft.state = 'closed'; emitDraft(draft); } });
      drafts.set(id, draft);
      watchForPost(draft, adapter);
      emitDraft(draft);
      console.log(`📝 ${adapter.label} draft filled for music-video ${projectId.slice(0, 8)} [${id.slice(6, 14)}]`);
      return draftPresentation(draft);
    } catch (err) {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      throw err;
    }
  });
}

/**
 * What Fill draft would post for `target` with these options, without opening
 * anything: `{ ready: true, parts }` (the rows the director reads), or
 * `{ ready: false, problem }` naming what is missing, in the words Fill draft
 * would refuse with.
 */
export async function previewPublishPost(projectId, target, options = {}, deps = {}) {
  if (!(deps.adapters || PUBLISH_ADAPTERS)[target]) throw new ServerError(`Unknown publish target: ${target}`, { status: 400, code: 'VALIDATION_ERROR' });
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const platforms = deps.platforms || await getPublishPlatforms();
  return withSongPage(target, project, withPlatformDefaults(target, options, platforms), deps)
    .then((resolved) => buildPublishPayload(target, project, resolved))
    .then((payload) => ({ ready: true, parts: publishPreviewParts(target, project, payload) }), (err) => {
      if (err?.status === 422 || err?.status === 409) return { ready: false, problem: err.message };
      throw err;
    });
}

/** Close a draft without posting it. */
export async function discardPublishDraft(projectId, draftId, deps = {}) {
  const draft = drafts.get(draftId);
  if (!draft || draft.projectId !== projectId) return false;
  await closeDraft(draft, deps);
  return true;
}

/** A project's live drafts, each with whether its tab is still open (so a reloaded card can rehydrate). */
export async function listPublishDrafts(projectId, deps = {}) {
  const mine = [...drafts.values()].filter((draft) => draft.projectId === projectId);
  await Promise.all(mine.filter((draft) => !draft.page).map((draft) => refreshDraft(draft, deps)));
  return mine.map(draftPresentation);
}

/**
 * Record or update one platform's post by hand: its link, reception
 * (good/mixed/poor) and notes, and `links`, the release's other posts it now
 * links to (added to what it linked already). A link pasted for a post filled
 * here takes the links that draft carried.
 */
export async function recordPublishPost(projectId, target, input = {}, deps = {}) {
  // The Suno post's link is the song the Hook plays: keep its song page, not a share link.
  if (target === 'suno' && isSunoShareLink(input.url)) input = { ...input, url: await canonicalizeSunoUrl(input.url, deps).catch(() => input.url) };
  if (input.url && !input.links) {
    const filled = [...drafts.values()].filter((d) => d.projectId === projectId && d.target === target).at(-1);
    if (filled?.payload?.crossLinks) input = { ...input, links: filled.payload.crossLinks };
  }
  const { project } = await mutateProjectRecord(projectId, (current) => {
    const kit = current.publishKit && typeof current.publishKit === 'object' ? current.publishKit : {};
    const posts = { ...(kit.posts || {}) };
    if (Array.isArray(input.links) && posts[target]) input = { ...input, links: mergeCarriedLinks(carriedLinks(kit, target), input.links) };
    posts[target] = normalizePost(posts[target], input);
    return { project: { ...current, publishKit: { ...kit, posts } } };
  });
  return { project, post: project.publishKit.posts[target] };
}

/** Turn on or off whether new drafts list the release's other posts. */
export async function setPublishCrossLinks(projectId, enabled) {
  const { project } = await mutateProjectRecord(projectId, (current) => {
    const kit = current.publishKit && typeof current.publishKit === 'object' ? current.publishKit : {};
    return { project: { ...current, publishKit: { ...kit, crossLinks: enabled === true } } };
  });
  return { project };
}

/**
 * Open a posted platform's edit form (or a reply under it) in the PortOS
 * Browser and add the links to the release's posts it lacks. Nothing is
 * saved or posted: the director reviews the tab and saves it, then marks it
 * linked here. Resolves `{ target, links, summary, screenshot }`.
 */
export async function prepareCrossLinkEdit(projectId, target, deps = {}) {
  const adapter = (deps.crossLinkAdapters || CROSS_LINK_ADAPTERS)[target];
  if (!adapter) throw new ServerError(`No cross-link edit for ${target}`, { status: 400, code: 'VALIDATION_ERROR' });
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const row = crossLinkBackfill(project.publishKit).find((r) => r.target === target);
  if (!row) throw new ServerError(`Record the ${adapter.label} post's link first`, { status: 422, code: 'PUBLISH_ASSET_MISSING' });
  if (!row.missing.length) throw new ServerError(`The ${adapter.label} post already links every other post`, { status: 409, code: 'PUBLISH_CROSS_LINKS_CURRENT' });
  return serialize(async () => {
    const { browser, context } = await (deps.connect || connectPortosBrowser)();
    const page = await context.newPage();
    try {
      await page.bringToFront();
      const summary = await adapter.prepare(page, row);
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      console.log(`🔗 ${adapter.label} cross-link edit filled for music-video ${projectId.slice(0, 8)}`);
      return { target, links: row.missing.map((l) => l.target), summary, screenshot: shot ? `data:image/jpeg;base64,${shot.toString('base64')}` : null };
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    } finally {
      await browser.close().catch(() => {}); // disconnects; the tab stays open for the director
    }
  });
}

/** Undo a platform's "done": drop its post record (a mistaken mark, or a post taken down). */
export async function removePublishPost(projectId, target) {
  const { project } = await mutateProjectRecord(projectId, (current) => {
    const kit = current.publishKit && typeof current.publishKit === 'object' ? current.publishKit : {};
    if (!kit.posts?.[target]) return { project: current };
    const { [target]: _removed, ...posts } = kit.posts;
    return { project: { ...current, publishKit: { ...kit, posts } } };
  });
  return { project };
}
