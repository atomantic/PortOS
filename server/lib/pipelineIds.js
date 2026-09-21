// Path-segment guards for pipeline snapshots. Keep the historical safe charset:
// these assertions do not require the stricter ser-/iss- prefixes used on import.
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function assertValidSeriesId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid series id: ${id}`);
  }
}

export function assertValidIssueId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid issue id: ${id}`);
  }
}
