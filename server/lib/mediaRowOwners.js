/**
 * Candidate instances that may hold a media row's bytes, most authoritative first.
 * `hostedIndex` is the peer-hosted-media entries map: `{ '<kind>:<filename>': { peerId } }`.
 * Returns a de-duplicated list; empty means the owner is unknowable.
 */
export function rowOwnerCandidates(row, hostedIndex) {
  const out = [];
  const add = (id) => { if (typeof id === 'string' && id && !out.includes(id)) out.push(id); };
  if (!row || typeof row !== 'object') return out;
  add(row.originInstanceId);
  if (typeof row.filename === 'string' && row.filename && hostedIndex && typeof hostedIndex === 'object') {
    for (const [key, entry] of Object.entries(hostedIndex)) {
      if (key.slice(key.indexOf(':') + 1) === row.filename) add(entry?.peerId);
    }
  }
  add(row.suppliedByInstanceId);
  return out;
}
