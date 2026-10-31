import { musicVideoCastGuideReferences } from './musicVideoConditioning.js';

/**
 * Cast inputs recorded on a music-video still (#14154).
 *
 * A frame's take stores the Casting guide keys and Cast & Sets sheet ids it
 * was actually conditioned on, beside `dependencies` rather than inside them.
 * Evidence capture copies `dependencies.references` and an unknown role reads
 * as a change, which would mark every render stale. Absence of `castInputs`
 * is an older take: unknown, not stale. Nothing here re-renders a shot.
 */

const MAX_CAST_INPUTS = 8;

function uniqueStrings(values, max) {
  const out = [];
  for (const value of values || []) {
    if (typeof value !== 'string' || !value || out.includes(value)) continue;
    out.push(value);
    if (out.length === max) break;
  }
  return out;
}

/** The cast guides and Cast & Sets sheets among the references a frame submit actually sent. */
export function castInputsFromReferences(scene, references) {
  const guides = [];
  const sheets = [];
  for (const ref of references || []) {
    if (ref?.castGuide && typeof ref.imageId === 'string' && ref.imageId && !guides.includes(ref.imageId)) guides.push(ref.imageId);
    const id = typeof ref?.id === 'string' ? ref.id : '';
    if (id.startsWith('mvr-cs-') && typeof ref.imageId === 'string' && ref.imageId && !sheets.some((sheet) => sheet.id === id)) {
      sheets.push({ id, imageId: ref.imageId });
    }
  }
  const ingredientId = typeof scene?.characterVariant?.ingredientId === 'string' && scene.characterVariant.ingredientId
    ? scene.characterVariant.ingredientId : null;
  return {
    ingredientId: ingredientId ? ingredientId.slice(0, 200) : null,
    guides: guides.slice(0, MAX_CAST_INPUTS),
    sheets: sheets.slice(0, MAX_CAST_INPUTS),
  };
}

/**
 * A stored snapshot, or null when the caller did not record one.
 * An empty guide and sheet list is a real snapshot (the frame used neither).
 */
export function musicVideoCastInputsRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sheets = [];
  for (const sheet of Array.isArray(value.sheets) ? value.sheets : []) {
    if (!sheet || typeof sheet.id !== 'string' || typeof sheet.imageId !== 'string' || !sheet.id || !sheet.imageId) continue;
    if (sheets.some((kept) => kept.id === sheet.id)) continue;
    sheets.push({ id: sheet.id.slice(0, 80), imageId: sheet.imageId.slice(0, 256) });
    if (sheets.length === MAX_CAST_INPUTS) break;
  }
  const ingredientId = typeof value.ingredientId === 'string' && value.ingredientId ? value.ingredientId.slice(0, 200) : null;
  return { ingredientId, guides: uniqueStrings(value.guides, MAX_CAST_INPUTS), sheets };
}

/**
 * `unknown` — no snapshot, or recorded guides whose catalog media is not loaded.
 * `current` — every guide key is still a guide, and every sheet id still has the same image.
 * `older` — a used guide is no longer a guide, or a used sheet's image changed or is gone.
 * A sheet can be judged from the project alone. Guide media that is still loading
 * (`undefined`) or failed (`null`) stays unknown so a board does not flash a false mark.
 */
export function castLookForTake(project, scene, take, castMedia) {
  if (!take || !Object.hasOwn(take, 'castInputs')) return { status: 'unknown' };
  const inputs = musicVideoCastInputsRecord(take.castInputs);
  if (!inputs) return { status: 'unknown' };
  const references = project?.visualSpec?.references || [];
  const sheetOlder = inputs.sheets.some((sheet) => {
    const current = references.find((ref) => ref?.id === sheet.id);
    return !current || current.imageId !== sheet.imageId;
  });
  if (sheetOlder) return { status: 'older' };
  if (!inputs.guides.length) return { status: 'current' };
  const ingredientId = scene?.characterVariant?.ingredientId;
  const media = ingredientId && castMedia ? castMedia[ingredientId] : undefined;
  if (!Array.isArray(media)) return { status: 'unknown' };
  const current = new Set(musicVideoCastGuideReferences(project, scene, castMedia).map((ref) => ref.imageId));
  return { status: inputs.guides.some((key) => !current.has(key)) ? 'older' : 'current' };
}
