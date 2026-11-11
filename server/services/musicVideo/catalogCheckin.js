// Current check-in items resolve from catalog identities. Generated stage media
// remains historical evidence and is never an input to this projection.
import { createHash } from 'node:crypto';
import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
import { ServerError } from '../../lib/errorHandler.js';
import { characterSheetReferenceCandidates } from '../../lib/characterSheetReferences.js';
import { listPickableImages, pickGuideMedia } from '../../lib/catalogMediaLibrary.js';
import { resolveGalleryImage, resolveImageRef } from '../../lib/pathSafety.js';
import { musicVideoCatalogPickPlans, musicVideoCatalogReferenceId } from '../../lib/musicVideoConditioning.js';
import { shotNumbers } from '../../lib/musicVideoColdOpen.js';
import { musicVideoShotReferenceChecks } from './shotReferenceCheck.js';

export const isCatalogCheckin = project => project?.castAndSets?.source === 'catalog';
const TYPES = new Set(['character', 'place', 'object']);
const existsOnDisk = filename => !!(resolveGalleryImage(filename) || resolveImageRef(filename));

// Kept apart from `problems`, which refuse every render and empty the catalog
// choices: one shot's pick must not stop the others. Outside `basis` too, so
// editing a shot's references never invalidates approval or a prepared render.
function shotReferenceReport(project, items, problems) {
  if (!isCatalogCheckin(project)) return { shotReferenceProblems: [], movableShotReferences: 0 };
  const plans = musicVideoCatalogPickPlans({ ...project, castAndSets: { ...project.castAndSets, catalogCheckin: { items, problems } } });
  const scenes = project.scenes || [];
  const numbers = shotNumbers(project);
  return {
    movableShotReferences: plans.reduce((total, plan) => total + plan.moved, 0),
    shotReferenceProblems: plans.filter(plan => plan.unmapped.length).map(({ sceneId, unmapped }) => {
      const shot = numbers.get(sceneId) ?? scenes.findIndex(scene => scene.sceneId === sceneId) + 1;
      const label = scenes.find(scene => scene.sceneId === sceneId)?.label;
      const references = [...new Set(unmapped.map(ref => ref.label || ref.role || 'a saved reference'))];
      const them = references.length === 1 ? 'it' : 'them';
      return { sceneId, shot, references,
        message: `Shot ${shot}${label && label !== `Shot ${shot}` ? ` · ${label}` : ''}: the catalog check-in does not offer ${references.join(', ')}, so new renders cannot send ${them}. Offer ${them} on the catalog record, or pick a replacement on the shot.` };
    }),
  };
}

/** Move each shot's saved generated sheets to the catalog id for the same image. Needs a resolved check-in. */
export function remapCatalogShotReferences(project) {
  const plans = new Map(musicVideoCatalogPickPlans(project).filter(plan => plan.moved).map(plan => [plan.sceneId, plan]));
  if (!plans.size) return { project, moved: 0 };
  const scenes = project.scenes.map((scene) => {
    const plan = plans.get(scene.sceneId);
    if (!plan) return scene;
    return { ...scene, ...(plan.frameReferenceIds ? { frameReferenceIds: plan.frameReferenceIds } : {}), ...(plan.clipReferenceIds ? { clipReferenceIds: plan.clipReferenceIds } : {}) };
  });
  return { project: { ...project, scenes }, moved: [...plans.values()].reduce((total, plan) => total + plan.moved, 0) };
}

/**
 * Clear shot picks of catalog images that can never render again, in the same
 * write: every pick of a subject `next` removes, and, when the check-in resolved
 * cleanly, any catalog pick its records no longer hold at all (a deleted image,
 * or a subject removed before). Images still on a record but not offered stay
 * picked, so their warning names them. `current` carries the resolved check-in.
 */
export function dropStaleCatalogPicks(current, next) {
  const checkin = current?.castAndSets?.catalogCheckin;
  if (!isCatalogCheckin(next) || !checkin?.items || !Array.isArray(next?.scenes) || !musicVideoAllowsMedia(current, 'image')) return next;
  const kept = new Set((next.concept?.subjects || []).map(subject => subject?.id));
  const ids = items => new Set(items.flatMap(item => [...(item.images || []), ...(item.pickableImages || []), ...(item.retiredImages || [])]
    .map(filename => musicVideoCatalogReferenceId(item.subjectId, filename))));
  const held = ids(checkin.items.filter(item => kept.has(item.subjectId)));
  const removed = ids(checkin.items.filter(item => !kept.has(item.subjectId)));
  const clean = !checkin.problems?.length;
  const stale = id => typeof id === 'string' && id.startsWith('mvr-catalog-') && !held.has(id) && (clean || removed.has(id));
  let changed = false;
  const prune = ids => {
    if (!Array.isArray(ids) || !ids.some(stale)) return ids;
    changed = true;
    return ids.filter(id => !stale(id));
  };
  const scenes = next.scenes.map(scene => {
    const frameReferenceIds = prune(scene?.frameReferenceIds);
    const clipReferenceIds = prune(scene?.clipReferenceIds);
    if (frameReferenceIds === scene?.frameReferenceIds && clipReferenceIds === scene?.clipReferenceIds) return scene;
    return { ...scene, ...(Array.isArray(frameReferenceIds) ? { frameReferenceIds } : {}), ...(Array.isArray(clipReferenceIds) ? { clipReferenceIds } : {}) };
  });
  return changed ? { ...next, scenes } : next;
}

export async function resolveCatalogCheckin(project, {
  catalog, exists = existsOnDisk, client, includeShotChecks = true, includeRepairPatches = false,
} = {}) {
  const allowsImages = musicVideoAllowsMedia(project, 'image');
  const subjects = (project?.concept?.subjects || []).filter(subject => TYPES.has(subject?.kind));
  const items = [];
  const problems = [];
  const records = new Map();
  const shotMedia = Object.create(null);
  const db = catalog || (subjects.some(subject => subject.ingredientId) ? await import('../catalogDB.js') : null);
  for (const subject of subjects) {
    const item = { subjectId: subject.id, ingredientId: subject.ingredientId || null, formId: subject.castForm?.id || null, formLabel: null,
      kind: subject.kind, name: subject.name || '', description: '', images: [], pickableImages: [], retiredImages: [] };
    items.push(item);
    const problem = (code, message) => problems.push({ subjectId: subject.id, code, message });
    if (!subject.ingredientId) { problem('CATALOG_LINK_REQUIRED', `Link ${item.name || 'this subject'} to a catalog record.`); continue; }
    if (!records.has(subject.ingredientId)) {
      records.set(subject.ingredientId, Promise.all([db.getIngredient(subject.ingredientId, { client }), allowsImages ? db.listMediaForIngredient(subject.ingredientId, { client }) : Promise.resolve([])])
        .catch(() => null));
    }
    const loaded = await records.get(subject.ingredientId);
    if (!loaded) { problem('CATALOG_UNAVAILABLE', `The catalog for ${item.name} could not be read. Try again when it is available.`); continue; }
    const [record, media] = loaded;
    if (!record || record.deleted || record.type !== subject.kind) { problem('CATALOG_RECORD_MISSING', `Restore or relink the catalog record for ${item.name}.`); continue; }
    item.ingredientId = record.id;
    item.name = record.name || item.name;
    const payload = record.payload || {};
    const form = item.formId ? (payload.forms || []).find(candidate => candidate.id === item.formId) : null;
    if (item.formId && !form) { problem('CATALOG_FORM_MISSING', `Choose an existing catalog look for ${item.name}.`); continue; }
    item.formLabel = form?.label || null;
    item.description = String(form ? form.description || '' : payload[subject.kind === 'character' ? 'physicalDescription' : 'description'] || payload.description || '');
    const rows = (media || []).filter(row => !row.deleted && exists(row.mediaKey));
    shotMedia[subject.ingredientId] = rows;
    shotMedia[item.ingredientId] = rows;
    // Scope before guide precedence: an unrelated canonical guide must not hide
    // a valid image belonging to the explicitly selected age or look.
    const scopedRows = item.formId ? rows.filter(row => row.library?.variant?.formId === item.formId) : rows;
    const candidates = !allowsImages ? [] : subject.kind === 'character'
      ? characterSheetReferenceCandidates(payload, scopedRows, item.formId ? { formId: item.formId } : {}).filter(candidate => !candidate.leftOut && (!item.formId || candidate.scope === 'form')).map(candidate => candidate.filename)
      : pickGuideMedia(rows).map(row => row.mediaKey);
    item.images = allowsImages ? [...new Set(candidates.filter(exists))] : [];
    // Environments and objects: every other usable image stays choosable for an explicit shot pick,
    // but Auto only conditions on `images` (the 4-image budget). Character picks keep form scoping.
    item.pickableImages = allowsImages && subject.kind !== 'character'
      ? [...new Set(listPickableImages(media).map(row => row.mediaKey).filter(key => exists(key) && !item.images.includes(key)))] : [];
    // Still on the record (even a file missing on disk) but not offered: a stale pick names it and is not cleared.
    item.retiredImages = allowsImages ? [...new Set((media || []).filter(row => !row.deleted).map(row => row.mediaKey).filter(key => typeof key === 'string' && !item.images.includes(key) && !item.pickableImages.includes(key)))] : [];
    if (allowsImages && !item.images.length) problem('CATALOG_IMAGES_REQUIRED', `Add a usable image to ${item.name}${item.formId ? "'s selected catalog look" : ' in the catalog'}.`);
  }
  if (!items.length) problems.push({ subjectId: null, code: 'CATALOG_SUBJECTS_REQUIRED', message: 'Add cast, environments or objects from the catalog before approving.' });
  // `retiredImages` and `pickableImages` stay out of the basis: they widen the choice list for explicit
  // shot picks without changing the Auto set, so adding an image never stales an approval.
  const basis = createHash('sha256').update(JSON.stringify({ items: items.map(({ retiredImages: _retired, pickableImages: _pickable, ...item }) => item), problems, concept: project?.concept?.prompt || '',
    song: [project?.trackId || null, project?.uploadedAudioFilename || null] })).digest('hex');
  const report = shotReferenceReport(project, items, problems);
  if (includeShotChecks && isCatalogCheckin(project) && allowsImages) {
    const resolved = { ...project, castAndSets: { ...project.castAndSets, catalogCheckin: { items, problems } } };
    const checks = await musicVideoShotReferenceChecks(resolved, shotMedia);
    report.shotReferenceProblems.push(...(includeRepairPatches ? checks : checks.map(({ patch: _patch, ...row }) => row)));
  }
  return { items, problems, basis, approved: isCatalogCheckin(project) && project.castAndSets.status === 'approved'
    && !problems.length && project.castAndSets.catalogApprovedBasis === basis, ...report };
}

/** Read-time only. Never persist the resolved media or presentation fields. */
export async function withCatalogCheckin(project, options) {
  if (!isCatalogCheckin(project)) return project;
  return { ...project, castAndSets: { ...project.castAndSets, catalogCheckin: await resolveCatalogCheckin(project, { includeShotChecks: false, ...options }) } };
}

export function assertCatalogCheckinReady(checkin) {
  if (!checkin || checkin.problems.length) throw new ServerError(checkin?.problems.map(problem => problem.message).join(' ') || 'Reload the catalog check-in before approving.',
    { status: 409, code: 'CAST_SETS_CATALOG_UNRESOLVED', context: { problems: checkin?.problems || [] } });
}

export function assertLegacyCheckin(project) {
  if (isCatalogCheckin(project)) throw new ServerError('This check-in links directly to the catalog. Edit its cast, environments and objects in the catalog.', { status: 409, code: 'CAST_SETS_CATALOG_ONLY' });
}
