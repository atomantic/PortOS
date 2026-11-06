import { isGoodReference, pickGuideMedia, rejectedReferenceKeys, matchesReferenceVariant } from './catalogMediaLibrary.js';
import { isEditCapableMode, maxInputImages } from './imageGenCapabilities.js';
import { IMAGE_REFERENCE_REQUEST_LIMIT, MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT } from './referenceLimits.js';
import { musicVideoAllowsMedia } from './musicVideoMediaPolicy.js';
import { RUNNER_FAMILIES } from './runners.js';
import { escapeRegExp } from './textUtils.js';
import { musicVideoCameoReferences } from './musicVideoCameos.js';
import { GEMINI_WEB_CLIP_REFERENCE_LIMIT } from './geminiWebVideo.js';

/**
 * Browser-safe reference selection shared by the board and production lanes.
 * The lists here are priority-ordered (identities, then set, props, the rest)
 * and run up to MUSIC_VIDEO_MAX_REFERENCE_CHOICES; a render sends as many of
 * them, in order, as its image renderer takes (musicVideoReferenceCapacity).
 * Flagging a reference adds a candidate, never a separate fixed render quota.
 */
export const MUSIC_VIDEO_MAX_REFERENCE_CHOICES = IMAGE_REFERENCE_REQUEST_LIMIT;
export { MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT };

// The Grok CLI does not expose its underlying video-model id. Seven references
// is supported by both the older Imagine model and the newer 1.5 model.
export const MUSIC_VIDEO_GROK_CLIP_REFERENCE_LIMIT = 7;

/** Extra image slots beside the selected source frame for a video render. */
export function musicVideoClipReferenceCapacity(backend, model = null) {
  if (backend === 'grok') return MUSIC_VIDEO_GROK_CLIP_REFERENCE_LIMIT;
  if (backend === 'gemini') return GEMINI_WEB_CLIP_REFERENCE_LIMIT;
  if (backend === 'fal') {
    const max = Number(model?.referenceImages?.max) || 0;
    return Math.max(0, Math.min(MUSIC_VIDEO_MAX_REFERENCE_CHOICES, max - (model?.image ? 0 : 1)));
  }
  if (backend === 'local') {
    const images = Number(model?.maxReferenceImages) || 0;
    const total = Number(model?.maxReferenceTotal) || Infinity;
    return Math.max(0, Math.min(MUSIC_VIDEO_MAX_REFERENCE_CHOICES, images - 1, total - 1));
  }
  return 0;
}

/**
 * How many reference images one music video still can send on this renderer:
 * the cloud provider's (or model's) own input limit, Qwen Image 2.1 and
 * FLUX.3's 10, a local FLUX.2's 4; 0 for a renderer that takes no reference image.
 */
export function musicVideoReferenceCapacity(mode, { modelId = null, localModel = null } = {}) {
  if (!isEditCapableMode(mode)) return 0;
  if (mode === 'local') {
    if (localModel?.pipelineClass === 'QwenImage21Pipeline' || localModel?.runner === 'flux3') return 10;
    return localModel?.runner === RUNNER_FAMILIES.FLUX2 ? 4 : 0;
  }
  return Math.min(maxInputImages(mode, modelId) ?? MUSIC_VIDEO_MAX_REFERENCE_CHOICES, MUSIC_VIDEO_MAX_REFERENCE_CHOICES);
}

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
const CLOSE_FRAMING = /\b(extreme close|close[- ]?up|close on|tight on|selfie|arm['’]?s[- ]length|face fills)/i;

/** Whether a scene's frame or shot prompt frames a face close. */
function isCloseFraming(scene) {
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

// Only sheets that did not fit at approval are virtual choices. A published
// sheet removed later by the director must not silently reappear here.
function overflowFaceReferences(project) {
  const stage = project?.castAndSets;
  if (stage?.source === 'catalog' || stage?.status !== 'approved' || !musicVideoAllowsMedia(project, 'image') || !Array.isArray(stage.overflowFaceReferences)) return [];
  const published = new Set((project?.visualSpec?.references || []).map((ref) => ref.id));
  return stage.overflowFaceReferences.filter((ref) => ref?.id && ref.imageId && !published.has(ref.id));
}

/** The references a director can send with a shot's frames: every one with an image except outside inspiration. */
export const musicVideoReferenceChoices = (project) => [
  ...musicVideoCatalogReferences(project), ...(project?.visualSpec?.references || []), ...overflowFaceReferences(project),
].filter((ref) => ref?.id && ref.imageId && !isOutsideMusicVideoReference(ref) && !isLegacyCatalogReference(project, ref));

// Keep saved sheets and shot picks for history, but never use them for a new catalog-linked render.
export function isLegacyCatalogReference(project, ref) {
  const stage = project?.castAndSets;
  if (stage?.source !== 'catalog') return false;
  if (String(ref?.id || '').startsWith('mvr-cs-')) return true;
  // A historical generated file may since have become a current catalog asset.
  if (stage.catalogCheckin?.items?.some(item => item.images?.includes(ref?.imageId))) return false;
  return Object.values(stage.images || {}).some((image) => image?.imageId === ref?.imageId || image?.history?.includes(ref?.imageId))
    || (project?.visualSpec?.references || []).some((saved) => String(saved?.id || '').startsWith('mvr-cs-') && saved.imageId === ref?.imageId)
    || (stage.overflowFaceReferences || []).some((saved) => saved.imageId && saved.imageId === ref?.imageId);
}

// Browser-safe FNV-1a 64-bit identity. Hash the full tuple, never a truncated filename or its position.
function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const character of text) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

const catalogReferenceId = (subjectId, filename) => `mvr-catalog-${fnv1a64(JSON.stringify([subjectId, filename]))}`;

/** A linked catalog asset's id, from its whole filename: long names can share any prefix. */
export const musicVideoLinkedReferenceId = (mediaKey) => `mvr-linked-${fnv1a64(mediaKey)}`;

/**
 * Virtual choices resolved from the catalog on read, never published copies of
 * catalog images. The current catalog serves renders whether or not its check-in
 * was approved: approval is review state, not a render gate.
 */
function musicVideoCatalogReferences(project) {
  const stage = project?.castAndSets;
  const checkin = stage?.catalogCheckin;
  if (stage?.source !== 'catalog' || !checkin || !Array.isArray(checkin.problems)
    || checkin.problems.length || !Array.isArray(checkin.items)) return [];
  return checkin.items.flatMap((item) => (item.images || [])
    .filter((filename) => typeof filename === 'string' && SENDABLE_REFERENCE_FILE.test(filename))
    .map((filename) => ({
      id: catalogReferenceId(item.subjectId, filename),
      imageId: filename,
      role: ['place', 'location'].includes(item.kind) ? 'set' : item.kind === 'object' ? 'prop' : item.kind,
      label: String(item.name || 'Catalog item').slice(0, 120),
      note: String(item.description || '').slice(0, 1000),
      condition: true,
      catalogSubjectId: item.subjectId,
      ingredientId: item.ingredientId,
      formId: item.formId || null,
    }))).filter((ref) => !isLegacyCatalogReference(project, ref));
}

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
  const want = { age: variant.age, era: variant.era, wardrobeId: variant.wardrobeId, formId: variant.formId };
  const rejected = rejectedReferenceKeys(media);
  const eligible = media.filter((m) => m && !m.deleted && !rejected.has(m.mediaKey) && matchesReferenceVariant(m, want)
    && (!Object.hasOwn(variant, 'formId') || (m.library?.variant?.formId || null) === (variant.formId || null)));
  const sendable = eligible.filter((m) => typeof m?.mediaKey === 'string' && SENDABLE_REFERENCE_FILE.test(m.mediaKey));
  const flagged = eligible.some((m) => CAST_IMAGE_KINDS.has(m.kind) && m.library?.guide === true);
  const candidates = flagged ? sendable.filter((m) => m.library?.guide === true) : sendable;
  if (!candidates.length) return [];
  return pickGuideMedia(candidates, want, MUSIC_VIDEO_MAX_REFERENCE_CHOICES)
    .map((m) => {
      const v = m.library?.variant || {};
      const detail = v.label || (Number.isInteger(v.age) ? `age ${v.age}` : v.era || '');
      return {
        id: `mvr-guide-${m.mediaKey}`.length <= 128 ? `mvr-guide-${m.mediaKey}` : `mvr-guide-${fnv1a64(m.mediaKey)}`,
        imageId: m.mediaKey,
        role: 'character',
        label: `${name}${detail ? ` · ${detail}` : ''}`.slice(0, 120),
        castGuide: true,
      };
    });
}

const SHEET_ROLE = /^sheet:([^@]+)(?:@(.+))?$/;
const titleCase = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The catalog kinds a music video links, and the reference role each one plays in a shot.
const LINKED_KINDS = { character: { role: 'character', sheet: 'Character sheet', canonical: 'Portrait', fallback: 'Cast member' }, place: { role: 'set', sheet: 'Set sheet', canonical: 'Canonical image', fallback: 'Set' }, object: { role: 'prop', sheet: 'Prop sheet', canonical: 'Canonical image', fallback: 'Prop' } };

function linkedAssetDetail(m, sheet, kind) {
  if (sheet) return sheet[1] === 'standard' ? kind.sheet : `${titleCase(sheet[1])} sheet`;
  if (m.kind === 'portrait') return kind.canonical;
  const v = m.library?.variant || {};
  return v.label || (Number.isInteger(v.age) ? `age ${v.age}` : v.era || 'Reference');
}

/** The linked catalog ids (cast, sets, props) a project's shots may pick catalog assets from. */
export const musicVideoLinkedCastIds = (project) => [...new Set((project?.concept?.subjects || [])
  .filter((subject) => LINKED_KINDS[subject?.kind] && subject.ingredientId).map((subject) => subject.ingredientId))];

/**
 * Every approved asset of each character, set and prop linked from the catalog,
 * as extra choices for a shot's picker. Approved means the canonical image, a
 * render guide, a reference rated good, or a sheet, and never one rated bad or
 * left out of likeness. A subject linked at an age or look offers that form's
 * assets only; otherwise it offers the canonical ones. These never join the
 * automatic set, so a new sheet changes no shot until the director picks it.
 */
export function musicVideoLinkedCastReferences(project, castMedia) {
  const seen = new Set();
  return (project?.concept?.subjects || []).flatMap((subject) => {
    const kind = LINKED_KINDS[subject?.kind];
    const media = kind && castMedia?.[subject.ingredientId];
    if (!Array.isArray(media)) return [];
    const rejected = rejectedReferenceKeys(media);
    const formId = subject.castForm?.id || null;
    const assets = media.map((m) => ({ m, sheet: SHEET_ROLE.exec(m?.role || '') })).filter(({ m, sheet }) => m && !m.deleted
      && CAST_IMAGE_KINDS.has(m.kind) && typeof m.mediaKey === 'string' && SENDABLE_REFERENCE_FILE.test(m.mediaKey)
      && !rejected.has(m.mediaKey) && !String(m.role || '').startsWith('archive:')
      && (m.library?.variant?.formId || sheet?.[2] || null) === formId
      && (sheet || m.kind === 'portrait' || m.library?.guide === true || isGoodReference(m)));
    const rank = ({ m, sheet }) => (m.kind === 'portrait' ? 0 : sheet ? 1 : 2);
    return [...assets].sort((a, b) => rank(a) - rank(b)).filter(({ m }) => !seen.has(m.mediaKey) && seen.add(m.mediaKey))
      .map(({ m, sheet }) => ({
        id: musicVideoLinkedReferenceId(m.mediaKey),
        imageId: m.mediaKey,
        role: kind.role,
        label: `${subject.name || kind.fallback} · ${linkedAssetDetail(m, sheet, kind)}`.slice(0, 120),
        // Only a cast member's images are recorded as cast guides on the take.
        ...(kind.role === 'character' ? { castGuide: true } : {}),
        linkedCast: true,
      }));
  }).filter((ref) => !isLegacyCatalogReference(project, ref));
}

/** A saved pick of a catalog asset, which only resolves once its cast member's media loads. */
export const isCatalogMediaReferenceId = (id) => /^mvr-(guide|linked)-/.test(String(id));

/** The cast members whose media this scene's saved references need before they can resolve or render. */
export function musicVideoSceneCastIds(project, scene) {
  const variant = sceneCastVariant(scene);
  const picksLinked = [scene?.frameReferenceIds, scene?.clipReferenceIds]
    .some((ids) => Array.isArray(ids) && ids.some((id) => String(id).startsWith('mvr-linked-')));
  return [...new Set([...(variant ? [variant.ingredientId] : []), ...(picksLinked ? musicVideoLinkedCastIds(project) : [])])];
}

/**
 * A shot's picked catalog assets (guides included) that do not resolve: their cast media failed to
 * load, or the asset has since left the catalog's approved set. Resolving would
 * silently drop them, so a frame render must stop instead of spending a take.
 */
export function musicVideoMissingFrameLinkedPicks(project, scene, castMedia) {
  if (!Array.isArray(scene?.frameReferenceIds)) return [];
  const choices = [...musicVideoLinkedCastReferences(project, castMedia), ...musicVideoCastGuideReferences(project, scene, castMedia)]
    .filter((ref) => !isLegacyCatalogReference(project, ref));
  return scene.frameReferenceIds.filter((id) => isCatalogMediaReferenceId(id) && !choices.some((ref) => ref.id === id));
}

/** What a picker offers: the linked cast first, minus any image the project's own references already offer. */
export function musicVideoOfferedReferences(choices) {
  const own = choices.filter((ref) => !ref.linkedCast);
  return [...choices.filter((ref) => ref.linkedCast && !own.some((other) => other.imageId === ref.imageId)), ...own];
}

/**
 * The references a scene's frames condition on, in priority order, capped at
 * `limit` (the renderer's capacity when known). Explicit `frameReferenceIds` win;
 * otherwise the cast guides of the scene's `characterVariant` lead and the
 * automatic set fills the remaining slots. `castMedia` is optional: without it
 * (or without a variant) the result is the automatic set alone.
 */
function baseConditioningReferences(project, scene, castMedia = null, limit = MUSIC_VIDEO_MAX_REFERENCE_CHOICES) {
  const research = musicVideoResearchReferences(scene).filter((ref) => !isLegacyCatalogReference(project, ref));
  // A roster cameo's photos (#14821) are the shot's identity references, ahead of any cast guide.
  const guides = [...musicVideoCameoReferences(project, scene), ...musicVideoCastGuideReferences(project, scene, castMedia)]
    .filter((ref) => !isLegacyCatalogReference(project, ref));
  const panel = musicVideoPanelArtReferences(scene).filter((ref) => !isLegacyCatalogReference(project, ref));
  // The director's own pick for this shot (the shot card's References row) wins over the automatic set.
  if (Array.isArray(scene?.frameReferenceIds)) {
    const choices = [...research, ...guides, ...panel, ...musicVideoReferenceChoices(project), ...musicVideoLinkedCastReferences(project, castMedia)]
      .filter((ref) => !isLegacyCatalogReference(project, ref));
    return scene.frameReferenceIds.map((id) => choices.find((ref) => ref.id === id)).filter(Boolean)
      .slice(0, limit);
  }
  const automatic = automaticConditioningReferences(project, scene, limit);
  // Researched photos of the shot's subject lead: they are what the shot must show accurately.
  const chosen = [...research, ...guides, ...automatic];
  const unique = chosen.filter((ref, i) => chosen.findIndex((r) => r.imageId === ref.imageId) === i);
  if (!panel.length) return unique.slice(0, limit);
  // The storyboard panel keeps a slot; identities fill the rest.
  return [...unique.filter((ref) => ref.imageId !== panel[0].imageId).slice(0, Math.max(0, limit - 1)), ...panel];
}

/**
 * The real photos a shot's Research and seed step imported (#14822), as
 * references labelled with the director's own subject text. Their source
 * links stay on the record for the director; only the image is sent.
 */
export function musicVideoResearchReferences(scene) {
  if (!Array.isArray(scene?.researchReferences)) return [];
  return scene.researchReferences
    .filter((ref) => typeof ref?.id === 'string' && typeof ref.imageId === 'string' && SENDABLE_REFERENCE_FILE.test(ref.imageId))
    .map((ref) => ({ id: ref.id, imageId: ref.imageId, role: 'subject', label: String(ref.subject || 'Subject').slice(0, 120), research: true,
      sourceUrl: ref.sourceUrl || null, pageUrl: ref.pageUrl || null }));
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

/** Match only subjects the shot actually identifies; an unknown or missing selection never means everybody. */
function sceneCatalogSubjectIds(project, scene) {
  const items = project?.castAndSets?.catalogCheckin?.items || [];
  const sheet = scene?.shotSheet;
  const text = [scene?.description, scene?.framePrompt, scene?.prompt, scene?.visualIntent,
    scene?.direction?.frameClause, scene?.direction?.motionClause, sheet?.action, sheet?.location,
    sheet?.view, /selfie/i.test(sheet?.view || '') ? sheet?.holder : null].filter(Boolean).join(' ');
  const variant = sceneCastVariant(scene);
  const direction = project?.castAndSets?.direction;
  const mappedSetId = Number.isInteger(scene?.sectionIndex)
    ? direction?.songMap?.find(entry => entry.section === scene.sectionIndex)?.setId : null;
  const mappedSet = direction?.sets?.find(set => set.id === mappedSetId);
  const matches = items.filter(item => {
    const subject = project?.concept?.subjects?.find(entry => entry.id === item.subjectId);
    const names = [item.name, subject?.name].filter(Boolean);
    const named = names.some(name => namesIn(text, name));
    if (item.kind === 'character') {
      if (variant && variant.ingredientId === item.ingredientId) {
        // Internal/legacy scenes can carry an exact look. Never let a name match undo that selection.
        return !Object.hasOwn(variant, 'formId') || (item.formId || null) === (variant.formId || null);
      }
      if (Array.isArray(sheet?.characters)) {
        return sheet.characters.some(name => [item.subjectId, item.ingredientId, ...names].some(value =>
          String(value || '').toLowerCase() === name.toLowerCase()));
      }
      const cast = direction?.cast?.find(entry => entry.id === item.subjectId || names.includes(entry.name));
      return named || (cast && namesIn(text, cast.role));
    }
    if (['place', 'location'].includes(item.kind)) {
      if (scene?.setReference?.subjectId) return scene.setReference.subjectId === item.subjectId;
      if (sheet?.location) return names.some(name => namesIn(sheet.location, name));
      return named || (mappedSetId && (mappedSetId === item.subjectId || mappedSet?.setReference?.subjectId === item.subjectId
        || names.includes(mappedSet?.name)));
    }
    return named || (item.kind === 'object' && names.some(name => showsProp({ props: [{ name }] }, { prompt: text })));
  });
  const priority = item => item.kind === 'character' ? (variant && variant.ingredientId === item.ingredientId ? 0 : 1)
    : ['place', 'location'].includes(item.kind) ? 2 : 3;
  return matches.sort((a, b) => priority(a) - priority(b)).map(item => item.subjectId);
}

function automaticConditioningReferences(project, scene, limit = MUSIC_VIDEO_MAX_REFERENCE_CHOICES) {
  if (project?.castAndSets?.source === 'catalog') {
    const choices = musicVideoReferenceChoices(project).filter((ref) => ref.condition);
    const subjects = new Map();
    for (const subjectId of sceneCatalogSubjectIds(project, scene)) {
      subjects.set(subjectId, choices.filter(ref => ref.catalogSubjectId === subjectId));
    }
    const selected = [];
    const seen = new Set();
    // Each subject gets its next distinct image before any subject gets another slot.
    while ([...subjects.values()].some(refs => refs.length)) {
      for (const refs of subjects.values()) {
        while (refs.length && seen.has(refs[0].imageId)) refs.shift();
        const ref = refs.shift();
        if (!ref) continue;
        selected.push(ref);
        seen.add(ref.imageId);
      }
    }
    for (const ref of choices.filter(ref => !ref.catalogSubjectId)) {
      if (seen.has(ref.imageId)) continue;
      selected.push(ref);
      seen.add(ref.imageId);
    }
    return selected.slice(0, limit);
  }
  const references = [...(project?.visualSpec?.references || []), ...overflowFaceReferences(project)];
  const stage = project?.castAndSets;
  // Legacy projects and incomplete check-ins retain the authored reference set.
  const authored = references.filter((ref) => ref?.condition && ref.imageId && !isOutsideMusicVideoReference(ref));
  const character = stage?.status === 'approved' && references.find((ref) => ref?.id === 'mvr-cs-character' && ref.imageId);
  if (character) {
    const setId = Number.isInteger(scene?.sectionIndex)
      ? stage.direction?.songMap?.find((entry) => entry.section === scene.sectionIndex)?.setId : null;
    const plate = setId && references.find((ref) => ref?.id === `mvr-cs-set-${setId}` && ref.imageId);
    // Check-in plates are selected by scene relevance, rather than sending
    // every plate flagged on the project. A supporting cast member's sheet
    // joins the shots that name them, and so does a director's own reference whose
    // label names someone the shot names.
    const featured = featuredCast(stage.direction, scene);
    const cast = featured
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
      const people = [[character, faceOf('mvr-cs-expressions')], ...featured.map((person) => [
        faceOf(`mvr-cs-cast-${person.id}`.slice(0, 64)), faceOf(`mvr-cs-face-${person.id}`.slice(0, 64)),
      ])];
      const close = [...people.flat().filter(Boolean), ...featuredAuthoredCharacters(references, scene), ...(props ? [props] : []), ...(plate ? [plate] : authored)];
      return close.filter((ref, i) => close.findIndex((r) => r.imageId === ref.imageId) === i).slice(0, limit);
    }
    const chosen = plate
      ? [character, plate, ...cast, ...featuredAuthoredCharacters(references, scene), ...(props ? [props] : [])]
      : [character, ...cast, ...featuredAuthoredCharacters(references, scene), ...(props ? [props] : []), ...authored];
    return chosen.filter((ref, i) => chosen.findIndex((r) => r.imageId === ref.imageId) === i)
      .slice(0, limit);
  }
  return authored.slice(0, limit);
}

/** Style images fill spare slots after identities; never displace a character or set. */
export function musicVideoStyleReferenceCapacity(mode, localModel, modelId = null) {
  return musicVideoReferenceCapacity(mode, { modelId, localModel });
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
export function musicVideoConditioningReferences(project, scene, castMedia = null, greybox = null, { limit = MUSIC_VIDEO_MAX_REFERENCE_CHOICES } = {}) {
  const references = baseConditioningReferences(project, scene, castMedia);
  // The chosen camera replaces the section's generic set plate, which shows the place from another side.
  const ordered = greybox?.reference
    ? [greybox.reference, ...references.filter((r) => r.imageId !== greybox.reference.imageId && !r.id?.startsWith('mvr-cs-set-') && !(r.catalogSubjectId && r.role === 'set'))]
    : references;
  const current = ordered.filter((ref) => !isLegacyCatalogReference(project, ref));
  const panel = !Array.isArray(scene?.frameReferenceIds) && current.find((ref) => ref.panelArt);
  const ids = musicVideoLimitReferenceFiles(current.map((ref) => ref.imageId), limit, {
    panelImageId: panel?.imageId, protectedCount: greybox?.reference ? 1 : 0,
  });
  const remaining = [...current];
  return ids.map((id) => remaining.splice(remaining.findIndex((ref) => ref.imageId === id), 1)[0]);
}

/**
 * A clip can choose its own ordered references. Legacy/Auto retains the cast
 * references previously derived from the frame selection; an explicit empty
 * list means no extra images. The selected source frame is not repeated.
 */
export function musicVideoClipConditioningReferences(project, scene, castMedia = null, { limit = MUSIC_VIDEO_MAX_REFERENCE_CHOICES } = {}) {
  const explicit = Array.isArray(scene?.clipReferenceIds);
  const source = explicit ? { ...scene, frameReferenceIds: scene.clipReferenceIds } : scene;
  return musicVideoConditioningReferences(project, source, castMedia)
    .filter((ref) => !ref.panelArt && !ref.greybox && ref.imageId !== scene?.referenceImageId
      && (explicit || ref.role === 'character' || ref.role === 'subject'))
    .filter((ref, index, refs) => refs.findIndex((other) => other.imageId === ref.imageId) === index)
    .slice(0, Math.max(0, limit));
}

/** References that may be selected independently for a clip. */
export function musicVideoClipReferenceChoices(project, scene, castMedia = null) {
  return [...musicVideoResearchReferences(scene), ...musicVideoCameoReferences(project, scene), ...musicVideoCastGuideReferences(project, scene, castMedia), ...musicVideoReferenceChoices(project), ...musicVideoLinkedCastReferences(project, castMedia)]
    .filter((ref) => !isLegacyCatalogReference(project, ref));
}

/** Keep an automatic storyboard panel in a spare slot after a leading frame or greybox. */
export function musicVideoLimitReferenceFiles(files, limit, { panelImageId = null, protectedCount = 0 } = {}) {
  const selected = files.slice(0, limit);
  if (panelImageId && limit > protectedCount && files.includes(panelImageId) && !selected.includes(panelImageId)) {
    selected[selected.length - 1] = panelImageId;
  }
  return selected;
}

/** A frame being edited leads; the chosen shot references fill the remaining slots. */
export function musicVideoFrameReferenceFiles(leadImageId, references, limit = MUSIC_VIDEO_MAX_REFERENCE_CHOICES, { reservePanel = false } = {}) {
  const files = [...(leadImageId ? [leadImageId] : []), ...references.map((ref) => ref.imageId).filter((id) => id !== leadImageId)];
  const panelImageId = reservePanel ? references.find((ref) => ref.panelArt)?.imageId : null;
  const protectedCount = (leadImageId ? 1 : 0) + (references.some((ref) => ref.greybox && ref.imageId !== leadImageId) ? 1 : 0);
  return musicVideoLimitReferenceFiles(files, limit, { panelImageId, protectedCount });
}
