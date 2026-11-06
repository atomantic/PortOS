// Bound source selection by owner and age before loading any memory prose.
export async function up(client) {
  await client.query("CREATE INDEX IF NOT EXISTS idx_memories_mind_reflection ON memories (source_agent_id, created_at, id) WHERE status = 'active' AND importance < 0.15");
}
