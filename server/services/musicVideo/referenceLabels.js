// Names a look reference after the Casting, Environments or Objects record its
// image belongs to, so a sheet picked from the gallery or a mood board reads
// "Nora" instead of an empty label. Only empty labels are filled: a director's
// own label always stands. The label is the plain name because conditioning and
// the cast/sets pass find a cast member's sheet by its reference label
// (musicVideoConditioning.js, catalogCast.js): a video's linked cast member is
// named as the video names it, any other record by its catalog name.

import { isFileBackend } from '../../lib/pgFileFacade.js';

const unlabeled = (ref) => typeof ref?.imageId === 'string' && ref.imageId && !(typeof ref.label === 'string' && ref.label.trim());

/** The references with catalog names filled in, or null when none changes. */
export function labelReferences(references, owners, subjects = []) {
  const subjectName = new Map(subjects.filter((s) => s?.ingredientId && s.name?.trim()).map((s) => [s.ingredientId, s.name.trim()]));
  let changed = false;
  const next = (references || []).map((ref) => {
    const owner = unlabeled(ref) ? owners.get(ref.imageId) : null;
    const name = (owner && (subjectName.get(owner.preferredId) || owner.name?.trim())) || '';
    if (!name) return ref;
    changed = true;
    return { ...ref, label: name.slice(0, 120) };
  });
  return changed ? next : null;
}

async function findCatalogOwners(keys, options) {
  if (isFileBackend()) return new Map();
  const { findMediaOwnersByKeys } = await import('../catalogDB.js');
  return findMediaOwnersByKeys(keys, options);
}

const hasApproval = (project) => Object.values(project?.productionReview?.approvals || {}).some(Boolean);

/**
 * Fill the project's unlabeled references from the catalog, preferring the
 * records its cast links to when an image belongs to several. Resolves to
 * `{ project, labels }` (`labels` maps reference id → new label) or null when
 * nothing needed a name. A label steers which sheets condition a shot, so a
 * `backfill` (no edit by the director behind it) leaves a project with a
 * recorded approval alone rather than staling it. Never throws: the save that
 * triggered it already succeeded, and an unnamed reference stays editable.
 */
export async function labelProjectReferences(id, { backfill = false, findOwners = findCatalogOwners } = {}) {
  try {
    const { getProject, mutateProjectRecord } = await import('./projects.js');
    const project = await getProject(id);
    if (!project || (backfill && hasApproval(project))) return null;
    const keys = (project.visualSpec?.references || []).filter(unlabeled).map((ref) => ref.imageId);
    if (!keys.length) return null;
    const subjects = project.concept?.subjects || [];
    const owners = await findOwners(keys, { preferIds: subjects.map((s) => s?.ingredientId).filter(Boolean) });
    if (!labelReferences(project.visualSpec.references, owners, subjects)) return null;
    // Re-read under the lock: a reference edited or labelled meanwhile keeps that edit.
    const labels = {};
    const { project: saved } = await mutateProjectRecord(id, (current) => {
      const before = current.visualSpec?.references || [];
      const next = (backfill && hasApproval(current)) ? null : labelReferences(before, owners, current.concept?.subjects || []);
      if (!next) return { project: current, skipPersist: true };
      next.forEach((ref, i) => { if (ref !== before[i]) labels[ref.id] = ref.label; });
      return { project: { ...current, visualSpec: { ...current.visualSpec, references: next } } };
    });
    return Object.keys(labels).length ? { project: saved, labels } : null;
  } catch (err) {
    console.error(`❌ Music Video ${String(id).slice(0, 8)}: could not name references from the catalog: ${err.message}`);
    return null;
  }
}
