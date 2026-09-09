vi.mock('../instances.js', () => ({ ensureInstanceId: vi.fn(async () => 'example-owner'), getInstanceId: vi.fn(async () => 'example-owner') }));
import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ project: null, writes: 0 }));
vi.mock('../../lib/db.js', () => {
  const query = vi.fn(async (sql, values) => {
    if (sql.startsWith('SELECT')) return { rows: [{ id: state.project.id, data: structuredClone(state.project) }] };
    if (sql.startsWith('INSERT')) {
      state.project = JSON.parse(values[2]);
      state.writes += 1;
      return { rows: [] };
    }
    throw new Error('Unexpected SQL');
  });
  return { query, withTransaction: async fn => fn({ query }) };
});
vi.mock('../mediaCollections.js', () => ({ createCollection: vi.fn() }));
vi.mock('../../lib/conflictJournal.js', () => ({
  maybeJournalBeforeOverwrite: vi.fn(), setSyncBaseHash: vi.fn(), contentHashForRecord: vi.fn(),
  flushBaseHashes: vi.fn(), deleteSyncBaseHash: vi.fn(), withBaseHashFlushBatch: vi.fn(),
}));
vi.mock('../catalogDB/ingredients.js', () => ({ getIngredient: vi.fn() }));
import { getIngredient } from '../catalogDB/ingredients.js';
import { setTreatment, getProject, updateProject } from './projectsDB.js';
import { getVideoSourceStatus } from './videoSources.js';

describe('Video source revision persistence through the PostgreSQL adapter', () => {
  it('preserves approved work when a settings save only changes JSON object key order', async () => {
    state.project = {
      id: 'cd-settings', workspace: 'video', status: 'paused', videoWorkRevision: 3,
      renderBackend: { video: { modelId: 'fast-h3', mode: 'reactor' }, image: { mode: 'local' } },
      treatment: { artifact: { revision: 2 }, scenes: [{ sceneId: 'shot-1', workRevision: 3 }] },
      videoFinalCut: { videoId: 'approved-cut' }, finalVideoId: 'approved-cut',
    };
    const saved = await updateProject(state.project.id, {
      renderBackend: { image: { mode: 'local' }, video: { mode: 'reactor', modelId: 'fast-h3' } },
    });
    expect(saved.treatment.artifact.stale).not.toBe(true);
    expect(saved.videoWorkRevision).toBe(3);
    expect(saved.finalVideoId).toBe('approved-cut');
    const revised = await updateProject(state.project.id, {
      renderBackend: { image: { mode: 'local' }, video: { mode: 'reactor', modelId: 'quality-h3' } },
    });
    expect(revised.treatment.artifact.stale).toBe(true);
    expect(revised.videoWorkRevision).toBe(4);
    expect(revised.finalVideoId).toBeNull();
  });

  it('awaits source resolution, preserves the captured stamp across reads, and refuses an unavailable source', async () => {
    state.project = {
      id: 'cd-example', workspace: 'video', status: 'draft', targetDurationSeconds: 60, aspectRatio: '16:9',
      videoDraft: { sources: [{ kind: 'catalog', id: 'example-catalog', revision: 'user-label' }] },
      plan: { steps: [{ stepId: 'old-shot', status: 'succeeded', args: { prompt: 'Previous story' } }] },
    };
    state.writes = 0;
    const source = { id: 'example-catalog', updatedAt: '2026-09-01T00:00:00.000Z', payload: { description: 'Example scene' } };
    getIngredient.mockResolvedValue(source);
    const treatment = {
      logline: 'A visitor arrives.', synopsis: 'A visitor explores an imaginary garden.', script: 'The visitor follows a path.',
      scenes: Array.from({ length: 6 }, (_, order) => ({ sceneId: `scene-${order}`, order, intent: 'Explore', prompt: 'A garden path', durationSeconds: 10 })),
      artifact: { references: [{ sourceRevision: 'forged' }] },
    };
    await setTreatment(state.project.id, treatment);
    const saved = await getProject(state.project.id);
    expect(saved.plan.steps).toBeUndefined();
    expect(saved.plan.history[0].steps[0]).toMatchObject({ stepId: 'old-shot', status: 'succeeded' });
    expect(saved.treatment.artifact.references[0]).toEqual({
      kind: 'catalog', id: 'example-catalog', revision: 'user-label', referenceId: 'catalog:example-catalog', sourceRevision: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect((await getVideoSourceStatus(saved)).artifact[0].revisionChanged).toBe(false);
    getIngredient.mockResolvedValue({ ...source, updatedAt: '2026-09-02T00:00:00.000Z' });
    expect((await getVideoSourceStatus(saved)).artifact[0].revisionChanged).toBe(true);
    expect(await getProject(state.project.id)).toEqual(saved);
    getIngredient.mockResolvedValue(null);
    await expect(setTreatment(state.project.id, treatment)).rejects.toMatchObject({ code: 'VIDEO_SOURCE_MISSING' });
    expect(state.writes).toBe(1);
    expect(source.payload).toEqual({ description: 'Example scene' });
  });
});
