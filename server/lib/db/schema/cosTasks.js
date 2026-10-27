// The CoS task queues (user + internal), one row per task. `task` is the task in
// its stored form (see lib/cosTaskRows.js); the other columns are the projections
// the queries need: status for the open queue and history paging, priority and
// position for queue order, completed_at for the recent-completed window.
// `cos_task_lists.version` bumps on every write so a cached read can tell
// whether anything changed without loading rows. Machine-local, never federated.
export const cosTasksDdl = [
  `CREATE TABLE IF NOT EXISTS cos_release_synchronizations (
    identity TEXT PRIMARY KEY,
    record JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cos_tasks (
    source TEXT NOT NULL CHECK (source IN ('user', 'internal')),
    task_id TEXT COLLATE "C" NOT NULL,
    status TEXT NOT NULL,
    priority_value INTEGER NOT NULL DEFAULT 2,
    position DOUBLE PRECISION NOT NULL,
    completed_at TIMESTAMPTZ,
    description TEXT NOT NULL DEFAULT '',
    task JSONB NOT NULL,
    PRIMARY KEY (source, task_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cos_tasks_open ON cos_tasks (source, status) WHERE status <> 'completed'`,
  `CREATE INDEX IF NOT EXISTS idx_cos_tasks_completed ON cos_tasks (source, completed_at DESC NULLS LAST, task_id DESC) WHERE status = 'completed'`,
  `CREATE TABLE IF NOT EXISTS cos_task_lists (
    source TEXT PRIMARY KEY CHECK (source IN ('user', 'internal')),
    version BIGINT NOT NULL DEFAULT 0
  )`,
];
