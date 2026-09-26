/**
 * Durable Code Animation job records. PostgreSQL indexes the gallery metadata;
 * the generated HTML stays in its managed data directory as a file asset.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { query } from '../../lib/db.js';
import { PATHS } from '../../lib/paths.js';
import { atomicWrite } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANIMATIONS_DIR = join(PATHS.data, 'code-animations');

export function isCodeAnimationJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

function htmlPath(id) {
  if (!isCodeAnimationJobId(id)) {
    throw new ServerError('Code Animation job not found', { status: 404, code: 'NOT_FOUND' });
  }
  return join(ANIMATIONS_DIR, `${id}.html`);
}

export async function listCodeAnimationJobRecords() {
  const { rows } = await query(
    `SELECT id, status, title, concept, provider_id AS "providerId", model,
            created_at AS "createdAt"
       FROM code_animation_jobs
      ORDER BY created_at DESC, id DESC`,
  );
  return rows;
}

export async function listRunningCodeAnimationJobIds() {
  const { rows } = await query("SELECT id FROM code_animation_jobs WHERE status = 'running'");
  return rows.map(({ id }) => id);
}

export async function listCodeAnimationJobPage({ limit, cursor }) {
  const { rows } = await query(
    `SELECT id, status, COALESCE(NULLIF(title, ''), LEFT(concept, 120)) AS title,
            provider_id AS "providerId", model, created_at AS "createdAt"
       FROM code_animation_jobs
      WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::text))
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  return rows;
}

export async function countCodeAnimationJobs() {
  const { rows } = await query(
    `SELECT COUNT(*)::integer AS total,
            COUNT(*) FILTER (WHERE status = 'running')::integer AS running,
            COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed
       FROM code_animation_jobs`,
  );
  return rows[0];
}

export async function getCodeAnimationJobRecord(id) {
  if (!isCodeAnimationJobId(id)) return null;
  const { rows } = await query('SELECT data FROM code_animation_jobs WHERE id = $1', [id]);
  return rows[0]?.data ?? null;
}

export async function saveCodeAnimationJobRecord(job) {
  await query(
    `INSERT INTO code_animation_jobs
       (id, status, title, concept, provider_id, model, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       title = EXCLUDED.title,
       concept = EXCLUDED.concept,
       provider_id = EXCLUDED.provider_id,
       model = EXCLUDED.model,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [job.id, job.status, job.title, job.input?.concept || '', job.providerId, job.model, JSON.stringify(job), job.createdAt, job.updatedAt],
  );
  return job;
}

export async function saveCodeAnimationHtml(id, html) {
  const destination = htmlPath(id);
  await atomicWrite(destination, html);
}

export async function readCodeAnimationHtml(id) {
  try {
    return await readFile(htmlPath(id), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ServerError('The generated animation file is missing', {
        status: 500,
        code: 'CODE_ANIMATION_OUTPUT_MISSING',
      });
    }
    throw error;
  }
}
