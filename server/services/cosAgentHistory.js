/**
 * Agent records from live state PLUS the dated archive.
 *
 * `getAgents()` drops a finished agent once `completedAgentRetentionMs` expires
 * (24h by default), so a consumer that must see an earlier run after a delay
 * (an approval-gated follow-up, a retry) has to read the archive buckets too.
 */

const DAY_MS = 86_400_000;

/**
 * @param {Object} options
 * @param {number} options.endAt - newest instant to cover, epoch ms
 * @param {number} options.lookbackDays - archive buckets to read, ending at `endAt`'s day
 * @returns {Promise<object[]>} deduplicated by agent id; the resident record wins
 */
export async function getAgentsWithArchive({ endAt, lookbackDays }) {
  const days = Array.from({ length: lookbackDays }, (_, back) =>
    new Date(endAt - back * DAY_MS).toISOString().slice(0, 10));
  // Loaded on first lookup so importing this module does not pull the agent lifecycle/index storage graphs.
  const [{ getAgents }, { getAgentsByDate }] = await Promise.all([
    import('./cosAgentLifecycle.js'),
    import('./cosAgentIndex.js'),
  ]);
  const lists = await Promise.all([
    getAgents().catch(() => []),
    ...days.map(day => getAgentsByDate(day, { repairSummaries: false }).catch(() => [])),
  ]);
  // A record can be resident and archived at once; lists[0] is the resident one.
  const byId = new Map();
  for (const agent of lists.flat()) {
    if (agent && !byId.has(agent.id)) byId.set(agent.id, agent);
  }
  return [...byId.values()];
}
