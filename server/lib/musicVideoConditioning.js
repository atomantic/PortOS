import { pickGuideMedia } from './catalogMediaLibrary.js';
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
  return pickGuideMedia(media, { age: variant.age, era: variant.era, wardrobeId: variant.wardrobeId }, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES)
    // Frame renders name references by basename (routes/imageGen.js), so a nested key cannot be sent.
    .filter((m) => typeof m.mediaKey === 'string' && m.mediaKey && !/[/\\]/.test(m.mediaKey))
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
export function musicVideoConditioningReferences(project, scene, castMedia = null) {
  const guides = musicVideoCastGuideReferences(project, scene, castMedia);
  // The director's own pick for this shot (the shot card's References row) wins over the automatic set.
  if (Array.isArray(scene?.frameReferenceIds)) {
    const choices = [...guides, ...musicVideoReferenceChoices(project)];
    return scene.frameReferenceIds.map((id) => choices.find((ref) => ref.id === id)).filter(Boolean)
      .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
  }
  const automatic = automaticConditioningReferences(project, scene);
  if (!guides.length) return automatic;
  const chosen = [...guides, ...automatic];
  return chosen.filter((ref, i) => chosen.findIndex((r) => r.imageId === ref.imageId) === i)
    .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
}

function automaticConditioningReferences(project, scene) {
  const references = project?.visualSpec?.references || [];
  const stage = project?.castAndSets;
  if (stage?.status === 'approved' && Number.isInteger(scene?.sectionIndex)) {
    const setId = stage.direction?.songMap?.find((entry) => entry.section === scene.sectionIndex)?.setId;
    const character = references.find((ref) => ref?.id === 'mvr-cs-character' && ref.imageId);
    const plate = setId && references.find((ref) => ref?.id === `mvr-cs-set-${setId}` && ref.imageId);
    // Check-in plates and cast sheets beyond the project-wide cap are still
    // available for their own scenes. Their condition flag reflects that cap,
    // not scene relevance. A supporting cast member's sheet joins the shots
    // that name them, and so does a director's own character reference whose
    // label names someone the shot names.
    if (character && plate) {
      const cast = featuredCast(stage.direction, scene)
        .map((c) => references.find((ref) => ref?.id === `mvr-cs-cast-${c.id}`.slice(0, 64) && ref.imageId))
        .filter(Boolean);
      const chosen = [character, plate, ...cast, ...featuredAuthoredCharacters(references, scene)];
      return chosen.filter((ref, i) => chosen.findIndex((r) => r.imageId === ref.imageId) === i)
        .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
    }
  }
  // Legacy projects and incomplete check-ins retain the authored reference set.
  return references.filter((ref) => ref?.condition && ref.imageId && !isOutsideMusicVideoReference(ref))
    .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
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
