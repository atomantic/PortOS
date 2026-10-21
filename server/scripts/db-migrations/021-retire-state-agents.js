/**
 * Retire the `agents` map from `data/cos/state.json` (#12738).
 *
 * Runs after 020 has committed (migrations apply in order, each in its own
 * transaction). Before touching the file it re-verifies that every record in the
 * map is stored in `cos_agents` with identical bytes, and throws (stopping boot)
 * if not, so the map is only ever removed once its records are rows. The
 * original file is kept beside it as `state.json.imported` — the recovery copy,
 * which nothing reads — then state.json is rewritten without the key. With no
 * map left there is nothing to do, so a re-run (or a fresh install) is a no-op.
 */
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../../../scripts/migrations/_lib.js';
import { cosStatePath, readCosStateAgents } from './_cosStateAgents.js';

export async function up(client) {
  const { state, agents } = await readCosStateAgents();
  if (!state || !Object.hasOwn(state, 'agents')) return;
  const entries = Object.entries(agents ?? {});
  if (entries.length > 0) {
    const { rows } = await client.query(
      'SELECT agent_id, agent::text AS body FROM cos_agents WHERE agent_id = ANY($1::text[])',
      [entries.map(([id]) => id)],
    );
    const byId = new Map(rows.map((row) => [row.agent_id, row.body]));
    const missing = entries.filter(([id, agent]) => byId.get(id) !== JSON.stringify(agent)).length;
    if (missing > 0) {
      throw new Error(`CoS agents: ${missing} of ${entries.length} state.json records are not stored in cos_agents; refusing to retire the map`);
    }
  }
  const path = cosStatePath();
  const aside = existsSync(`${path}.imported`) ? `${path}.imported-${Date.now()}` : `${path}.imported`;
  await copyFile(path, aside);
  const { agents: _retired, ...rest } = state;
  await writeJsonAtomic(path, rest);
  console.log(`🗄️ CoS agents: retired the agents map from state.json (${entries.length} record(s); original kept as ${aside.split('/').pop()})`);
}
