/**
 * `earliestHolderOrigin({ localId, localMtimeMs, holders })` — the instance id that made an
 * unattributed federated media file, from the strictly earliest file time among its holders.
 *
 * Null (fail closed) on a tie, clock-skew gap, missing report or a peer that may not delete media
 * here. `localOriginMayBeReplaced({ mtimeMs, createdAt })` — whether that proof may replace this
 * machine's own origin claim (file written well after `createdAt`, or no `createdAt`).
 *
 * Evidence is time only: the creator wrote the bytes before any copy existed. Pure.
 */

// A file time further apart than clock skew explains is evidence; a closer one is not.
export const ORIGIN_CLAIM_SKEW_MS = 5 * 60 * 1000;

const validMs = (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;

// `holders`: other paired machines `{ peerId, mtimeMs, mayDelete }`; naming one that may not delete media would grant it delete authority.
export function earliestHolderOrigin({ localId, localMtimeMs, holders, skewMs = ORIGIN_CLAIM_SKEW_MS }) {
  if (typeof localId !== 'string' || !localId || !validMs(localMtimeMs)) return null;
  if (!Array.isArray(holders) || holders.length === 0) return null;
  if (holders.some((holder) => typeof holder?.peerId !== 'string' || !holder.peerId || !validMs(holder.mtimeMs))) return null;
  const ranked = [{ id: localId, ms: localMtimeMs, mayDelete: true }, ...holders.map((h) => ({ id: h.peerId, ms: h.mtimeMs, mayDelete: h.mayDelete === true }))]
    .sort((a, b) => a.ms - b.ms);
  if (ranked[1].ms - ranked[0].ms <= skewMs) return null;
  return ranked[0].mayDelete ? ranked[0].id : null;
}

// A file written more than the skew after `createdAt` is a later-arriving copy; no usable `createdAt` leaves the proof to decide.
export function localOriginMayBeReplaced({ mtimeMs, createdAt, skewMs = ORIGIN_CLAIM_SKEW_MS }) {
  const createdMs = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(createdMs)) return true;
  return validMs(mtimeMs) && mtimeMs - createdMs > skewMs;
}
