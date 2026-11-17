/**
 * Music Video render spend ledger: paid renders a project's media jobs completed and the
 * manual adjustments a user made to true up against a provider balance (#16506).
 *
 * Storage: `db-primary` (`music_video_render_spend`) — machine-local, never federated: the
 * renders were billed to this install's provider accounts, and a peer keeps its own ledger.
 * Kept out of the project record so the media job list can be pruned and a project write can
 * never drop an entry. Additive boot DDL with no seed or backfill (takes priced before the
 * ledger existed still count through `summarizeRenderSpend`); the JSON adapter is dev/test only.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '../../lib/db.js';
import { toPgJson } from '../../lib/pgJson.js';
import { createPgFileFacade, resolvePgBackend } from '../../lib/pgFileFacade.js';
import { atomicWrite, readJSONFile, PATHS } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { ServerError } from '../../lib/errorHandler.js';

const queueWrite = createFileWriteQueue();
const file = () => join(PATHS.data, 'music-video-render-spend.json');
const read = () => readJSONFile(file(), [], { allowArray: true, strict: true });
const byTime = (a, b) => String(a.at).localeCompare(String(b.at));

const store = createPgFileFacade({
  makeFile: () => ({
    upsert: (entry) => queueWrite(async () => {
      const entries = await read();
      await atomicWrite(file(), [...entries.filter((e) => e.id !== entry.id), entry]);
    }),
    list: async (projectId) => (await read()).filter((e) => e.projectId === projectId).sort(byTime),
    remove: (projectId, id) => queueWrite(async () => {
      const entries = await read();
      const kept = entries.filter((e) => !(e.id === id && e.projectId === projectId));
      if (kept.length !== entries.length) await atomicWrite(file(), kept);
      return kept.length !== entries.length;
    }),
  }),
  makePg: () => resolvePgBackend({
    requirement: 'PostgreSQL is required for the Music Video spend ledger',
    loadDb: () => import('../../lib/db.js'),
    makePg: () => ({
      upsert: (entry) => query(
        `INSERT INTO music_video_render_spend (id, project_id, data, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [entry.id, entry.projectId, toPgJson(entry), entry.at],
      ),
      list: async (projectId) => (await query(
        'SELECT data FROM music_video_render_spend WHERE project_id = $1 ORDER BY created_at, id', [projectId],
      )).rows.map((row) => row.data),
      remove: async (projectId, id) => (await query(
        'DELETE FROM music_video_render_spend WHERE id = $1 AND project_id = $2', [id, projectId],
      )).rowCount > 0,
    }),
  }),
});

/** Record (or re-record) one render's entry; keyed by job, so a repeated completion lands once. */
export async function recordRenderSpend(entry) {
  await (await store.getBackend()).upsert(entry);
  return entry;
}

export async function listRenderSpend(projectId) {
  return (await store.getBackend()).list(projectId);
}

/** The render entry for an asset this project rendered (a video's history id, an image's filename). */
export async function findRenderSpendForAsset(projectId, mediaKind, assetId) {
  return (await listRenderSpend(projectId)).find((e) => e.entryKind === 'render' && e.mediaKind === mediaKind && e.assetId === assetId) || null;
}

export async function addRenderSpendAdjustment(projectId, { lane, usd, statedUsd = null, note = null }) {
  const entry = {
    id: `adjustment:${randomUUID()}`, entryKind: 'adjustment', projectId, lane, usd,
    ...(statedUsd != null ? { statedUsd } : {}), note: note || null, at: new Date().toISOString(),
  };
  await (await store.getBackend()).upsert(entry);
  return entry;
}

/** Remove a manual adjustment; recorded renders are not removable. */
export async function deleteRenderSpendAdjustment(projectId, id) {
  if (!id.startsWith('adjustment:') || !(await (await store.getBackend()).remove(projectId, id))) {
    throw new ServerError('Spend adjustment not found', { status: 404, code: 'NOT_FOUND' });
  }
}
