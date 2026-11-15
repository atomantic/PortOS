/**
 * Strip the retired release-candidate transfer state from live CoS agents (#16104).
 *
 * #15998 removed the lineage-transfer ceremony, so nothing writes
 * `metadata.releaseCandidateRecovery` (held / transferred) or
 * `metadata.releaseCandidateSuccessor` any more and no reader remains. Legacy
 * live records still carry them; an ownership read must not depend on them.
 *
 * Gated on its INPUT (rows whose stored JSON contains either key); it derives
 * no output and ships no seed. Archived agent records keep the fields since
 * nothing reads them. The store version is bumped only when a row changed, so a
 * cache planned before this ran cannot write the old bodies back.
 */
const RETIRED_KEYS = ['releaseCandidateRecovery', 'releaseCandidateSuccessor'];

export async function up(client) {
  const { rows } = await client.query(
    `SELECT agent_id, agent::text AS body FROM cos_agents
     WHERE agent::text LIKE '%releaseCandidateRecovery%' OR agent::text LIKE '%releaseCandidateSuccessor%'`,
  );
  let stripped = 0;
  for (const row of rows) {
    const agent = JSON.parse(row.body);
    const metadata = agent?.metadata;
    if (!metadata || typeof metadata !== 'object' || !RETIRED_KEYS.some((key) => Object.hasOwn(metadata, key))) continue;
    for (const key of RETIRED_KEYS) delete metadata[key];
    await client.query('UPDATE cos_agents SET agent = $2::json WHERE agent_id = $1', [row.agent_id, JSON.stringify(agent)]);
    stripped += 1;
  }
  if (stripped === 0) return;
  await client.query(
    `INSERT INTO cos_agent_store (id, version) VALUES (1, 1)
     ON CONFLICT (id) DO UPDATE SET version = cos_agent_store.version + 1`,
  );
  console.log(`🗄️ CoS agents: stripped retired release-candidate transfer state from ${stripped} record(s)`);
}
