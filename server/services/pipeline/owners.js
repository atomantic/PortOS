/**
 * Pipeline media-job owner strings.
 *
 * Single source of truth for the `pipeline:<issueId>:<stage>:<target>`
 * shape that's stamped onto every mediaJobQueue job enqueued from a
 * pipeline stage. Producers (visualStages.js) and consumers
 * (comicPagesFilenameHook.js) share these helpers so a typo on either
 * end is a compile/lint failure instead of a silently-unmatched event.
 */

const PREFIX = 'pipeline';

// Comic-pages owners encode (issue, target, variant). `variant` distinguishes
// the proof render from the high-resolution final; legacy owners without a
// variant suffix parse as proof so in-flight jobs at upgrade time still land.
export const COMIC_PAGE_VARIANTS = /** @type {const} */ (['proof', 'final']);

// Single source of truth for variant → slot-key. Used by the routes (writing
// the in-flight job's slot), the filename hook (stamping the completed
// filename), and the UI to pick which slot to read.
export const slotKeyForVariant = (variant) =>
  (variant === 'final' ? 'finalImage' : 'proofImage');

export function buildComicPagesOwner({ issueId, target, pageIndex, variant = 'proof' }) {
  if (!COMIC_PAGE_VARIANTS.includes(variant)) {
    throw new Error(`buildComicPagesOwner: unknown variant "${variant}"`);
  }
  if (target === 'cover') return `${PREFIX}:${issueId}:comicPages:cover:${variant}`;
  if (target === 'backCover') return `${PREFIX}:${issueId}:comicPages:backCover:${variant}`;
  if (target === 'page') return `${PREFIX}:${issueId}:comicPages:page${pageIndex}:${variant}`;
  throw new Error(`buildComicPagesOwner: unknown target "${target}"`);
}

// Suffix `(:proof|:final)?` is optional so legacy owners still parse. New
// jobs always include the variant; old jobs default to 'proof' below.
const COMIC_PAGES_RE = /^pipeline:([^:]+):comicPages:(cover|backCover|page(\d+))(?::(proof|final))?$/;

export function parseComicPagesOwner(owner) {
  if (typeof owner !== 'string') return null;
  const m = owner.match(COMIC_PAGES_RE);
  if (!m) return null;
  const [, issueId, kind, pageIdxStr, variantMatch] = m;
  const variant = variantMatch || 'proof';
  if (kind === 'cover') return { issueId, target: 'cover', variant };
  if (kind === 'backCover') return { issueId, target: 'backCover', variant };
  const pageIndex = Number(pageIdxStr);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
  return { issueId, target: 'page', pageIndex, variant };
}

// Season-cover owners — `pipeline:season:<seriesId>:<seasonId>:<target>:<variant>`
// where target ∈ {cover, backCover}. Distinct namespace from issue owners so
// the comic-pages filename hook never accidentally matches a season-cover
// completion event (the issue regex is anchored on `comicPages:` after the
// issue id; season owners use `season:` after the prefix instead).
export function buildSeasonCoverOwner({ seriesId, seasonId, target, variant = 'proof' }) {
  if (!COMIC_PAGE_VARIANTS.includes(variant)) {
    throw new Error(`buildSeasonCoverOwner: unknown variant "${variant}"`);
  }
  if (target !== 'cover' && target !== 'backCover') {
    throw new Error(`buildSeasonCoverOwner: unknown target "${target}"`);
  }
  return `${PREFIX}:season:${seriesId}:${seasonId}:${target}:${variant}`;
}

const SEASON_COVER_RE = /^pipeline:season:([^:]+):([^:]+):(cover|backCover):(proof|final)$/;

export function parseSeasonCoverOwner(owner) {
  if (typeof owner !== 'string') return null;
  const m = owner.match(SEASON_COVER_RE);
  if (!m) return null;
  const [, seriesId, seasonId, target, variant] = m;
  return { seriesId, seasonId, target, variant };
}

// Per-shot start-frame renders inside the storyboards stage. Scene-level
// owners (`pipeline:<id>:storyboards:scene<N>`) still exist for legacy
// scene-image renders that don't decompose into shots — that string is
// produced inline by `enqueueVisualImage` and intentionally falls outside
// this parser (no filename hook needed for the scene-level path).
export function buildStoryboardsShotOwner({ issueId, sceneIndex, shotIndex }) {
  return `${PREFIX}:${issueId}:storyboards:scene${sceneIndex}:shot${shotIndex}`;
}

const STORYBOARDS_SHOT_RE = /^pipeline:([^:]+):storyboards:scene(\d+):shot(\d+)$/;

export function parseStoryboardsShotOwner(owner) {
  if (typeof owner !== 'string') return null;
  const m = owner.match(STORYBOARDS_SHOT_RE);
  if (!m) return null;
  const [, issueId, sceneIdxStr, shotIdxStr] = m;
  const sceneIndex = Number(sceneIdxStr);
  const shotIndex = Number(shotIdxStr);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) return null;
  if (!Number.isInteger(shotIndex) || shotIndex < 0) return null;
  return { issueId, sceneIndex, shotIndex };
}
