// Machine-local Review Hub presentation state. The queue remains a live
// projection of source-owned records; this table stores only the user's
// presentation decisions, never a copy of a source payload.
export const reviewQueueTriageDdl = [
  `CREATE TABLE IF NOT EXISTS review_queue_triage (
    action_key TEXT NOT NULL,
    occurrence TEXT NOT NULL DEFAULT '',
    revision TEXT NOT NULL DEFAULT '',
    snoozed_until TIMESTAMPTZ,
    dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
    PRIMARY KEY (action_key, occurrence, revision)
  )`,
];
