// Machine-local references to completed manual CoS runs that still need a user
// rating. The agent archive remains authoritative for the run and its rating;
// this table stores only the id plus the date-bucket locator so retention and
// restart cannot silently erase the action.
export const cosAgentFeedbackDdl = [
  `CREATE TABLE IF NOT EXISTS cos_pending_agent_feedback (
    agent_id TEXT PRIMARY KEY,
    archive_date TEXT
  )`,
];
