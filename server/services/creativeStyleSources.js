/**
 * Style sources — resolve a universe's style guide and a mood board into
 * prompt-ready art direction plus local reference images.
 *
 * Shared by every surface that lets the user pick "a universe or a mood board"
 * as the look of a generation: Code Animation (prompt + brief writer) and
 * Creative Commissions (the style base a scheduled fire hands the Creative
 * Director). One resolver keeps the two from disagreeing about which tokens,
 * notes, and images a universe or board contributes.
 *
 * The universe and mood-board stores are imported lazily so callers that only
 * build prompts stay light in tests.
 */

import { ServerError } from '../lib/errorHandler.js';
import { resolveGalleryImage, resolveImageRef } from '../lib/pathSafety.js';
import { universeVisualStyleTokens } from '../lib/universeVisualStyle.js';
import { isNonBlankStr, trimTo } from '../lib/textUtils.js';

// The two served image dirs a reference can live in, by asset kind.
const IMAGE_DIRS = {
  'image-ref': { resolve: resolveImageRef, urlPrefix: '/data/image-refs/' },
  image: { resolve: resolveGalleryImage, urlPrefix: '/data/images/' },
};

// A local image as a prompt reference, or null when the file is missing.
// `kind` + `filename` are the machine-independent identity a caller persists
// (never `path`, which embeds this install's data dir); `url` is the served
// path a prompt can cite.
function localReference(kind, filename, label, origin) {
  const dir = IMAGE_DIRS[kind];
  const path = dir?.resolve(filename);
  return path ? { kind, filename, label, origin, path, url: `${dir.urlPrefix}${encodeURIComponent(filename)}` } : null;
}

/**
 * Resolve persisted style reference images (`{ kind, filename }`, as a style
 * source returns them) back to absolute local paths for a model call or a
 * render. Files that are gone — deleted since, or never synced to this peer —
 * and unknown kinds are skipped, so the result may be shorter than the input.
 */
export function styleReferenceImagePaths(images) {
  if (!Array.isArray(images)) return [];
  const paths = images
    .map((image) => IMAGE_DIRS[image?.kind]?.resolve(image?.filename) || null)
    .filter(Boolean);
  return [...new Set(paths)];
}

// Resolve reference candidates in order until `slots` are filled, so a
// universe or board with many images costs only the stats it can use.
function fillReferences(candidates, slots) {
  const images = [];
  for (const candidate of candidates) {
    if (images.length >= slots) break;
    const image = candidate();
    if (image && !images.some((existing) => existing.path === image.path)) images.push(image);
  }
  return images;
}

// The narrative half of a universe — its bible text and canon arrays, passed
// through for `renderCanonForPrompt` to project. Only a caller that writes
// story (the Code Animation brief writer) asks for it: art-direction prompts
// would just be crowded by a logline or a character's motivations.
function universeNarrative(universe) {
  const { characters, places, objects } = universe;
  return {
    logline: trimTo(universe.logline, 2_000),
    premise: trimTo(universe.premise, 4_000),
    characters,
    places,
    objects,
  };
}

/**
 * A universe's style guide: its embrace/avoid tokens, curated style references,
 * style notes, linked mood board id, and up to `imageSlots` local style images.
 * Throws a 404 `NOT_FOUND` ServerError when the universe does not exist.
 */
export async function resolveUniverseStyleSource(universeId, { imageSlots, narrative = false }) {
  if (!universeId) return null;
  const { getUniverse } = await import('./universeBuilder/crud.js');
  const universe = await getUniverse(universeId).catch((error) => {
    if (error?.code === 'NOT_FOUND') throw new ServerError('Universe not found', { status: 404, code: 'NOT_FOUND' });
    throw error;
  });
  const { embrace, avoid } = universeVisualStyleTokens(universe);
  const refs = Array.isArray(universe.styleReferences) ? universe.styleReferences : [];
  const styleReferences = refs
    .filter((ref) => isNonBlankStr(ref?.prompt))
    .slice(0, 6)
    .map((ref) => ({ title: trimTo(ref.title, 120), prompt: trimTo(ref.prompt, 600) }));
  // A style image lives in either served dir depending on how it was made
  // (style-reference upload vs gallery probe), so try refs first, then gallery.
  const styleImage = (filename, label) => () => localReference('image-ref', filename, label, 'universe')
    || localReference('image', filename, label, 'universe');
  const candidates = [
    ...refs.map((ref) => [ref?.imageRefs?.[0], trimTo(ref?.title, 120) || 'Universe style reference']),
    ...(Array.isArray(universe.styleImageRefs) ? universe.styleImageRefs : []).map((filename) => [filename, 'Universe style probe']),
  ].filter(([filename]) => isNonBlankStr(filename)).map(([filename, label]) => styleImage(filename, label));
  const images = fillReferences(candidates, imageSlots);
  return {
    name: universe.name,
    embrace,
    avoid,
    styleNotes: trimTo(universe.styleNotes, 2_000),
    styleReferences,
    moodBoardId: isNonBlankStr(universe.moodBoardId) ? universe.moodBoardId : null,
    images,
    ...(narrative ? universeNarrative(universe) : {}),
  };
}

/**
 * A mood board's style context (`collectBoardStyleContext`) plus up to
 * `imageSlots` of its local pinned images. Throws a 404 `NOT_FOUND`
 * ServerError when the board does not exist.
 */
export async function resolveMoodBoardStyleSource(moodBoardId, { imageSlots }) {
  if (!moodBoardId) return { board: null, images: [] };
  const [{ getBoard }, { collectBoardStyleContext }, { boardItemLocalImage }] = await Promise.all([
    import('./moodBoard/db.js'),
    import('./moodBoard/styleContext.js'),
    import('./moodBoard/logic.js'),
  ]);
  const board = await getBoard(moodBoardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  // Text items, videos, and external pins attach nothing — they still
  // contribute their caption/analysis text through the board context.
  const candidates = (board.items || []).map((item) => () => {
    const asset = boardItemLocalImage(item);
    return asset ? localReference(asset.kind, asset.filename, trimTo(item.caption, 120) || asset.filename, 'mood-board') : null;
  });
  return { board: collectBoardStyleContext(board), images: fillReferences(candidates, imageSlots) };
}
