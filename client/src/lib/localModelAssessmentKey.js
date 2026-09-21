const KEY_VERSION = 1;

const isValidTuple = (value) => (
  value
  && typeof value === 'object'
  && !Array.isArray(value)
  && value.version === KEY_VERSION
  && typeof value.backend === 'string'
  && value.backend.length > 0
  && typeof value.modelId === 'string'
  && value.modelId.length > 0
  && (value.tuningKey === null || typeof value.tuningKey === 'string')
);

const toBase64Url = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const fromBase64Url = (value) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/**
 * Encode the identity of one persisted assessment for a path segment.
 *
 * Base64url keeps `/`, `:`, spaces, unicode, and tuning punctuation out of the
 * route grammar. `null` is intentional: it is the stable identity of a run
 * taken with the backend defaults, not the absence of a tuning choice.
 */
export function encodeLocalModelAssessmentKey({ backend, modelId, tuningKey = null } = {}) {
  if (typeof backend !== 'string' || !backend || typeof modelId !== 'string' || !modelId) return null;
  const tuple = { version: KEY_VERSION, backend, modelId, tuningKey: tuningKey || null };
  return `v${KEY_VERSION}-${toBase64Url(JSON.stringify(tuple))}`;
}

/**
 * Decode and validate a selected-assessment path segment.
 *
 * Invalid, stale, or tampered keys return null so the page can offer recovery
 * without guessing at a record or starting a provider run.
 */
export function decodeLocalModelAssessmentKey(key) {
  if (typeof key !== 'string' || !key.startsWith(`v${KEY_VERSION}-`)) return null;
  try {
    const value = JSON.parse(fromBase64Url(key.slice(`v${KEY_VERSION}-`.length)));
    return isValidTuple(value)
      ? { backend: value.backend, modelId: value.modelId, tuningKey: value.tuningKey }
      : null;
  } catch {
    return null;
  }
}

export function localModelAssessmentPath(entry) {
  const key = encodeLocalModelAssessmentKey(entry);
  return key ? `/models/performance/results/${key}` : '/models/performance/results';
}
