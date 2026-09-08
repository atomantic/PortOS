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

async function readSourceStatus(source) {
  const record = await readers[source.kind](source.id).catch(error => {
    // These stores deliberately use different not-found contracts. An outage
    // must propagate: it is not evidence that a source was deleted.
    if (error.code === 'NOT_FOUND' || error.code === 'PIPELINE_SERIES_NOT_FOUND') return null;
    throw error;
  });
  const available = Boolean(record && !record.deleted);
  // Use the source store's own revision/update contract, never hash or export
  // source content (especially local voice bindings). Missing metadata means
  // unknown, not proof that an old source still matches.
  const stamps = available ? Object.fromEntries(['revision', 'updatedAt']
    .map(key => [key, record[key]])
    .filter(([, value]) => (typeof value === 'string' && value.trim().length > 0)
      || (typeof value === 'number' && Number.isFinite(value)))) : {};
  return { available, currentRevision: Object.keys(stamps).length ? canonicalSnapshotChecksum(stamps) : null };
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
  return Object.fromEntries(draft.map(source => [source.referenceId, source.currentRevision]));
}
