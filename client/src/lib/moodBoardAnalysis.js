// Mood-board analysis helpers shared by the per-item prompt-from-media flow
// and the board-level "analyze, then compose a poster" flow.
//
// Pure: no React, no fetches. The page persists whatever `moodBoardAnalysisFromResult`
// returns; the style panel uses `boardAnalyzePlan` to decide whether the next
// click runs vision or only composes from prompts already stored on the items.

import { moodBoardItemAnalysisSource } from './moodBoardItemSrc';
import { IMAGE_GEN_MODE } from './imageGenModes';

// Landscape 3:2 — a board poster, not a portrait character sheet. The image
// service is whichever backend the caller resolved; only the frame is fixed.
export const BOARD_POSTER_SIZE = Object.freeze({ width: 1536, height: 1024 });

/**
 * The analysis object stored on a media item after one prompt-from-media run.
 * Prefers the prompt that matches the item's own type (video items keep the
 * video prompt) and falls back to the other target when the model only filled
 * one. Returns null when neither prompt is usable.
 */
export function moodBoardAnalysisFromResult(item, result) {
  if (!result) return null;
  const preferVideo = item?.type === 'video';
  const primary = preferVideo ? result.videoPrompt : result.imagePrompt;
  const fallback = preferVideo ? result.imagePrompt : result.videoPrompt;
  const usedPrimary = primary != null && primary !== '';
  const prompt = usedPrimary ? primary : fallback;
  if (!prompt) return null;
  const negative = usedPrimary
    ? (preferVideo ? result.videoNegativePrompt : result.imageNegativePrompt)
    : (preferVideo ? result.imageNegativePrompt : result.videoNegativePrompt);
  return {
    prompt,
    negativePrompt: negative || null,
    rationale: result.rationale || null,
    providerId: result.providerId || null,
    model: result.model || null,
  };
}

/**
 * Resolves the primary prompt text for a mood board item.
 * Prefers the analyzed prompt from prompt-from-media, then explicit item.prompt,
 * then a gallery item's caption prompt. Returns empty string if no prompt exists.
 */
export function moodBoardItemPrompt(item) {
  if (item?.analysis?.prompt && typeof item.analysis.prompt === 'string' && item.analysis.prompt.trim()) {
    return item.analysis.prompt.trim();
  }
  if (item?.prompt && typeof item.prompt === 'string' && item.prompt.trim()) {
    return item.prompt.trim();
  }
  if ((item?.mediaKey?.startsWith('image:') || item?.mediaKey?.startsWith('video:')) && item?.caption && typeof item.caption === 'string' && item.caption.trim()) {
    return item.caption.trim();
  }
  return '';
}

/**
 * Returns true if the item has an explicit prompt-from-media analysis saved.
 */
export function isMoodBoardItemAnalyzed(item) {
  return Boolean(item?.analysis?.prompt && typeof item.analysis.prompt === 'string' && item.analysis.prompt.trim());
}

/**
 * Returns true if the item has been analyzed OR already has a prompt.
 */
export function moodBoardItemHasPrompt(item) {
  return isMoodBoardItemAnalyzed(item) || Boolean(moodBoardItemPrompt(item));
}

/**
 * Split a board's items into the ones prompt-from-media can still read and
 * the ones that already carry a prompt. External URL pins can't be read, so
 * they count as skipped rather than pending.
 */
export function boardAnalyzePlan(items) {
  const list = Array.isArray(items) ? items : [];
  const pending = [];
  let analyzed = 0;
  let skipped = 0;
  for (const item of list) {
    if (moodBoardItemHasPrompt(item)) {
      analyzed += 1;
      continue;
    }
    if (item?.type !== 'image' && item?.type !== 'video') continue;
    if (moodBoardItemAnalysisSource(item)) pending.push(item);
    else skipped += 1;
  }
  return { pending, analyzed, skipped };
}

// Stable key for the style a poster was queued against, so a completion that
// lands after the user composed a different prompt is not pinned.
export function posterStyleKey(style) {
  return JSON.stringify({
    prompt: typeof style?.prompt === 'string' ? style.prompt.trim() : '',
    negative: typeof style?.negativePrompt === 'string' ? style.negativePrompt.trim() : '',
  });
}

/**
 * Render config for the board poster. `mode` (when set) overrides the resolved
 * install default so the poster can run on any enabled image service. The
 * override is explicit (`inheritedBackend: false`) — a mood board has no
 * universe/music-video tag that would re-resolve the backend server-side.
 * Switching off local drops the local model id so it is not sent to a cloud CLI.
 */
export function boardPosterRenderCfg(imageCfg, mode) {
  const chosen = mode || imageCfg?.mode;
  const local = chosen === IMAGE_GEN_MODE.LOCAL;
  return {
    ...(imageCfg || {}),
    mode: chosen,
    inheritedBackend: false,
    modelId: local ? (imageCfg?.modelId || null) : null,
    cloudModel: null,
    width: BOARD_POSTER_SIZE.width,
    height: BOARD_POSTER_SIZE.height,
  };
}

/**
 * Generator handoff links for a board item's card: text-to-image and
 * text-to-video need a prompt (the analyzed one, else caption); image-to-image
 * and image-to-video also need the item to be a local gallery image. Each key
 * is null when that handoff doesn't apply. The negative prompt rides along only
 * when the analysis saved one.
 */
export function moodBoardItemSendLinks(item) {
  const prompt = moodBoardItemPrompt(item);
  const negative = typeof item?.analysis?.negativePrompt === 'string' ? item.analysis.negativePrompt.trim() : '';
  const source = moodBoardItemAnalysisSource(item);
  const imageFile = item?.type === 'image' && source?.kind !== 'video' ? source?.filename : null;
  const build = (path, extra = {}) => {
    const params = new URLSearchParams();
    if (prompt) params.set('prompt', prompt);
    if (negative) params.set('negativePrompt', negative);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return `${path}?${params}`;
  };
  return {
    textToImage: prompt ? build('/media/image') : null,
    imageToImage: imageFile ? build('/media/image', { initImageFile: imageFile }) : null,
    video: imageFile ? build('/media/video', { sourceImageFile: imageFile }) : (prompt ? build('/media/video') : null),
  };
}
