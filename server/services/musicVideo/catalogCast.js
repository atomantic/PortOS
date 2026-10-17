// Saves a music video's cast, sets and props to the catalog so Casting,
// Environments and Objects hold them for reuse. Two callers share it: approving
// Cast & Sets saves the check-in's new cast automatically, and the importer
// (dry run, review, commit) backfills videos made before the catalog link.
//
// A subject is saved by stamping `ingredientId` on it; catalogLinks.js then
// keeps the music-video ref in step. `localOnly` marks a subject the director
// keeps in this video only, so neither caller offers it again.
//
// Catalog ids are deterministic per (project, subject), like the universe canon
// promotion, so two machines saving the same synced video converge on one row.

import { createHash } from 'crypto';
import { isFileBackend } from '../../lib/pgFileFacade.js';
import { trimTo } from '../../lib/textUtils.js';
import { CAST_SETS_SUBJECT_PREFIX } from './castAndSetsPlan.js';

const TYPE_PREFIX = { character: 'chr', place: 'plc', object: 'obj' };
const PRIMARY_KEY = { character: 'physicalDescription', place: 'description', object: 'description' };
const UNIVERSE_FIELD = { character: 'characters', place: 'places', object: 'objects' };
const REFERENCE_ROLE = { character: 'character', place: 'set', object: 'prop' };

function musicVideoCastIngredientId(projectId, subject) {
  const seed = `music-video:${projectId}:${subject.kind}:${subject.id}`;
  return `cat-${TYPE_PREFIX[subject.kind]}-mv-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

// The Cast & Sets image behind each check-in subject: the protagonist's
// character sheet, a supporting cast sheet, or a set plate.
function checkinImages(project) {
  const stage = project?.castAndSets;
  if (stage?.status !== 'approved') return new Map();
  const images = stage.images || {};
  const done = (key) => (images[key]?.status === 'done' && images[key].imageId) || null;
  const out = new Map([[`${CAST_SETS_SUBJECT_PREFIX}protagonist`, done('character')]]);
  for (const c of stage.direction?.cast || []) out.set(`${CAST_SETS_SUBJECT_PREFIX}cast-${c.id}`.slice(0, 64), done(`cast:${c.id}`));
  for (const set of stage.direction?.sets || []) out.set(`${CAST_SETS_SUBJECT_PREFIX}set-${set.id}`.slice(0, 64), done(`set:${set.id}`));
  return out;
}

// A director-cast subject's image: the look reference pulled for it by name.
function referenceImage(project, subject) {
  const ref = (project?.visualSpec?.references || [])
    .find((r) => r.imageId && r.role === REFERENCE_ROLE[subject.kind] && String(r.label || '').trim().toLowerCase() === subject.name.trim().toLowerCase());
  return ref?.imageId || null;
}

/**
 * The subjects of a project not yet in the catalog, with the image that shows
 * each. `checkinOnly` limits it to the ones Cast & Sets created.
 */
function catalogCastCandidates(project, { checkinOnly = false } = {}) {
  if (!project || project.deleted) return [];
  const sheets = checkinImages(project);
  return (project.concept?.subjects || [])
    .filter((s) => s?.id && s.name && TYPE_PREFIX[s.kind] && !s.ingredientId && !s.localOnly)
    .filter((s) => !checkinOnly || s.id.startsWith(CAST_SETS_SUBJECT_PREFIX))
    .map((s) => ({
      subjectId: s.id,
      kind: s.kind,
      name: s.name,
      description: s.description || '',
      canonId: s.canonId || null,
      imageId: sheets.get(s.id) || referenceImage(project, s),
    }));
}

const nameKey = (kind, name) => `${kind}:${String(name || '').trim().toLowerCase()}`;

/**
 * Decide each candidate: link to the universe entry it was cast from, to a
 * same-named record of the video's universe, to any other same-named catalog
 * record, or to the row a synced machine already saved; otherwise create.
 * `claimed` carries the creates already proposed in this run, so a name shared
 * by two videos is created once and linked from the other. Reads only.
 */
async function planCatalogCast(project, candidates, deps, claimed = new Map()) {
  const { catalogDB, getUniverse } = deps;
  const universeId = project.concept?.universeId || null;
  const universe = universeId ? await getUniverse(universeId).catch(() => null) : null;
  const universeRows = universeId ? await catalogDB.listIngredientsForRef('universe', universeId) : [];
  const plan = [];
  for (const candidate of candidates) {
    const key = nameKey(candidate.kind, candidate.name);
    const canon = candidate.canonId && universe
      ? (universe[UNIVERSE_FIELD[candidate.kind]] || []).find((e) => e.id === candidate.canonId && e.ingredientId)
      : null;
    const inUniverse = universeRows.find(({ ingredient }) => nameKey(ingredient.type, ingredient.name) === key)?.ingredient;
    const ownId = musicVideoCastIngredientId(project.id, { id: candidate.subjectId, kind: candidate.kind });
    const target = canon ? { id: canon.ingredientId, name: canon.name }
      : inUniverse || (await catalogDB.findIngredientsByName(candidate.kind, [candidate.name]))[0]
        || await catalogDB.getIngredient(ownId) || claimed.get(key);
    if (target) {
      plan.push({ ...candidate, action: 'link', ingredientId: target.id, ingredientName: target.name });
    } else {
      claimed.set(key, { id: ownId, name: candidate.name });
      plan.push({ ...candidate, action: 'create', ingredientId: ownId });
    }
  }
  return plan;
}

// Creates the record and attaches its image. False when a row already sits at
// the id but was deleted: the director removed it, so it is not brought back.
async function createRecord(project, item, catalogDB) {
  const payload = item.description ? { [PRIMARY_KEY[item.kind]]: trimTo(item.description, 4000) } : {};
  const tags = project.name ? [trimTo(project.name, 60)] : [];
  const created = await catalogDB.createIngredient({ id: item.ingredientId, type: item.kind, name: item.name, payload, tags })
    .then(() => true)
    .catch(async (err) => {
      if (err?.code !== '23505') throw err;
      // A synced machine saved the same subject first: same deterministic id.
      return Boolean(await catalogDB.getIngredient(item.ingredientId));
    });
  if (created && item.imageId) {
    await catalogDB.attachMedia(item.ingredientId, item.imageId, 'reference', { caption: `From ${trimTo(project.name || 'a music video', 100)}` });
  }
  return created;
}

/**
 * Apply decisions to one project. `create` makes the catalog record (with its
 * image), `link` reuses one, and `local` keeps the subject in this video only.
 * Stamps the subjects in one write and returns the saved project.
 */
async function commitCatalogCast(projectId, decisions, deps) {
  const { catalogDB, getProject, mutateProjectRecord, queueProjectCatalogLinkSync } = deps;
  const project = await getProject(projectId);
  if (!project || project.deleted || !decisions.length) return { project, created: 0, linked: 0, kept: 0 };
  const images = new Map(catalogCastCandidates(project).map((c) => [c.subjectId, c.imageId]));
  const stamps = new Map();
  const stats = { created: 0, linked: 0, kept: 0 };
  for (const d of decisions) {
    const subject = (project.concept?.subjects || []).find((s) => s.id === d.subjectId);
    if (!subject || subject.ingredientId) continue;
    if (d.action === 'local') {
      stamps.set(subject.id, { localOnly: true });
      stats.kept++;
      continue;
    }
    if (d.action === 'link' && d.ingredientId) {
      const target = await catalogDB.getIngredient(d.ingredientId);
      if (target) {
        if (target.type !== subject.kind) continue;
        stamps.set(subject.id, { ingredientId: target.id });
        stats.linked++;
        continue;
      }
      // The link pointed at the record another video's subject was to create
      // in this import, and that one was kept local: create this one instead.
    } else if (d.action !== 'create') {
      continue;
    }
    const item = { kind: subject.kind, name: subject.name, description: subject.description || '', imageId: images.get(subject.id) || null, ingredientId: musicVideoCastIngredientId(projectId, subject) };
    if (await createRecord(project, item, catalogDB)) {
      stamps.set(subject.id, { ingredientId: item.ingredientId });
      stats.created++;
    } else {
      stamps.set(subject.id, { localOnly: true });
      stats.kept++;
    }
  }
  if (!stamps.size) return { project, ...stats };
  const { project: saved } = await mutateProjectRecord(projectId, (current) => ({
    project: {
      ...current,
      concept: {
        ...(current.concept || {}),
        subjects: (current.concept?.subjects || []).map((s) => (stamps.has(s.id) && !s.ingredientId ? { ...s, ...stamps.get(s.id) } : s)),
      },
    },
  }));
  queueProjectCatalogLinkSync(projectId);
  return { project: saved, ...stats };
}

async function defaultDeps() {
  const [catalogDB, projects, { getUniverse }, { queueProjectCatalogLinkSync }] = await Promise.all([
    import('../catalogDB.js'),
    import('./projects.js'),
    import('../universeBuilder.js'),
    import('./catalogLinks.js'),
  ]);
  return { catalogDB, getUniverse, getProject: projects.getProject, listProjects: projects.listProjects, mutateProjectRecord: projects.mutateProjectRecord, queueProjectCatalogLinkSync };
}

/**
 * After Cast & Sets is approved: save the check-in's new cast, sets and their
 * sheets to the catalog, reusing universe records where they match. No
 * provider calls; Postgres backend only.
 */
export async function saveCheckinCastToCatalog(projectId, deps = null) {
  if (isFileBackend()) return null;
  const d = deps || await defaultDeps();
  const project = await d.getProject(projectId);
  const candidates = catalogCastCandidates(project, { checkinOnly: true });
  if (!candidates.length) return null;
  const plan = await planCatalogCast(project, candidates, d);
  return commitCatalogCast(projectId, plan.map(({ subjectId, action, ingredientId }) => ({ subjectId, action, ingredientId })), d);
}

/** The importer's dry run: every live video's uncatalogued subjects, decided. */
export async function previewCatalogCastImport(deps = null) {
  const d = deps || await defaultDeps();
  const out = [];
  const claimed = new Map();
  for (const project of await d.listProjects()) {
    const candidates = catalogCastCandidates(project);
    if (!candidates.length) continue;
    out.push({ projectId: project.id, name: project.name || 'Untitled', items: await planCatalogCast(project, candidates, d, claimed) });
  }
  return out;
}

/** The importer's commit: the reviewed decisions, grouped by project. */
export async function commitCatalogCastImport(selections, deps = null) {
  const d = deps || await defaultDeps();
  const byProject = new Map();
  for (const s of selections) byProject.set(s.projectId, [...(byProject.get(s.projectId) || []), s]);
  const totals = { projects: 0, created: 0, linked: 0, kept: 0 };
  for (const [projectId, decisions] of byProject) {
    const result = await commitCatalogCast(projectId, decisions, d);
    if (result.created + result.linked + result.kept) totals.projects++;
    totals.created += result.created;
    totals.linked += result.linked;
    totals.kept += result.kept;
  }
  console.log(`🎭 Music video cast import: ${totals.created} created, ${totals.linked} linked, ${totals.kept} kept in their videos (${totals.projects} videos)`);
  return totals;
}
