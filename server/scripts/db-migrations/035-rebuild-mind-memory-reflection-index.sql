-- Reflection filters on decayed importance, so high stored importance can still qualify.
DROP INDEX IF EXISTS idx_memories_mind_reflection;
CREATE INDEX idx_memories_mind_reflection ON memories (source_agent_id, created_at, id)
  WHERE status = 'active' AND source_agent_id IS NOT NULL;
