/** Read-only, machine-local availability checks for Video draft/artifact sources. */
import { creativeDirectorVideoDraftSchema } from '../../lib/creativeDirectorValidation.js';
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { ServerError } from '../../lib/errorHandler.js';

const sourceSchema = creativeDirectorVideoDraftSchema.shape.sources.unwrap().element;

// Load only the requested store. Voice means a local voice-profile ID, music a
// Music track ID. Never return source records, local paths, or voice bindings.
const readers = {
  universe: async (id) => (await import('../universeBuilder/crud.js')).getUniverse(id),
  series: async (id) => (await import('../pipeline/series.js')).getSeries(id),
  catalog: async (id) => (await import('../catalogDB/ingredients.js')).getIngredient(id),
  music: async (id) => (await import('../tracks/index.js')).getTrack(id),
  voice: async (id) => (await import('../voice/profiles.js')).getVoiceProfile(id),
};

async function readSource(source) {
  const record = await readers[source.kind](source.id).catch(error => {
    // These stores deliberately use different not-found contracts. An outage
    // must propagate: it is not evidence that a source was deleted.
    if (error.code === 'NOT_FOUND' || error.code === 'PIPELINE_SERIES_NOT_FOUND') return null;
    throw error;
  });
  return record && !record.deleted ? record : null;
}

function sourceRevision(record) {
  const stamps = record ? Object.fromEntries(['revision', 'updatedAt']
    .map(key => [key, record[key]])
    .filter(([, value]) => (typeof value === 'string' && value.trim().length > 0)
      || (typeof value === 'number' && Number.isFinite(value)))) : {};
  return Object.keys(stamps).length ? canonicalSnapshotChecksum(stamps) : null;
}

async function readSourceStatus(source) {
  const record = await readSource(source);
  return { available: Boolean(record), currentRevision: sourceRevision(record) };
}

const text = (value, max = 6000) => typeof value === 'string'
  ? value.length > max ? `${value.slice(0, max)}\n[Source summary truncated]` : value : '';

async function sourceSummary(source, record) {
  if (source.kind === 'universe') {
    const { renderStoryCanonDigest } = await import('../../lib/universePromptRenderers.js');
    const { buildVisualStyleClause } = await import('../../lib/universeVisualStyle.js');
    return { name: text(record.name, 200), canon: text(renderStoryCanonDigest(record)), style: text(buildVisualStyleClause(record), 2000) };
  }
  if (source.kind === 'catalog') {
    const { payloadSnippet, getActiveCatalogType } = await import('../../lib/catalogTypes.js');
    return { name: text(record.name, 200), type: record.type, description: payloadSnippet(record.payload, record.type, 6000, getActiveCatalogType) };
  }
  if (source.kind === 'series') {
    return { name: text(record.name || record.title, 200), premise: text(record.premise), logline: text(record.logline), arc: text(record.arc?.summary), style: text(record.stylePromptOverride, 2000), universeId: record.universeId || null };
  }
  if (source.kind === 'music') {
    return { title: text(record.title, 200), concept: text(record.concept), lyrics: text(record.lyrics), durationSeconds: record.durationSec || null, hasAudio: Boolean(record.audioFilename) };
  }
  // Voice bindings, inference paths, recordings and route credentials stay out
  // of prompts. Assembly resolves the selected profile locally when authorized.
  return { label: text(record.label, 200), kind: record.kind, approved: record.approval?.status === 'approved' };
}

/** Resolve selected creative context only when explicitly planning. Never mutate sources. */
export async function resolveVideoSourceContext(project) {
  const sources = [...(project.videoDraft?.sources || [])];
  const summaries = [];
  const references = [];
  for (const input of sources) {
    const source = sourceSchema.parse(input);
    const record = await readSource(source);
    if (!record) throw new ServerError(`Video source ${source.kind}:${source.id} is missing. Edit source attachments before planning.`, { status: 409, code: 'VIDEO_SOURCE_MISSING' });
    const summary = await sourceSummary(source, record);
    // A selected Series carries its existing Universe context; resolve that
    // dependency through the same reader instead of inventing a parallel canon.
    if (source.kind === 'series' && record.universeId && !sources.some(value => value.kind === 'universe' && value.id === record.universeId)) {
      sources.push({ kind: 'universe', id: record.universeId });
    }
    const revision = sourceRevision(record);
    if (!revision) throw new ServerError(`Video source ${source.kind}:${source.id} has no revision metadata. Save or repair it before planning.`, { status: 409, code: 'VIDEO_SOURCE_REVISION_UNKNOWN' });
    references.push({ ...source, sourceRevision: revision });
    summaries.push({ kind: source.kind, id: source.id, revision, summary });
  }
  if (JSON.stringify(summaries).length > 60000) {
    throw new ServerError('Selected Video sources exceed the planning context limit. Select fewer sources and plan again.', { status: 409, code: 'VIDEO_SOURCE_CONTEXT_LIMIT' });
  }
  return { revision: canonicalSnapshotChecksum(references), references, summaries };
}

/** Persist fingerprints, never resolved source contents, before dispatching a planner. */
export async function prepareVideoPlanningProject(project) {
  if (project.workspace !== 'video') return project;
  const context = await resolveVideoSourceContext(project);
  const videoPlanningContext = { revision: context.revision, references: context.references };
  const { updateProject } = await import('./local.js');
  await updateProject(project.id, { videoPlanningContext });
  return { ...project, videoPlanningContext, resolvedVideoSources: context.summaries };
}

/** Checks both snapshots while retaining each snapshot's declared revision. */
export async function getVideoSourceStatus(project) {
  const availability = new Map();
  const check = async (references) => Promise.all(references.map(reference => {
    const source = sourceSchema.parse({ kind: reference.kind, id: reference.id, revision: reference.revision });
    const referenceId = `${source.kind}:${source.id}`;
    if (!availability.has(referenceId)) availability.set(referenceId, readSourceStatus(source));
    return availability.get(referenceId).then(status => ({
      ...source, referenceId, ...status,
      revisionChanged: typeof reference.sourceRevision === 'string' && status.currentRevision
        ? reference.sourceRevision !== status.currentRevision : null,
    }));
  }));
  const [draft, artifact] = await Promise.all([
    check(project.videoDraft?.sources || []),
    check(project.treatment?.artifact?.references || []),
  ]);
  return { draft, artifact };
}

/** All public treatment/plan writers share this guard; draft edits stay repairable. */
export async function assertVideoSourcesAvailable(project) {
  if (project?.workspace !== 'video') return undefined;
  const { draft } = await getVideoSourceStatus({ ...project, treatment: null });
  const missing = draft.filter(source => !source.available);
  if (missing.length) {
    throw new ServerError(`Video sources are missing: ${missing.map(source => source.referenceId).join(', ')}. Open Edit draft > Sources to remove or replace them, then save a revised treatment.`, {
      status: 409, code: 'VIDEO_SOURCE_MISSING',
    });
  }
  if (project.videoPlanningContext) {
    const current = await resolveVideoSourceContext(project);
    if (current.revision !== project.videoPlanningContext.revision) {
      throw new ServerError('Video source content changed during planning. Plan again using the current sources before saving this treatment.', { status: 409, code: 'VIDEO_SOURCE_CONTEXT_CHANGED' });
    }
  }
  return Object.fromEntries(draft.map(source => [source.referenceId, source.currentRevision]));
}
