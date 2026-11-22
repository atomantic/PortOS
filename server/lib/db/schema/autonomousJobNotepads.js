// Machine-local per-job durable KV notepad for CoS Autonomous Jobs (#17392).
// Keyed by the job's string id (jobs live in data/cos/autonomous-jobs.json, so
// there is no FK); deleteJob clears a job's rows. Never federated.
export const autonomousJobNotepadsDdl = [
  `CREATE TABLE IF NOT EXISTS autonomous_job_notepads (
    job_id TEXT NOT NULL,
    key TEXT COLLATE "C" NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, key)
  )`,
];
