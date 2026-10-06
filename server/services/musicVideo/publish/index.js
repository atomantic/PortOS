/**
 * Prepare external platform drafts for manual review and publication.
 * Draft preparation requires an existing authenticated session, including agents.
 * PortOS never submits a draft; the operator publishes in the destination
 * platform and records its URL. Adapter preparation runs in a serialized,
 * dedicated browser tab. Existing drafts can be discarded or replaced.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { ServerError } from '../../../lib/errorHandler.js';
import { PATHS, ensureDir } from '../../../lib/fileUtils.js';
import { safeUnder } from '../../../lib/ffmpeg.js';
import { getProject, mutateProjectRecord } from '../projects.js';
import { buildPublishPayload } from './payloads.js';
import { connectPortosBrowser, serializeBrowserOperation as serialize } from './browser.js';
import { assertAccount, assertPlatformEnabled, getPublishPlatforms, normalizePost } from './platforms.js';
import { youtubeAdapter, shortsAdapter } from './youtube.js';
import { tiktokAdapter } from './tiktok.js';
import { instagramAdapter } from './instagram.js';
import { xAdapter } from './x.js';
import { redditAdapter } from './reddit.js';
import { stackerNewsAdapter } from './stackerNews.js';
import { sunoAdapter } from './suno.js';
import { sunoHookAdapter } from './sunoHook.js';
import { distrokidAdapter } from './distrokid.js';
import { musicVideoEvents } from '../events.js';

export const PUBLISH_ADAPTERS = Object.freeze({
  youtube: youtubeAdapter, shorts: shortsAdapter, tiktok: tiktokAdapter, instagram: instagramAdapter,
  x: xAdapter, reddit: redditAdapter, stackerNews: stackerNewsAdapter, suno: sunoAdapter, sunoHook: sunoHookAdapter, distrokid: distrokidAdapter,
});
// The tab stays open past this: the human publishes from it. After the TTL only
// the CDP session is dropped; the tab closes on Discard, Fill again, or by hand.
const DRAFT_DETACH_MS = 30 * 60 * 1000;
const drafts = new Map();

const draftPresentation = (draft) => ({
  draftId: draft.id, projectId: draft.projectId, target: draft.target, summary: draft.summary,
  screenshot: draft.screenshot, state: draft.state, createdAt: draft.createdAt, manualPublication: true,
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

/** DistroKid's options default the artist to the account named under Where you post. */
function withPlatformDefaults(target, options, platforms) {
  if (target !== 'distrokid' || options?.artistName) return options;
  return { ...options, artistName: platforms?.distrokid?.account || '' };
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
  let payload = resolveFiles(buildPublishPayload(target, project, withPlatformDefaults(target, options, platforms)));
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

/** Record or update one platform's post by hand: its link, reception (good/mixed/poor) and notes. */
export async function recordPublishPost(projectId, target, input = {}) {
  const { project } = await mutateProjectRecord(projectId, (current) => {
    const kit = current.publishKit && typeof current.publishKit === 'object' ? current.publishKit : {};
    const posts = { ...(kit.posts || {}) };
    posts[target] = normalizePost(posts[target], input);
    return { project: { ...current, publishKit: { ...kit, posts } } };
  });
  return { project, post: project.publishKit.posts[target] };
}
