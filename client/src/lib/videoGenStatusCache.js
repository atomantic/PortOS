/**
 * Session-scoped cache of the model-shaping half of `GET /api/video-gen/status`.
 *
 * That probe shells out to python and rebuilds the hardware-aware model list on
 * every call, so a cold Video Gen page load leaves the Model picker with nothing
 * to render for a second or two. Caching lets the picker paint from the previous
 * answer while the live probe revalidates behind it.
 *
 * Only `CACHED_FIELDS` is stored, and the read hands it back marked
 * `stale: true`. Everything the payload says about python health — `connected`,
 * `reason`, `missingPackages`, `pythonPath`, `byovRuntimes`, `runtime` — is
 * deliberately dropped rather than guarded, because an interpreter the user just
 * fixed (or just broke) must never be reported from a stored answer, and a field
 * that isn't there can't be read by mistake.
 *
 * Session, not local: the model registry and the python environment both move
 * with an upgrade or an install, and a payload kept for weeks would outlive
 * both.
 */
import { safeReadJsonSession, safeWriteJsonSession } from './safeStorage.js';

// Bump the suffix when `CACHED_FIELDS` changes, so an older tab's entry is
// ignored rather than half-read.
export const VIDEO_GEN_STATUS_CACHE_KEY = 'portos.videoGenStatus.v1';

// The model list plus the numbers that decide which model is selected for it.
const CACHED_FIELDS = ['models', 'defaultModel', 'systemMemoryGb'];

// Returns the cached fields with `stale: true`, or null when nothing usable is
// stored. An entry with no `models` array is worthless here — painting the
// picker is the whole point — so it reads as absent.
export const readCachedVideoGenStatus = () => {
  const cached = safeReadJsonSession(VIDEO_GEN_STATUS_CACHE_KEY);
  if (!cached || typeof cached !== 'object' || !Array.isArray(cached.models)) return null;
  return { ...cached, stale: true };
};

// Store the cacheable slice of a freshly fetched payload.
export const writeCachedVideoGenStatus = (status) => {
  if (!status || typeof status !== 'object' || !Array.isArray(status.models)) return;
  const slice = Object.fromEntries(CACHED_FIELDS.map((field) => [field, status[field]]));
  safeWriteJsonSession(VIDEO_GEN_STATUS_CACHE_KEY, slice);
};
