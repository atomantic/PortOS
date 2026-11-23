/**
 * Postgres-backed check that the Persistent Mind lookup index exists after
 * ensureSchema() and matches the active-memory-by-agent query predicate.
 */
import { describe, expect, it } from 'vitest';
import { checkHealth, ensureSchema, query } from '../../db.js';
import { requireDbOrSkip } from '../../dbTestGate.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((error) => ({ connected: false, error: error?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}

const runDb = requireDbOrSkip('lib/db/schema/memorySourceAgentIndex.db.test', dbReady, skipReason);

describe.skipIf(!runDb)('memories source-agent active index', () => {
  it('is a partial (source_agent_id, importance DESC) index on active agent-owned rows', async () => {
    const { rows } = await query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'memories' AND indexname = 'idx_memories_source_agent_active'",
    );
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef;
    expect(def).toContain('(source_agent_id, importance DESC)');
    expect(def).toContain("'active'::text");
    expect(def).toContain('source_agent_id IS NOT NULL');
  });
});
