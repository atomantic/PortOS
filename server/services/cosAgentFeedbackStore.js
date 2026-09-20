/**
 * Durable references for pending CoS agent feedback.
 *
 * PostgreSQL is authoritative in a normal install. The JSON backend exists only
 * for the documented development/test escape hatch, mirroring the other
 * machine-local stores without making file storage a supported deployment mode.
 * The record deliberately contains no task prose or rating.
 */

import { join } from 'node:path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend } from '../lib/pgFileFacade.js';

const pendingFile = () => join(PATHS.data, 'cos-pending-agent-feedback.json');
const queueFileWrite = createFileWriteQueue();

const normalizeRef = (value) => {
  if (!value || typeof value.agentId !== 'string' || !value.agentId) return null;
  return {
    agentId: value.agentId,
    archiveDate: typeof value.archiveDate === 'string' && value.archiveDate ? value.archiveDate : null,
  };
};

async function readFileRefs() {
  const raw = await readJSONFile(pendingFile(), [], { allowArray: true, logError: false, strict: true });
  return (Array.isArray(raw) ? raw : []).map(normalizeRef).filter(Boolean);
}

function makeFileBackend() {
  return {
    name: 'file',
    list: readFileRefs,
    upsert: (ref) => queueFileWrite(async () => {
      const refs = await readFileRefs();
      const next = normalizeRef(ref);
      const index = refs.findIndex((entry) => entry.agentId === next.agentId);
      if (index === -1) refs.push(next);
      else refs[index] = next;
      await atomicWrite(pendingFile(), refs);
    }),
    remove: (agentId) => queueFileWrite(async () => {
      const refs = await readFileRefs();
      const next = refs.filter((entry) => entry.agentId !== agentId);
      if (next.length !== refs.length) await atomicWrite(pendingFile(), next);
    }),
  };
}

function makePgBackend(db) {
  return {
    name: 'postgres',
    async list() {
      const { rows } = await db.query(
        'SELECT agent_id, archive_date FROM cos_pending_agent_feedback ORDER BY archive_date DESC NULLS LAST, agent_id',
      );
      return rows.map((row) => ({ agentId: row.agent_id, archiveDate: row.archive_date || null }));
    },
    async upsert(ref) {
      await db.query(
        `INSERT INTO cos_pending_agent_feedback (agent_id, archive_date)
         VALUES ($1, $2)
         ON CONFLICT (agent_id) DO UPDATE SET archive_date = EXCLUDED.archive_date`,
        [ref.agentId, ref.archiveDate],
      );
    },
    async remove(agentId) {
      await db.query('DELETE FROM cos_pending_agent_feedback WHERE agent_id = $1', [agentId]);
    },
  };
}

const backendFacade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: 'CoS feedback references require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the file escape hatch)',
    loadDb: () => import('../lib/db.js'),
    makePg: makePgBackend,
  }),
});

export async function listPendingAgentFeedbackRefs() {
  return (await backendFacade.getBackend()).list();
}

export async function upsertPendingAgentFeedbackRef(ref) {
  const normalized = normalizeRef(ref);
  if (!normalized) return;
  await (await backendFacade.getBackend()).upsert(normalized);
}

export async function removePendingAgentFeedbackRef(agentId) {
  if (typeof agentId !== 'string' || !agentId) return;
  await (await backendFacade.getBackend()).remove(agentId);
}

/** Test seam for suites that swap the file data root between cases. */
export function resetPendingAgentFeedbackStore() {
  backendFacade.reset();
}
