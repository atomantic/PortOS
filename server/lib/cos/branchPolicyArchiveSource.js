/** Read authoritative CoS archive membership and validate archived agent records for policy lookup. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isPlainObject } from '../objects.js';

/** A missing index is empty only when there is no unaccounted-for archive layout. */
export async function readBranchPolicyArchiveIndex(dir, liveIds = new Set()) {
  const raw = await readFile(join(dir, 'index.json'), 'utf8').catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    const entries = await readdir(dir).catch(missing => { if (missing.code === 'ENOENT') return []; throw missing; });
    if (entries.some(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry) || (entry.startsWith('agent-') && !liveIds.has(entry)))) throw error;
    return '{}';
  });
  const index = JSON.parse(raw);
  if (!isPlainObject(index)) throw new Error('agent index is not an object');
  return index;
}

export function validateBranchPolicyArchiveRow(id, date) {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('agent index has a malformed row');
  }
}

export async function readBranchPolicyArchiveRecord(dir, id, date) {
  const recordDir = join(dir, date, id);
  try {
    const agent = JSON.parse(await readFile(join(recordDir, 'metadata.json'), 'utf8'));
    if (!isPlainObject(agent) || (agent.id || agent.agentId) !== id) throw new Error('id mismatch');
    return agent;
  } catch (error) {
    // Only a missing directory establishes a legacy dangling pointer.
    if (error.code === 'ENOENT' && await stat(recordDir).then(() => false, missing => missing.code === 'ENOENT')) return null;
    throw Object.assign(new Error(`archived agent record ${id} is unreadable: ${error.message}`), { code: error.code });
  }
}
