/**
 * Who made a federated media file that no record attributes? A copy pulled
 * before `suppliedByInstanceId` existed looks exactly like media made here, so
 * the only surviving evidence is time: the creator wrote the bytes before any
 * copy could exist. Pure, so the claim rule is one place to audit.
 */

// A file time further apart than clock skew explains is evidence; a closer one is not.
export const ORIGIN_CLAIM_SKEW_MS = 5 * 60 * 1000;

const validMs = (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;

/**
 * `holders` is every OTHER paired machine that reported holding the file:
 * `{ peerId, mtimeMs, mayDelete }`. Returns the instance id that made it, or
 * null (fail closed) when no holder reported, any time is unusable, the
 * earliest is tied or within skew of the next, or the earliest is a peer that
 * may not delete media here (naming it would grant it delete authority).
 */
export function earliestHolderOrigin({ localId, localMtimeMs, holders, skewMs = ORIGIN_CLAIM_SKEW_MS }) {
  if (typeof localId !== 'string' || !localId || !validMs(localMtimeMs)) return null;
  if (!Array.isArray(holders) || holders.length === 0) return null;
  if (holders.some((holder) => typeof holder?.peerId !== 'string' || !holder.peerId || !validMs(holder.mtimeMs))) return null;
  const ranked = [{ id: localId, ms: localMtimeMs, mayDelete: true }, ...holders.map((h) => ({ id: h.peerId, ms: h.mtimeMs, mayDelete: h.mayDelete === true }))]
    .sort((a, b) => a.ms - b.ms);
  if (ranked[1].ms - ranked[0].ms <= skewMs) return null;
  return ranked[0].mayDelete ? ranked[0].id : null;
}
