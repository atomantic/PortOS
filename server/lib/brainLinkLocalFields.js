/**
 * Brain link fields that describe THIS machine's clone and the actions queued
 * against it. They steer local execution (clone retry replays `repoIntake`,
 * scan/pull/study/open-folder act on `localPath`), so a peer must never set them
 * and they are never shipped to one: another machine's clone path is wrong here,
 * and a peer-chosen `repoIntake` would run its instructions in a local agent.
 */
export const BRAIN_LINK_MACHINE_LOCAL_FIELDS = Object.freeze([
  'localPath',
  'cloneStatus',
  'cloneError',
  'cloneInstanceId',
  'cloneInterrupted',
  'malwareScan',
  'repoIntake',
  'repoStudy',
]);

/** Copy of a link record without its machine-local fields. Non-link/non-object input is returned unchanged. */
export function stripLinkMachineLocalFields(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = { ...record };
  for (const field of BRAIN_LINK_MACHINE_LOCAL_FIELDS) delete out[field];
  return out;
}

/**
 * The record to store when a peer's link `incoming` lands over `existing`: every
 * synced field from the peer, every machine-local field from this machine (or
 * absent when this machine has no live copy).
 */
export function mergeIncomingLinkRecord(incoming, existing) {
  const merged = stripLinkMachineLocalFields(incoming);
  if (!existing || existing._deleted) return merged;
  for (const field of BRAIN_LINK_MACHINE_LOCAL_FIELDS) {
    if (field in existing) merged[field] = existing[field];
  }
  return merged;
}
