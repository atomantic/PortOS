/**
 * Music Video publishing (#9282): fill a platform's post in the PortOS Browser,
 * show the director what it will post, and post only when they press Post.
 *
 * `prepare` opens a NEW tab, runs the platform adapter's fill (never its
 * submit), screenshots the filled draft and parks it under a draft id.
 * `submit` requires that same live draft: a missing, expired or closed draft
 * is a 409 and nothing is posted. One browser operation runs at a time,
 * because keyboard input goes to whichever tab has focus. A logged-out
 * platform returns PUBLISH_LOGIN_REQUIRED; login, CAPTCHAs and 2FA are the
 * director's to do in the PortOS Browser.
 *
 * Posting results persist to `project.publishKit.posts[target] = { url, postedAt }`;
 * the director can add reception and notes, or record a post made by hand (#9287).
 * Only platforms the director turned on can be prepared.
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

export const PUBLISH_ADAPTERS = Object.freeze({
  youtube: youtubeAdapter, shorts: shortsAdapter, tiktok: tiktokAdapter, instagram: instagramAdapter,
  x: xAdapter, reddit: redditAdapter, stackerNews: stackerNewsAdapter, suno: sunoAdapter,
});
const DRAFT_TTL_MS = 30 * 60 * 1000;
const drafts = new Map();

const draftError = (message) => new ServerError(message, { status: 409, code: 'PUBLISH_DRAFT_MISSING' });

async function closeDraft(draft) {
  drafts.delete(draft.id);
  clearTimeout(draft.timer);
  await draft.page?.close().catch(() => {});
  await draft.browser?.close().catch(() => {}); // disconnects; the PortOS Browser keeps running
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

/** Cut the frame a platform shows before play: TikTok's cover (9:16 frame) and Suno's (square). */
async function withCovers(target, payload, deps) {
  if (target !== 'tiktok' && target !== 'suno') return payload;
  const source = target === 'tiktok' ? payload.video?.path : payload.cover?.path;
  if (!source) return payload;
  const { findFfmpeg, runFfmpegProcess } = await import('../../../lib/ffmpeg.js');
  const ffmpeg = await (deps.findFfmpeg || findFfmpeg)();
  if (!ffmpeg) return payload;
  await ensureDir(PATHS.videoThumbnails);
  const out = join(PATHS.videoThumbnails, `publish-cover-${target}-${Date.now()}.jpg`);
  const args = target === 'tiktok'
    ? ['-hide_banner', '-loglevel', 'error', '-ss', String(payload.coverAtSec || 0), '-i', source, '-frames:v', '1', '-q:v', '2', '-y', out]
    : ['-hide_banner', '-loglevel', 'error', '-i', source, '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=1500:1500", '-frames:v', '1', '-q:v', '2', '-y', out];
  const result = await (deps.runFfmpegProcess || runFfmpegProcess)({ bin: ffmpeg, args });
  return result.ok ? { ...payload, cover: { dir: 'videoThumbnails', name: out.split(/[\\/]/).pop(), path: out } } : payload;
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
  let payload = resolveFiles(buildPublishPayload(target, project, options));
  payload = await withCovers(target, payload, deps);
  for (const draft of [...drafts.values()]) if (draft.projectId === projectId && draft.target === target) await closeDraft(draft);
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
      const draft = { id, projectId, target, payload, page, browser, summary, createdAt: Date.now() };
      draft.timer = setTimeout(() => { closeDraft(draft).catch(() => {}); }, DRAFT_TTL_MS);
      draft.timer.unref?.();
      drafts.set(id, draft);
      console.log(`📝 ${adapter.label} draft filled for music-video ${projectId.slice(0, 8)} [${id.slice(6, 14)}]`);
      return { draftId: id, target, summary, screenshot: shot ? `data:image/jpeg;base64,${shot.toString('base64')}` : null };
    } catch (err) {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      throw err;
    }
  });
}

/** Post a draft the director reviewed. Resolves `{ project, post }`. */
export async function submitPublishDraft(projectId, draftId, deps = {}) {
  const draft = drafts.get(draftId);
  if (!draft || draft.projectId !== projectId) throw draftError('That draft is gone (posted, discarded or expired) — fill it again');
  if (draft.page.isClosed?.()) { await closeDraft(draft); throw draftError('The draft tab was closed — fill it again'); }
  const adapter = (deps.adapters || PUBLISH_ADAPTERS)[draft.target];
  return serialize(async () => {
    await draft.page.bringToFront();
    const { url = null } = await adapter.submit(draft.page, draft.payload) || {};
    await closeDraft(draft);
    const post = { url, postedAt: new Date().toISOString() };
    console.log(`🚀 Posted music-video ${projectId.slice(0, 8)} to ${adapter.label}${url ? `: ${url}` : ''}`);
    const { project } = await mutateProjectRecord(projectId, (current) => {
      const kit = current.publishKit && typeof current.publishKit === 'object' ? current.publishKit : {};
      return { project: { ...current, publishKit: { ...kit, posts: { ...(kit.posts || {}), [draft.target]: post } } } };
    });
    return { project, post };
  });
}

/** Close a draft without posting it. */
export async function discardPublishDraft(projectId, draftId) {
  const draft = drafts.get(draftId);
  if (!draft || draft.projectId !== projectId) return false;
  await closeDraft(draft);
  return true;
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
