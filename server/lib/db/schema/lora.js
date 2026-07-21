// LoRA training-run DDL. Extracted verbatim from ensureSchemaImpl() in
// server/lib/db.js (#2832); idempotent, runs on every boot.
export const loraDdl = [
    // LoRA training runs (character LoRA training). MUST live here, not only
    // in init-db.sql — init-db.sql runs only on fresh `db.sh setup-native`
    // provisioning, so existing installs + federated peers get new tables
    // exclusively through this boot-time upgrade path. Mirrors init-db.sql.
    `CREATE TABLE IF NOT EXISTS lora_training_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      character_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lora_training_runs_status ON lora_training_runs (status)`,
    `CREATE INDEX IF NOT EXISTS idx_lora_training_runs_character ON lora_training_runs (character_id)`,

];
