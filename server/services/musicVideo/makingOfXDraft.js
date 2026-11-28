/**
 * Prepare Making-Of X thread drafts in the PortOS Browser for manual review and posting.
 *
 * Mirrors `publish/index.js`: opens a dedicated tab in the operator's signed-in
 * PortOS Browser, fills each thread part's text and its per-part image/video
 * attachments (up to 4 mixed media items per X post), captures a review
 * screenshot, and stops. PortOS never presses Post — the director reviews and
 * publishes in X, then records the top-level post link back on the Making-Of card.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import {
  MAKING_OF_X_MAX_MEDIA_PER_POST,
  normalizeMakingOfStory,
  resolveMakingOfPostParts,
} from '../../lib/musicVideo/musicVideoMakingOfStory.js';
import { getHistoryItem } from '../videoGen/history.js';
import { musicVideoEvents } from './events.js';
import { requireProject } from './requireProject.js';
import {
  browserOperationInProgress,
  connectPortosBrowser,
  pageTargetId,
  serializeBrowserOperation as serialize,
} from './publish/browser.js';
import { assertAccount, getPublishPlatforms } from './publish/platforms.js';
import { xAdapter } from './publish/x.js';

const DRAFT_DETACH_MS = 30 * 60 * 1000;
const X_CAPABLE_PLATFORMS = new Set(['x', 'multi']);
const drafts = new Map();

const draftPresentation = (draft) => ({
  draftId: draft.id,
  projectId: draft.projectId,
  postId: draft.postId,
  summary: draft.summary,
  screenshot: draft.screenshot,
  state: draft.state,
  createdAt: draft.createdAt,
  manualPublication: true,
});

const emitDraft = (draft, state = draft.state) => musicVideoEvents.emit('making-of-draft', {
  projectId: draft.projectId,
  postId: draft.postId,
  draftId: draft.id,
  state,
});

async function detachDraft(draft) {
  clearTimeout(draft.timer);
  const { browser } = draft;
  draft.browser = null;
  draft.page = null;
  await browser?.close().catch(() => {});
}

async function findDraftPage(draft, deps = {}, replacement = null) {
  if (draft.page) return { page: draft.page.isClosed() ? null : draft.page };
  if (!draft.targetId) return { page: null };
  let reconnect;
  if (!replacement) {
    try { reconnect = await (deps.connect || connectPortosBrowser)({ launch: false }); } catch { return { page: null }; }
  }
  try {
    const { context } = replacement || reconnect;
    for (const page of context.pages()) {
      if (page !== replacement?.page && await pageTargetId(context, page) === draft.targetId) return { page, reconnect };
    }
    return { page: null, reconnect };
  } catch (err) {
    await reconnect?.browser.close().catch(() => {});
    throw err;
  }
}

async function refreshDraft(draft, deps) {
  if (draft.state === 'closed') return;
  const { page, reconnect } = await findDraftPage(draft, deps);
  await reconnect?.browser.close().catch(() => {});
  if (!page) {
    draft.state = 'closed';
    emitDraft(draft);
  }
}

async function closeDraft(draft, deps, replacement = null) {
  drafts.delete(draft.id);
  clearTimeout(draft.timer);
  const { page, reconnect } = await findDraftPage(draft, deps, replacement);
  try {
    await page?.close().catch(() => {});
  } finally {
    await (reconnect?.browser || draft.browser)?.close().catch(() => {});
  }
  emitDraft(draft, 'discarded');
}

async function resolveItemFilePath(item, deps = {}) {
  const missing = (detail) => new ServerError(`An attached Making-Of file is missing on disk (${detail})`, {
    status: 422,
    code: 'MAKING_OF_ASSET_MISSING',
  });
  if (item.kind === 'video') {
    const lookup = deps.getVideoHistoryItem || getHistoryItem;
    const entry = await lookup(item.assetId);
    if (!entry?.filename) throw missing(item.label || item.assetId);
    const resolved = safeUnder(PATHS.videos, entry.filename);
    if (!resolved || !existsSync(resolved)) throw missing(entry.filename);
    return { kind: 'video', name: entry.filename, path: resolved };
  }
  const resolved = safeUnder(PATHS.images, item.assetId);
  if (!resolved || !existsSync(resolved)) throw missing(item.assetId);
  return { kind: 'image', name: item.assetId, path: resolved };
}

/** Build the X thread payload (`{ posts: [{ text, mediaFiles }] }`) with disk-verified media paths. */
export async function buildMakingOfXThreadPayload(post, items, deps = {}) {
  if (!X_CAPABLE_PLATFORMS.has(post.platform)) {
    throw new ServerError('Only X (or multi-platform) Making-Of posts can fill an X thread draft', {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const parts = resolveMakingOfPostParts(post, items);
  if (!parts.length) {
    throw new ServerError('Add post text before filling an X draft', {
      status: 422,
      code: 'MAKING_OF_EMPTY_POST',
    });
  }
  const posts = [];
  let attachments = 0;
  for (const part of parts) {
    if (part.items.length > MAKING_OF_X_MAX_MEDIA_PER_POST) {
      throw new ServerError(`X allows at most ${MAKING_OF_X_MAX_MEDIA_PER_POST} media items per post (Part ${part.index + 1} has ${part.items.length})`, {
        status: 422,
        code: 'VALIDATION_ERROR',
      });
    }
    const mediaFiles = [];
    for (const item of part.items) {
      mediaFiles.push(await resolveItemFilePath(item, deps));
    }
    attachments += mediaFiles.length;
    posts.push(mediaFiles.length ? { text: part.text, mediaFiles } : { text: part.text });
  }
  return { posts, attachments };
}

/**
 * Open a new PortOS Browser tab on X, type every part of the Making-Of thread,
 * attach each part's chosen images/videos, and pause for human review & posting.
 */
export async function prepareMakingOfXDraft(projectId, postId, options = {}, deps = {}) {
  const project = await requireProject(projectId);
  const story = normalizeMakingOfStory(project.makingOfStory);
  const post = story.posts.find((entry) => entry.id === postId);
  if (!post) throw new ServerError('Making-of post not found', { status: 404, code: 'NOT_FOUND' });

  if (post.status === 'posted' && options.again !== true) {
    throw new ServerError('Already posted to X. Confirm "Post again" to fill another draft', {
      status: 409,
      code: 'PUBLISH_ALREADY_POSTED',
      context: { postId, urls: post.publishedUrl ? [post.publishedUrl] : [] },
    });
  }

  const platforms = deps.platforms || await getPublishPlatforms();
  const payload = await buildMakingOfXThreadPayload(post, story.items, deps);
  const adapter = deps.adapter || xAdapter;

  const progress = (state, message) => musicVideoEvents.emit('making-of-draft', { projectId, postId, state, message });
  const holder = browserOperationInProgress();
  if (holder) {
    const what = holder.label ? `${holder.label} to finish` : 'another PortOS Browser task to finish';
    progress('queued', `Waiting for ${what}${holder.status ? ` (${holder.status})` : ''}`);
  }

  let tab = null;
  return serialize(async () => {
    progress('filling', 'Opening X in the PortOS Browser');
    const { browser, context } = await (deps.connect || connectPortosBrowser)();
    try {
      const page = await context.newPage();
      tab = page;
      const targetId = await pageTargetId(context, page);
      await page.bringToFront();
      const adapterSummary = await adapter.prepare(page, payload);
      // Guard against filling into the wrong signed-in X account when one is configured.
      assertAccount(platforms, 'x', adapterSummary?.account);
      const summary = {
        ...adapterSummary,
        attachments: payload.attachments,
        mediaPerPost: payload.posts.map((entry) => entry.mediaFiles?.length || 0),
      };
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      const id = `mvmof-${randomUUID()}`;
      const screenshot = shot ? `data:image/jpeg;base64,${shot.toString('base64')}` : null;
      const draft = {
        id,
        projectId,
        postId,
        payload,
        page,
        browser,
        summary,
        screenshot,
        targetId,
        state: 'open',
        createdAt: Date.now(),
      };
      for (const previous of [...drafts.values()]) {
        if (previous.projectId === projectId && previous.postId === postId) {
          await closeDraft(previous, deps, { context, page });
        }
      }
      draft.timer = setTimeout(() => { detachDraft(draft).catch(() => {}); }, DRAFT_DETACH_MS);
      draft.timer.unref?.();
      page.once?.('close', () => {
        if (draft.page === page && draft.state === 'open' && drafts.has(id)) {
          draft.state = 'closed';
          emitDraft(draft);
        }
      });
      drafts.set(id, draft);
      emitDraft(draft);
      console.log(`📝 Making-Of X draft filled for music-video ${projectId.slice(0, 8)} post ${postId} [${id.slice(6, 14)}] (${payload.posts.length} parts, ${payload.attachments} files)`);
      return draftPresentation(draft);
    } catch (err) {
      if (err?.code !== 'PUBLISH_EDIT_INTERRUPTED') await tab?.close().catch(() => {});
      await browser.close().catch(() => {});
      throw err;
    }
  }, {
    label: `Making Of (${post.title.slice(0, 32)})`,
    onStep: (status) => progress('filling', `X: ${status}`),
    focus: () => tab?.bringToFront(),
  });
}

/** List live Making-Of X drafts for `projectId`, re-checking detached tabs. */
export async function listMakingOfXDrafts(projectId, deps = {}) {
  const mine = [...drafts.values()].filter((entry) => entry.projectId === projectId);
  await Promise.all(mine.map((entry) => (entry.page ? null : refreshDraft(entry, deps))));
  return mine.map(draftPresentation);
}

/** Close and discard an open Making-Of X draft without posting it. */
export async function discardMakingOfXDraft(projectId, draftId, deps = {}) {
  const draft = drafts.get(draftId);
  if (!draft || draft.projectId !== projectId) return false;
  await closeDraft(draft, deps);
  return true;
}

/**
 * Detach any open drafts for `postId` after the director records the published post.
 * Leaves the browser tab untouched so the newly posted X thread stays open.
 */
export async function detachMakingOfXDraftsForPost(projectId, postId) {
  for (const draft of [...drafts.values()]) {
    if (draft.projectId !== projectId || draft.postId !== postId) continue;
    drafts.delete(draft.id);
    await detachDraft(draft);
    emitDraft(draft, 'posted');
  }
}

export function __resetMakingOfXDrafts() {
  for (const draft of drafts.values()) clearTimeout(draft.timer);
  drafts.clear();
}
