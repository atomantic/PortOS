// Current check-in items resolve from catalog identities. Generated stage media
// remains historical evidence and is never an input to this projection.
import { createHash } from 'node:crypto';
import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
import { ServerError } from '../../lib/errorHandler.js';
import { characterSheetReferenceCandidates } from '../../lib/characterSheetReferences.js';
import { pickGuideMedia } from '../../lib/catalogMediaLibrary.js';
import { resolveGalleryImage, resolveImageRef } from '../../lib/pathSafety.js';

export const isCatalogCheckin = project => project?.castAndSets?.source === 'catalog';
const TYPES = new Set(['character', 'place', 'object']);
const existsOnDisk = filename => !!(resolveGalleryImage(filename) || resolveImageRef(filename));

export async function resolveCatalogCheckin(project, { catalog, exists = existsOnDisk, client } = {}) {
  const allowsImages = musicVideoAllowsMedia(project, 'image');
  const subjects = (project?.concept?.subjects || []).filter(subject => TYPES.has(subject?.kind));
  const items = [];
  const problems = [];
  const records = new Map();
  const db = catalog || (subjects.some(subject => subject.ingredientId) ? await import('../catalogDB.js') : null);
  for (const subject of subjects) {
    const item = { subjectId: subject.id, ingredientId: subject.ingredientId || null, formId: subject.castForm?.id || null, formLabel: null,
      kind: subject.kind, name: subject.name || '', description: '', images: [] };
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
    // Scope before guide precedence: an unrelated canonical guide must not hide
    // a valid image belonging to the explicitly selected age or look.
    const scopedRows = item.formId ? rows.filter(row => row.library?.variant?.formId === item.formId) : rows;
    const candidates = !allowsImages ? [] : subject.kind === 'character'
      ? characterSheetReferenceCandidates(payload, scopedRows, item.formId ? { formId: item.formId } : {}).filter(candidate => !candidate.leftOut && (!item.formId || candidate.scope === 'form')).map(candidate => candidate.filename)
      : pickGuideMedia(rows).map(row => row.mediaKey);
    item.images = allowsImages ? [...new Set(candidates.filter(exists))] : [];
    if (allowsImages && !item.images.length) problem('CATALOG_IMAGES_REQUIRED', `Add a usable image to ${item.name}${item.formId ? "'s selected catalog look" : ' in the catalog'}.`);
  }
  if (!items.length) problems.push({ subjectId: null, code: 'CATALOG_SUBJECTS_REQUIRED', message: 'Add cast, environments or objects from the catalog before approving.' });
  const basis = createHash('sha256').update(JSON.stringify({ items, problems, concept: project?.concept?.prompt || '',
    song: [project?.trackId || null, project?.uploadedAudioFilename || null] })).digest('hex');
  return { items, problems, basis, approved: isCatalogCheckin(project) && project.castAndSets.status === 'approved'
    && !problems.length && project.castAndSets.catalogApprovedBasis === basis };
}

/** Read-time only. Never persist the resolved media or presentation fields. */
export async function withCatalogCheckin(project, options) {
  if (!isCatalogCheckin(project)) return project;
  return { ...project, castAndSets: { ...project.castAndSets, catalogCheckin: await resolveCatalogCheckin(project, options) } };
}

export function assertCatalogCheckinReady(checkin) {
  if (!checkin || checkin.problems.length) throw new ServerError(checkin?.problems.map(problem => problem.message).join(' ') || 'Reload the catalog check-in before approving.',
    { status: 409, code: 'CAST_SETS_CATALOG_UNRESOLVED', context: { problems: checkin?.problems || [] } });
}

export function assertLegacyCheckin(project) {
  if (isCatalogCheckin(project)) throw new ServerError('This check-in links directly to the catalog. Edit its cast, environments and objects in the catalog.', { status: 409, code: 'CAST_SETS_CATALOG_ONLY' });
}
