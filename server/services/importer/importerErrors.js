/** Defines the importer policy error codes surfaced by the HTTP routes. */

// Surfaced to the route layer so the importer's policy errors become 400s
// with stable codes.
export const ERR_VALIDATION = 'IMPORTER_VALIDATION';
export const ERR_LOCKED = 'IMPORTER_LOCKED';
// Thrown when the issue-loop fails mid-flight after universe + series writes
// already landed. Universe/series are preserved; the partial issue set is
// rolled back. Retrying commit is safe (merges are idempotent).
export const ERR_PARTIAL_COMMIT_ISSUES = 'IMPORTER_PARTIAL_COMMIT_ISSUES';
// Thrown when a retry sends a DIFFERENT issue list while an earlier attempt's
// planned issues still exist (#10762) — resuming would pair the old issues with
// the wrong proposals, and starting over would duplicate them.
export const ERR_IMPORT_IN_PROGRESS = 'IMPORTER_IMPORT_IN_PROGRESS';
