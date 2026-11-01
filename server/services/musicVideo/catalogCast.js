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

import { randomUUID } from 'crypto';
import { isFileBackend } from '../../lib/pgFileFacade.js';
import { trimTo } from '../../lib/textUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { CAST_SETS_SUBJECT_PREFIX } from './castAndSetsPlan.js';
import { leadingAge, musicVideoCastIngredientId, subjectNameParts } from './castAndSetsDirection.js';

const TYPE_PREFIX = { character: 'chr', place: 'plc', object: 'obj' };
const PRIMARY_KEY = { character: 'physicalDescription', place: 'description', object: 'description' };
const UNIVERSE_FIELD = { character: 'characters', place: 'places', object: 'objects' };
const REFERENCE_ROLE = { character: 'character', place: 'set', object: 'prop' };
const MAX_VIDEO_SUBJECTS = 24;
const SUBJECT_DESCRIPTION_MAX = 1000;
const queueCheckinSave = createKeyCachedQueue();

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

async function projectUniverse(project, getUniverse) {
  const id = project.concept?.universeId;
  if (!id) return null;
  return getUniverse(id).catch((error) => {
    if (error?.code === 'NOT_FOUND' || error?.code === 'UNIVERSE_NOT_FOUND') return null;
    throw error;
  });
}

/**
 * Reuse the exact canon pointer or this subject's deterministic identity. The
 * importer passes `suggest`, which proposes an existing record by name for the
 * director to review; approving Cast & Sets passes none, so names alone never
 * link a subject without review.
 */
async function planCatalogCast(project, candidates, deps, suggest = null) {
  const { catalogDB, getUniverse } = deps;
  const universe = await projectUniverse(project, getUniverse);
  const plan = [];
  for (const candidate of candidates) {
    const canon = candidate.canonId && universe
      ? (universe[UNIVERSE_FIELD[candidate.kind]] || []).find((e) => e.id === candidate.canonId && e.ingredientId)
      : null;
    const ownId = musicVideoCastIngredientId(project.id, { id: candidate.subjectId, kind: candidate.kind });
    // A canon entry keeps its ingredientId after its record is deleted.
    const canonLive = canon ? await catalogDB.getIngredient(canon.ingredientId) : null;
    const target = canonLive?.type === candidate.kind ? canonLive : await catalogDB.getIngredient(ownId);
    const suggestion = !target && suggest ? await suggest(candidate, ownId) : null;
    if (target) {
      plan.push({ ...candidate, action: 'link', ingredientId: target.id, ingredientName: target.name, match: target === canonLive ? 'canon' : 'saved' });
    } else if (suggestion) {
      plan.push({ ...candidate, action: 'link', ...suggestion });
    } else {
      plan.push({ ...candidate, action: 'create', ingredientId: ownId });
    }
  }
  return plan;
}

const nameKey = (name) => String(name || '').trim().toLowerCase();
const firstWordOf = (key) => key.split(/\s+/)[0] || '';

// The names a candidate may be matched by: as written, without an age or look
// qualifier ("Ada (17)" → "ada"), and for a character, the first name.
function candidateKeys(candidate) {
  const exact = nameKey(candidate.name);
  const { base, qualifier } = subjectNameParts(candidate.name);
  const baseKey = nameKey(base);
  return { exact, baseKey, qualifier, first: candidate.kind === 'character' ? firstWordOf(baseKey) : '' };
}

const recordKeys = (record) => [record.name, ...(Array.isArray(record.payload?.aliases) ? record.payload.aliases : [])]
  .map(nameKey).filter(Boolean);

function pushTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/**
 * The importer's name index over the whole catalog, read once per preview:
 * live records by name or alias, characters by first name, and the records
 * other subjects with the same name are already linked to. Tombstoned records
 * are never read, so a deleted record is never suggested.
 */
async function buildNameIndex(projects, d) {
  const exactKeys = new Map();
  const firstKeys = new Map();
  for (const project of projects) {
    for (const candidate of catalogCastCandidates(project)) {
      const k = candidateKeys(candidate);
      if (!exactKeys.has(candidate.kind)) exactKeys.set(candidate.kind, new Set());
      for (const key of [k.exact, k.baseKey, k.first]) if (key) exactKeys.get(candidate.kind).add(key);
      if (k.first && k.first === k.baseKey) {
        if (!firstKeys.has(candidate.kind)) firstKeys.set(candidate.kind, new Set());
        firstKeys.get(candidate.kind).add(k.first);
      }
    }
  }
  const byName = new Map();
  const byFirst = new Map();
  const rows = new Map();
  for (const [kind, keys] of exactKeys) {
    for (const record of await d.catalogDB.findIngredientsByName(kind, [...keys])) {
      rows.set(record.id, record);
      for (const key of new Set(recordKeys(record))) if (keys.has(key)) pushTo(byName, `${kind}:${key}`, record.id);
    }
  }
  for (const [kind, words] of firstKeys) {
    for (const record of await d.catalogDB.findIngredientsByName(kind, [...words], { firstWord: true })) {
      rows.set(record.id, record);
      for (const word of new Set(recordKeys(record).map(firstWordOf))) if (words.has(word)) pushTo(byFirst, `${kind}:${word}`, record.id);
    }
  }
  const linked = new Map();
  for (const project of projects) {
    for (const s of project.concept?.subjects || []) {
      if (!s?.ingredientId || !TYPE_PREFIX[s.kind]) continue;
      for (const key of new Set([nameKey(s.name), nameKey(subjectNameParts(s.name).base)])) {
        if (key && !linked.has(`${s.kind}:${key}`)) linked.set(`${s.kind}:${key}`, s.ingredientId);
      }
    }
  }
  const ids = [...new Set([...rows.keys(), ...linked.values()])];
  // Keyed by the id asked for: live records only, with their owning universe.
  const cards = new Map((ids.length ? await d.catalogDB.getIngredientCards(ids) : []).map((card) => [card.id, card]));
  return { byName, byFirst, linked, rows, cards };
}

/**
 * The importer's suggestion for one video's candidates, strongest first: a
 * record with the same name or alias, the record another video's same-named
 * subject is linked to, then the similar names (without the age qualifier, or
 * the first name), which must point at one record. A record owned by another
 * universe is never suggested, and the video's own universe is preferred.
 * `claimed` makes a name shared by videos of one world be added once.
 */
async function nameSuggester(project, index, d, claimed) {
  const universeId = project.concept?.universeId || null;
  const members = new Set(universeId
    ? (await d.catalogDB.listIngredientsForRef('universe', universeId)).map(({ ingredient }) => ingredient?.id).filter(Boolean)
    : []);
  const pick = (kind, ids, { unique = false } = {}) => {
    const seen = new Set();
    const eligible = [];
    for (const id of ids) {
      const card = index.cards.get(id);
      const recordId = card?.canonicalId || card?.id;
      if (!card || card.type !== kind || seen.has(recordId)) continue;
      const owner = card.owningUniverse?.id || null;
      if (universeId && owner && owner !== universeId) continue;
      seen.add(recordId);
      eligible.push({ id: recordId, name: card.name });
    }
    const own = eligible.filter((r) => members.has(r.id));
    const pool = own.length ? own : eligible;
    return pool.length && (!unique || pool.length === 1) ? pool[0] : null;
  };
  return async (candidate, ownId) => {
    const { kind } = candidate;
    const k = candidateKeys(candidate);
    const named = (key) => (key ? index.byName.get(`${kind}:${key}`) || [] : []);
    const linkedTo = (key) => (key && index.linked.has(`${kind}:${key}`) ? [index.linked.get(`${kind}:${key}`)] : []);
    const similar = k.baseKey !== k.exact;
    const firstName = !k.first ? [] : k.first === k.baseKey ? index.byFirst.get(`${kind}:${k.first}`) || [] : named(k.first);
    const tiers = [
      ['name', pick(kind, named(k.exact))],
      ['linked', pick(kind, linkedTo(k.exact))],
      ['base', similar ? pick(kind, [...named(k.baseKey), ...linkedTo(k.baseKey)]) : null],
      ['first-name', pick(kind, firstName.filter((id) => !named(k.baseKey).includes(id)), { unique: true })],
    ];
    const [match, record] = tiers.find(([, r]) => r) || [];
    if (record) {
      const full = k.qualifier ? index.rows.get(record.id) || await d.catalogDB.getIngredient(record.id) : null;
      const form = full ? formForQualifier(full, k.qualifier) : null;
      return { ingredientId: record.id, ingredientName: record.name, match, ...(form ? { formId: form.id, formLabel: form.label || String(form.age || '') } : {}) };
    }
    const claimKey = `${universeId || ''}:${kind}:${k.exact}`;
    if (claimed.has(claimKey)) return { ...claimed.get(claimKey), match: 'import' };
    claimed.set(claimKey, { ingredientId: ownId, ingredientName: candidate.name });
    return null;
  };
}

// Creates the record and attaches its image. False when a row already sits at
// the id but was deleted: the director removed it, so it is not brought back.
async function createRecord(project, item, deps) {
  const { catalogDB, getUniverse, createOwnedPrimitive } = deps;
  const payload = item.description ? { [PRIMARY_KEY[item.kind]]: trimTo(item.description, 4000) } : {};
  const tags = project.name ? [trimTo(project.name, 60)] : [];
  const input = { id: item.ingredientId, type: item.kind, name: item.name, payload, tags };
  const universe = await projectUniverse(project, getUniverse);
  // Only new records inherit the project's explicitly selected, live world.
  // Existing identities (including duplicate-key recovery) keep their owner.
  const created = await (universe ? createOwnedPrimitive(input, universe.id) : catalogDB.createIngredient(input))
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
        const form = d.formId ? (target.payload?.forms || []).find((f) => f?.id === d.formId) : null;
        const castForm = castFormSnapshot(form);
        stamps.set(subject.id, { ingredientId: target.id, ...(castForm ? { castForm } : {}) });
        stats.linked++;
        continue;
      }
      // A retry may create this exact subject's deterministic row. A missing
      // reviewed target belonging to another subject stays missing.
      if (d.ingredientId !== musicVideoCastIngredientId(projectId, subject)) continue;
      const item = { kind: subject.kind, name: subject.name, description: subject.description || '', imageId: images.get(subject.id) || null, ingredientId: d.ingredientId };
      if (await createRecord(project, item, deps)) {
        stamps.set(subject.id, { ingredientId: item.ingredientId });
        stats.created++;
      }
      continue;
    }
    if (d.action !== 'create') continue;
    const item = { kind: subject.kind, name: subject.name, description: subject.description || '', imageId: images.get(subject.id) || null, ingredientId: musicVideoCastIngredientId(projectId, subject) };
    if (await createRecord(project, item, deps)) {
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
  const [catalogDB, projects, { getUniverse }, { queueProjectCatalogLinkSync }, { createOwnedPrimitive }] = await Promise.all([
    import('../catalogDB.js'),
    import('./projects.js'),
    import('../universeBuilder.js'),
    import('./catalogLinks.js'),
    import('../catalogPrimitives.js'),
  ]);
  return { catalogDB, getUniverse, createOwnedPrimitive, getProject: projects.getProject, listProjects: projects.listProjects, mutateProjectRecord: projects.mutateProjectRecord, queueProjectCatalogLinkSync };
}

async function refreshCheckinRecords(project, catalogDB) {
  if (project?.castAndSets?.status !== 'approved') return;
  const sheets = checkinImages(project);
  const history = new Set(Object.values(project.castAndSets.images || {}).flatMap((image) => image.history || []));
  for (const subject of project.concept?.subjects || []) {
    if (!sheets.has(subject.id) || subject.localOnly || !TYPE_PREFIX[subject.kind]
      || subject.ingredientId !== musicVideoCastIngredientId(project.id, subject)) continue;
    const record = await catalogDB.getIngredient(subject.ingredientId);
    // Consolidated identities and hand-linked records are no longer ours to refresh.
    if (!record || record.id !== subject.ingredientId || record.type !== subject.kind) continue;
    await catalogDB.updateIngredientPayloadKeys(record.id, () => ({
      [PRIMARY_KEY[subject.kind]]: trimTo(subject.description || '', 4000),
    }), { source: 'sync' });
    const imageId = sheets.get(subject.id);
    if (!imageId) continue;
    const media = await catalogDB.listMediaForIngredient(record.id);
    const current = media.find((image) => image.kind === 'reference' && image.mediaKey === imageId);
    // Attach first: a failed replacement must leave the previous reference available.
    await catalogDB.attachMedia(record.id, imageId, 'reference', {
      caption: `From ${trimTo(project.name || 'a music video', 100)}`,
      metadata: { ...(current?.metadata || {}), musicVideoCast: { projectId: project.id, subjectId: subject.id } },
    });
    for (const image of media) {
      const origin = image.metadata?.musicVideoCast;
      const ours = origin?.projectId === project.id && origin.subjectId === subject.id;
      // Older installs attached check-in images with only the caption. History
      // also recognizes those references after the project has been renamed.
      const legacy = !origin && (history.has(image.mediaKey)
        || image.caption === `From ${trimTo(project.name || 'a music video', 100)}`);
      if (image.kind === 'reference' && image.mediaKey !== imageId && (ours || legacy)) {
        await catalogDB.detachMedia(record.id, image.mediaKey, image.kind);
      }
    }
  }
}

/**
 * After Cast & Sets is approved: save the check-in's new cast, sets and their
 * sheets to the catalog, reusing exact universe canon pointers. No
 * provider calls; Postgres backend only.
 */
export async function saveCheckinCastToCatalog(projectId, deps = null) {
  if (isFileBackend()) return null;
  return queueCheckinSave(projectId, async () => {
    const d = deps || await defaultDeps();
    const project = await d.getProject(projectId);
    if (!project || project.deleted || project.castAndSets?.status !== 'approved') return null;
    const candidates = catalogCastCandidates(project, { checkinOnly: true });
    const plan = candidates.length ? await planCatalogCast(project, candidates, d) : [];
    const result = await commitCatalogCast(projectId, plan.map(({ subjectId, action, ingredientId }) => ({ subjectId, action, ingredientId })), d);
    await refreshCheckinRecords(result.project, d.catalogDB);
    return result;
  });
}

/** The importer's dry run: every live video's uncatalogued subjects, decided. */
export async function previewCatalogCastImport(deps = null) {
  const d = deps || await defaultDeps();
  const projects = (await d.listProjects()).filter((p) => p && !p.deleted);
  const index = await buildNameIndex(projects, d);
  const claimed = new Map();
  const out = [];
  for (const project of projects) {
    const candidates = catalogCastCandidates(project);
    if (!candidates.length) continue;
    const suggest = await nameSuggester(project, index, d, claimed);
    out.push({ projectId: project.id, name: project.name || 'Untitled', items: await planCatalogCast(project, candidates, d, suggest) });
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

// The record's age form a qualifier names: "17" matches a form aged 17, a word
// matches a form whose label or age carries it. None: the record's own form.
function formForQualifier(record, qualifier) {
  const forms = Array.isArray(record?.payload?.forms) ? record.payload.forms : [];
  const q = String(qualifier || '').trim().toLowerCase();
  if (!q || !forms.length) return null;
  const age = /^\d{1,3}$/.test(q) ? Number(q) : null;
  return forms.find((f) => (age !== null ? leadingAge(f.age) === age : `${f.label} ${f.age || ''}`.toLowerCase().includes(q))) || null;
}

const formOptions = (record) => (Array.isArray(record?.payload?.forms) ? record.payload.forms : [])
  .filter((f) => f?.id).map((f) => ({ id: f.id, label: f.label || f.age || f.id }));

// The catalog's appearance text for what a subject shows: its linked age
// form's description when it shows one, else the record's own.
function catalogAppearance(record, formId) {
  const payload = record?.payload || {};
  const form = formId ? (Array.isArray(payload.forms) ? payload.forms : []).find((f) => f?.id === formId) : null;
  if (form) return { field: 'form', formId: form.id, text: String(form.description || '') };
  return { field: 'record', text: String(payload[PRIMARY_KEY[record?.type]] || payload.description || '') };
}

// The subject's snapshot of the age form it shows; `age` is a whole number only when the form states one.
function castFormSnapshot(form) {
  if (!form?.id) return undefined;
  const age = leadingAge(form.age);
  return { id: form.id, label: trimTo(form.label, 80), ...(age !== null && age <= 150 ? { age } : {}) };
}

const loadVideo = async (projectId, d) => {
  const project = await d.getProject(projectId);
  if (!project || project.deleted) throw new ServerError('That music video no longer exists.', { status: 404, code: 'NOT_FOUND' });
  return project;
};

/**
 * A video's subjects of one kind with the catalog record each is linked to,
 * and for an unlinked one, the record its name points at (same name, the
 * video's universe first) with the age form its qualifier names.
 */
export async function listVideoSubjectLinks(projectId, { type } = {}, deps = null) {
  const d = deps || await defaultDeps();
  const project = await loadVideo(projectId, d);
  const universeId = project.concept?.universeId || null;
  const subjects = (project.concept?.subjects || []).filter((s) => s?.id && TYPE_PREFIX[s.kind] && (!type || s.kind === type));
  const records = new Map();
  const byName = new Map();
  const out = [];
  for (const subject of subjects) {
    if (subject.ingredientId) {
      if (!records.has(subject.ingredientId)) records.set(subject.ingredientId, await d.catalogDB.getIngredient(subject.ingredientId));
      const record = records.get(subject.ingredientId);
      out.push({ ...subject, linked: record && !record.deleted ? { id: record.id, name: record.name, forms: formOptions(record), appearance: catalogAppearance(record, subject.castForm?.id) } : null, suggestion: null });
      continue;
    }
    const { base, qualifier } = subjectNameParts(subject.name);
    const key = `${subject.kind}:${base.toLowerCase()}`;
    if (!byName.has(key)) {
      const { items } = await d.catalogDB.listIngredients({ type: subject.kind, query: base, limit: 20 });
      const exact = items.filter((item) => item.name.trim().toLowerCase() === base.toLowerCase());
      byName.set(key, exact.find((item) => item.owningUniverse?.id === universeId) || exact[0] || null);
    }
    const match = byName.get(key);
    const form = match ? formForQualifier(match, qualifier) : null;
    out.push({ ...subject, linked: null, suggestion: match ? { ingredientId: match.id, name: match.name, forms: formOptions(match), ...(form ? { formId: form.id, formLabel: form.label } : {}) } : null });
  }
  return { projectId, name: project.name || 'Untitled', subjects: out };
}

/**
 * Link (or with `ingredientId: null`, unlink) subjects to catalog records of
 * their kind, with an optional age form. The subject keeps its own name and
 * description; only the link and the form snapshot change, which approvals
 * ignore. One write; the video's catalog refs follow.
 */
export async function linkVideoSubjects(projectId, links, deps = null) {
  const d = deps || await defaultDeps();
  const project = await loadVideo(projectId, d);
  const subjects = new Map((project.concept?.subjects || []).map((s) => [s.id, s]));
  const stamps = new Map();
  for (const link of links) {
    const subject = subjects.get(link.subjectId);
    if (!subject) throw new ServerError(`This video has no subject ${link.subjectId}.`, { status: 404, code: 'NOT_FOUND' });
    if (!link.ingredientId) { stamps.set(subject.id, null); continue; }
    const record = await d.catalogDB.getIngredient(link.ingredientId);
    if (!record || record.deleted) throw new ServerError('That catalog record no longer exists.', { status: 404, code: 'NOT_FOUND' });
    if (record.type !== subject.kind) throw new ServerError(`${record.name} is a ${record.type}, not a ${subject.kind}.`, { status: 400, code: 'SUBJECT_KIND_MISMATCH' });
    const form = link.formId ? (record.payload?.forms || []).find((f) => f.id === link.formId) : null;
    if (link.formId && !form) throw new ServerError(`${record.name} has no such age or look.`, { status: 400, code: 'FORM_NOT_FOUND' });
    // "Use catalog": the subject's description becomes the catalog's, refused rather than cut when too long.
    let description;
    if (link.useCatalogText) {
      description = catalogAppearance(record, form?.id).text.trim();
      if (description.length > SUBJECT_DESCRIPTION_MAX) {
        throw new ServerError(`${record.name}'s catalog description is ${description.length} characters; a video subject holds ${SUBJECT_DESCRIPTION_MAX}. Shorten it in the catalog first.`, { status: 400, code: 'DESCRIPTION_TOO_LONG' });
      }
    }
    stamps.set(subject.id, { ingredientId: record.id, castForm: castFormSnapshot(form), description });
  }
  if (!stamps.size) return { project, linked: 0, unlinked: 0 };
  const { project: saved } = await d.mutateProjectRecord(projectId, (current) => ({
    project: {
      ...current,
      concept: {
        ...(current.concept || {}),
        subjects: (current.concept?.subjects || []).map((s) => {
          if (!stamps.has(s.id)) return s;
          const { ingredientId: _ingredientId, castForm: _castForm, localOnly: _localOnly, ...rest } = s;
          const stamp = stamps.get(s.id);
          if (!stamp) return rest;
          return { ...rest, ...(stamp.description !== undefined ? { description: stamp.description } : {}), ingredientId: stamp.ingredientId, ...(stamp.castForm ? { castForm: stamp.castForm } : {}) };
        }),
      },
    },
  }));
  // Awaited so the catalog's story filter shows the change when this returns.
  await d.queueProjectCatalogLinkSync(projectId);
  const linked = [...stamps.values()].filter(Boolean).length;
  console.log(`🎭 Music video ${String(projectId).slice(0, 11)}: ${linked} subject(s) linked, ${stamps.size - linked} unlinked`);
  return { project: saved, linked, unlinked: stamps.size - linked };
}

/**
 * Cast a catalog record in a video from the catalog side: an unlinked subject
 * already named for it is linked; otherwise it joins as a new subject.
 */
export async function addCatalogRecordToVideo(projectId, ingredientId, deps = null) {
  const d = deps || await defaultDeps();
  const project = await loadVideo(projectId, d);
  const record = await d.catalogDB.getIngredient(ingredientId);
  if (!record || record.deleted) throw new ServerError('That catalog record no longer exists.', { status: 404, code: 'NOT_FOUND' });
  if (!TYPE_PREFIX[record.type]) throw new ServerError('Only cast, environments and objects can join a music video.', { status: 400, code: 'SUBJECT_KIND_MISMATCH' });
  const subjects = project.concept?.subjects || [];
  if (subjects.some((s) => s.ingredientId === record.id)) return { project, added: false, linked: 0 };
  const key = record.name.trim().toLowerCase();
  const named = subjects.find((s) => !s.ingredientId && s.kind === record.type && subjectNameParts(s.name).base.toLowerCase() === key);
  if (named) {
    const { project: saved, linked } = await linkVideoSubjects(projectId, [{ subjectId: named.id, ingredientId: record.id }], d);
    return { project: saved, added: false, linked };
  }
  if (subjects.length >= MAX_VIDEO_SUBJECTS) throw new ServerError(`A music video holds at most ${MAX_VIDEO_SUBJECTS} cast, sets and props.`, { status: 409, code: 'SUBJECT_LIMIT' });
  const appearance = catalogAppearance(record).text.trim();
  const subject = {
    id: `mvc-${randomUUID()}`, kind: record.type, name: trimTo(record.name, 120),
    // Copied only when it fits; a longer one is never cut, the link shows it differs.
    description: appearance.length <= SUBJECT_DESCRIPTION_MAX ? appearance : '',
    ...(record.type === 'character' ? { role: subjects.some((s) => s.kind === 'character') ? 'supporting' : 'protagonist' } : {}),
    ingredientId: record.id,
  };
  const { project: saved } = await d.mutateProjectRecord(projectId, (current) => ({
    project: { ...current, concept: { ...(current.concept || {}), subjects: [...(current.concept?.subjects || []), subject] } },
  }));
  // Awaited so the catalog's story filter shows the change when this returns.
  await d.queueProjectCatalogLinkSync(projectId);
  console.log(`🎭 Music video ${String(projectId).slice(0, 11)}: cast ${record.id} as a new subject`);
  return { project: saved, added: true, linked: 0 };
}
