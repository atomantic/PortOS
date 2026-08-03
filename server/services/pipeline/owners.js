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

// Per-shot start-frame renders inside the storyboards stage.
//
// Owners carry BOTH the durable scene/shot ids (#3413) and the indexes:
// `pipeline:<id>:storyboards:scene<N>:shot<M>:sid<sceneId>:tid<shotId>`. The
// completion hook resolves by id (so a reorder between enqueue and completion
// still lands the render on the right shot) and falls back to the index for
// LEGACY owners already sitting in the queue at upgrade time, which carry no
// `:sid`/`:tid` suffix. Ids are percent-encoded so a `:` inside an id can't
// break the parse.
const encodeOwnerId = (id) => (typeof id === 'string' && id ? encodeURIComponent(id) : '');
const decodeOwnerId = (raw) => {
  if (!raw) return null;
  // A malformed percent-escape would throw out of decodeURIComponent; a job
  // owner is never worth crashing a completion handler over, so fall back to
  // the raw token (which then simply fails to match any scene id and drops
  // through to the index fallback).
  try { return decodeURIComponent(raw); } catch { return raw; }
};

export function buildStoryboardsShotOwner({ issueId, sceneIndex, shotIndex, sceneId = null, shotId = null }) {
  const base = `${PREFIX}:${issueId}:storyboards:scene${sceneIndex}:shot${shotIndex}`;
  if (!sceneId && !shotId) return base;
  return `${base}:sid${encodeOwnerId(sceneId)}:tid${encodeOwnerId(shotId)}`;
}

// Scene-level owners (`pipeline:<id>:storyboards:scene<N>[:sid<sceneId>]`) are
// used by the single-scene VIDEO render (no shot decomposition). Nothing parses
// them today — the render is tracked by the `sceneVideoJobId` stamped on the
// scene — but the id rides along so `listJobs({ owner })` and the queue UI
// identify the target unambiguously after a reorder.
export function buildStoryboardsSceneOwner({ issueId, sceneIndex, sceneId = null }) {
  const base = `${PREFIX}:${issueId}:storyboards:scene${sceneIndex}`;
  return sceneId ? `${base}:sid${encodeOwnerId(sceneId)}` : base;
}

const STORYBOARDS_SHOT_RE = /^pipeline:([^:]+):storyboards:scene(\d+):shot(\d+)(?::sid([^:]*):tid([^:]*))?$/;

export function parseStoryboardsShotOwner(owner) {
  if (typeof owner !== 'string') return null;
  const m = owner.match(STORYBOARDS_SHOT_RE);
  if (!m) return null;
  const [, issueId, sceneIdxStr, shotIdxStr, sceneIdRaw, shotIdRaw] = m;
  const sceneIndex = Number(sceneIdxStr);
  const shotIndex = Number(shotIdxStr);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) return null;
  if (!Number.isInteger(shotIndex) || shotIndex < 0) return null;
  return {
    issueId,
    sceneIndex,
    shotIndex,
    sceneId: decodeOwnerId(sceneIdRaw),
    shotId: decodeOwnerId(shotIdRaw),
  };
}
