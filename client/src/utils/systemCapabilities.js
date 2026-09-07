/**
 * Browser-side helpers for the server's hardware compatibility annotations.
 * The browser does not re-probe the host: the server owns detection, and an
 * absent annotation stays compatible for older servers and custom records.
 */

export const isHardwareCompatible = (compatibility) => compatibility?.state !== 'unavailable';

export const isHardwareAvailable = (item) => isHardwareCompatible(item?.hardwareCompatibility);

// Mirrors `hardwareUnavailableReason` in `server/lib/systemCapabilities.js` so a
// refusal reads identically whether the server rendered it or the browser did.
// The reason list is what the server annotated; the browser never re-probes.
export const hardwareUnavailableReason = (subject, compatibility) => (
  `${subject} is unavailable on this machine: ${
    (compatibility?.reasons || []).join(' · ') || 'this host does not meet its hardware requirements'}`
);

export const filterHardwareCompatibleModels = (models, { includeUnavailable = false } = {}) => {
  const list = Array.isArray(models) ? models : [];
  return includeUnavailable ? list : list.filter(isHardwareAvailable);
};
