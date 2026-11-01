import { pickGuideMedia, rejectedReferenceKeys, matchesReferenceVariant } from './catalogMediaLibrary.js';
import { isEditCapableMode, maxInputImages } from './imageGenCapabilities.js';
import { RUNNER_FAMILIES } from './runners.js';
import { escapeRegExp } from './textUtils.js';

/** Browser-safe reference selection shared by the board and production lanes. */
export const MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES = 4;

/**
 * A reference pulled in from outside inspiration: imported from a mood board
 * ("Import board images") or a synced Pinterest pin. Outside images inform the
 * look as text and are never sent to a generator as a conditioning image.
 */
export const isOutsideMusicVideoReference = (ref) => String(ref?.id || '').startsWith('mvr-board-')
  || String(ref?.imageId || '').startsWith('pinterest-');

const namesIn = (text, phrase) => {
  const p = String(phrase || '').trim();
  return p.length >= 3 && new RegExp(`\\b${escapeRegExp(p)}\\b`, 'i').test(text);
};

/** The supporting cast members a scene's frame or shot prompt names, by name or role. */
function featuredCast(direction, scene) {
  const text = [scene?.framePrompt, scene?.prompt].filter(Boolean).join(' ');
  if (!text) return [];
  return (direction?.cast || []).filter((c) => namesIn(text, c.name) || namesIn(text, c.role));
}

// A close framing: the face fills the frame, so the set barely shows and the face sheets matter most.
const CLOSE_FRAMING = /\b(extreme close|close-?up|close on|tight on|selfie|arm'?s[- ]length|face fills)/i;

/** Whether a scene's frame or shot prompt frames a face close. */
export function isCloseFraming(scene) {
  return CLOSE_FRAMING.test([scene?.framePrompt, scene?.prompt].filter(Boolean).join(' '));
}

/**
 * Whether a scene's frame or shot prompt shows one of the direction's props: by
 * its name without the owner ("Renee's camera" is shown by "camera"), so a shot
 * that only names its owner does not pull the prop sheet in.
 */
function showsProp(direction, scene) {
  const text = [scene?.framePrompt, scene?.prompt].filter(Boolean).join(' ');
  if (!text) return false;
  return (direction?.props || []).some((item) => {
    const words = String(item?.name || '').split(/\s+/).filter((w) => !/['’]s$/i.test(w) && w.length >= 3);
    return words.length && (namesIn(text, words.join(' ')) || namesIn(text, words.at(-1)));
  });
}

/**
 * The director's own character references (an upload or a PortOS render, not
 * Cast & Sets output or outside inspiration) whose label's name, the part
 * before any " — ", " - ", ":" or "(", the scene's prompt names.
 */
function featuredAuthoredCharacters(references, scene) {
  const text = [scene?.framePrompt, scene?.prompt].filter(Boolean).join(' ');
  if (!text) return [];
  return references.filter((ref) => ref?.role === 'character' && ref.imageId && !String(ref.id || '').startsWith('mvr-cs-')
    && !isOutsideMusicVideoReference(ref) && namesIn(text, String(ref.label || '').split(/\s[—-]\s|[:(]/)[0]));
}

/** The references a director can send with a shot's frames: every one with an image except outside inspiration. */
export const musicVideoReferenceChoices = (project) => (project?.visualSpec?.references || [])
  .filter((ref) => ref?.id && ref.imageId && !isOutsideMusicVideoReference(ref));

/** The cast member and variant a scene asks its frames to show, or null when it names none. */
export function sceneCastVariant(scene) {
  const variant = scene?.characterVariant;
  return variant && typeof variant.ingredientId === 'string' && variant.ingredientId ? variant : null;
}

// A file a frame render can name as a reference (routes/imageGen.js galleryImageFilenameSchema).
const SENDABLE_REFERENCE_FILE = /^[^/\\]+\.(png|jpe?g|webp)$/i;
// The catalog media kinds pickGuideMedia treats as images (catalogMediaLibrary.js).
const CAST_IMAGE_KINDS = new Set(['portrait', 'reference']);

/**
 * The Casting guide images (catalogMediaLibrary.pickGuideMedia) for the cast
 * member a scene's `characterVariant` names, as visual-spec-shaped references.
 * `castMedia` maps an ingredient id to its live catalog media rows; a missing
 * entry (not loaded, or the load failed) yields none, so the scene falls back
 * to the project's references.
 */
export function musicVideoCastGuideReferences(project, scene, castMedia) {
  const variant = sceneCastVariant(scene);
  const media = variant && castMedia?.[variant.ingredientId];
  if (!Array.isArray(media)) return [];
  const name = (project?.concept?.subjects || []).find((s) => s?.ingredientId === variant.ingredientId)?.name || 'Cast guide';
  // Frame renders accept only a png/jpg/jpeg/webp basename (routes/imageGen.js). Filtering before
  // the pick lets the next candidate take an unsendable file's slot. The guide-vs-fallback choice
  // reads the member's real guide flags: with guides flagged, only sendable guides qualify (none
  // left = the automatic set), never the non-guide images pickGuideMedia falls back to.
  const want = { age: variant.age, era: variant.era, wardrobeId: variant.wardrobeId };
  const rejected = rejectedReferenceKeys(media);
  const eligible = media.filter((m) => m && !m.deleted && !rejected.has(m.mediaKey) && matchesReferenceVariant(m, want));
  const sendable = eligible.filter((m) => typeof m?.mediaKey === 'string' && SENDABLE_REFERENCE_FILE.test(m.mediaKey));
  const flagged = eligible.some((m) => CAST_IMAGE_KINDS.has(m.kind) && m.library?.guide === true);
  const candidates = flagged ? sendable.filter((m) => m.library?.guide === true) : sendable;
  if (!candidates.length) return [];
  return pickGuideMedia(candidates, { age: variant.age, era: variant.era, wardrobeId: variant.wardrobeId }, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES)
    .map((m) => {
      const v = m.library?.variant || {};
      const detail = v.label || (Number.isInteger(v.age) ? `age ${v.age}` : v.era || '');
      return {
        id: `mvr-guide-${m.mediaKey}`.slice(0, 128),
        imageId: m.mediaKey,
        role: 'character',
        label: `${name}${detail ? ` · ${detail}` : ''}`.slice(0, 120),
        castGuide: true,
      };
    });
}

/**
 * The references a scene's frames condition on, capped at
 * MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES. Explicit `frameReferenceIds` win;
 * otherwise the cast guides of the scene's `characterVariant` lead and the
 * automatic set fills the remaining slots. `castMedia` is optional: without it
 * (or without a variant) the result is the automatic set alone.
 */
function baseConditioningReferences(project, scene, castMedia = null) {
  const guides = musicVideoCastGuideReferences(project, scene, castMedia);
  const panel = musicVideoPanelArtReferences(scene);
  // The director's own pick for this shot (the shot card's References row) wins over the automatic set.
  if (Array.isArray(scene?.frameReferenceIds)) {
    const choices = [...guides, ...panel, ...musicVideoReferenceChoices(project)];
    return scene.frameReferenceIds.map((id) => choices.find((ref) => ref.id === id)).filter(Boolean)
      .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
  }
  const automatic = automaticConditioningReferences(project, scene);
  const chosen = guides.length ? [...guides, ...automatic] : automatic;
  const unique = chosen.filter((ref, i) => chosen.findIndex((r) => r.imageId === ref.imageId) === i);
  if (!panel.length) return unique.slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
  // The storyboard panel keeps a slot; identities fill the rest.
  return [...unique.filter((ref) => ref.imageId !== panel[0].imageId).slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES - 1), ...panel];
}

/**
 * A shot fitted from a storyboard panel conditions on the panel's art as a
 * composition guide (never its start frame), as a chip the References row
 * shows and can drop.
 */
export function musicVideoPanelArtReferences(scene) {
  if (typeof scene?.panelArt !== 'string' || !SENDABLE_REFERENCE_FILE.test(scene.panelArt)) return [];
  return [{ id: `mvr-panel-${scene.panelId || 'art'}`.slice(0, 128), imageId: scene.panelArt, role: 'mood', label: 'Storyboard panel', panelArt: true }];
}

function automaticConditioningReferences(project, scene) {
  const references = project?.visualSpec?.references || [];
  const stage = project?.castAndSets;
  // Legacy projects and incomplete check-ins retain the authored reference set.
  const authored = references.filter((ref) => ref?.condition && ref.imageId && !isOutsideMusicVideoReference(ref));
  const character = stage?.status === 'approved' && references.find((ref) => ref?.id === 'mvr-cs-character' && ref.imageId);
  if (character) {
    const setId = Number.isInteger(scene?.sectionIndex)
      ? stage.direction?.songMap?.find((entry) => entry.section === scene.sectionIndex)?.setId : null;
    const plate = setId && references.find((ref) => ref?.id === `mvr-cs-set-${setId}` && ref.imageId);
    // Check-in plates and cast sheets beyond the project-wide cap are still
    // available for their own scenes. Their condition flag reflects that cap,
    // not scene relevance. A supporting cast member's sheet joins the shots
    // that name them, and so does a director's own character reference whose
    // label names someone the shot names.
    const cast = featuredCast(stage.direction, scene)
      .map((c) => references.find((ref) => ref?.id === `mvr-cs-cast-${c.id}`.slice(0, 64) && ref.imageId))
      .filter(Boolean);
    // A shot with no song section (a replaced song clears them) cannot name its
    // set, but it still names its cast: identities come first, and the authored
    // set fills the spare slots rather than displacing a featured cast sheet.
    // The prop sheet joins the shots that show a prop, after the identities and the set.
    const props = showsProp(stage.direction, scene) && references.find((ref) => ref?.id === 'mvr-cs-props' && ref.imageId);
    // A close-up trades the set plate for each person's face sheet (head angles and moods),
    // after their full sheet; a prop and then the set fill what is left.
    if (isCloseFraming(scene)) {
      const faceOf = (id) => references.find((ref) => ref?.id === id && ref.imageId);
      const people = [[character, faceOf('mvr-cs-expressions')], ...cast.map((sheet) => [sheet, faceOf(sheet.id.replace('mvr-cs-cast-', 'mvr-cs-face-'))])];
      const close = [...people.flat().filter(Boolean), ...featuredAuthoredCharacters(references, scene), ...(props ? [props] : []), ...(plate ? [plate] : authored)];
      return close.filter((ref, i) => close.findIndex((r) => r.imageId === ref.imageId) === i).slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
    }
    const chosen = plate
      ? [character, plate, ...cast, ...featuredAuthoredCharacters(references, scene), ...(props ? [props] : [])]
      : [character, ...cast, ...featuredAuthoredCharacters(references, scene), ...(props ? [props] : []), ...authored];
    return chosen.filter((ref, i) => chosen.findIndex((r) => r.imageId === ref.imageId) === i)
      .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
  }
  return authored.slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
}

/** Style images fill spare slots after identities; never displace a character or set. */
export function musicVideoStyleReferenceCapacity(mode, localModel) {
  if (!isEditCapableMode(mode)) return 0;
  if (mode === 'local') {
    if (localModel?.pipelineClass === 'QwenImage21Pipeline') return 10;
    return localModel?.runner === RUNNER_FAMILIES.FLUX2 ? 4 : 0;
  }
  return Math.min(4, maxInputImages(mode) ?? 4);
}

export const musicVideoStyleBasis = (project) => JSON.stringify(project?.styleReferences || []);

export function musicVideoStylePrompt(project, referenceCount = 0) {
  const refs = project?.styleReferences || [];
  if (!refs.length) return '';
  const treatment = project?.treatment;
  const look = treatment?.styleReferencesBasis === musicVideoStyleBasis(project) && treatment?.styleLook
    ? treatment.styleLook : refs.map((r) => r.caption?.trim()).filter(Boolean).join('; ').slice(0, 1000);
  return `${referenceCount ? `The last ${referenceCount} reference images supply style, after the identity references. ` : ''}Moodboard style only (palette, lighting, lens language and grain; never copy its subjects, locations or poses)${look ? `: ${look}` : ''}`;
}

export function musicVideoStyleImages(project, identityImages, capacity) {
  const seen = new Set(identityImages);
  const available = Math.max(0, capacity - identityImages.length);
  return (project?.styleReferences || []).filter((ref) => {
    if (!ref?.imageId || seen.has(ref.imageId)) return false;
    seen.add(ref.imageId);
    return true;
  }).slice(0, available).map((r) => r.imageId);
}

/** An explicitly selected greybox keeps a slot ahead of all other set plates. */
export function musicVideoConditioningReferences(project, scene, castMedia = null, greybox = null) {
  const references = baseConditioningReferences(project, scene, castMedia);
  if (!greybox?.reference) return references;
  // The chosen camera replaces the section's generic set plate, which shows the place from another side.
  return [greybox.reference, ...references.filter((r) => r.imageId !== greybox.reference.imageId && !r.id?.startsWith('mvr-cs-set-'))]
    .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
}

/** A frame being edited leads; the chosen shot references fill the remaining slots. */
export function musicVideoFrameReferenceFiles(leadImageId, references) {
  return [...(leadImageId ? [leadImageId] : []), ...references.map((ref) => ref.imageId).filter((id) => id !== leadImageId)]
    .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
}
