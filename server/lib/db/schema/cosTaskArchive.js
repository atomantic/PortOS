// Machine-local archive of completed CoS tasks. The task files keep the open
// queue plus a recent window of completed tasks; everything older lives here,
// prompt bodies included (they are what made TASKS.md / COS-TASKS.md tens of MB).
// `description` is a light projection so scans that only need titles never
// detoast the JSONB. Never enters federation payloads.
export const cosTaskArchiveDdl = [
  `CREATE TABLE IF NOT EXISTS cos_task_archive (
    source TEXT NOT NULL CHECK (source IN ('user', 'internal')),
    task_id TEXT COLLATE "C" NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    completed_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    task JSONB NOT NULL,
    PRIMARY KEY (source, task_id)
  )`,
];
