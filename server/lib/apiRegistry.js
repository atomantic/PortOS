/**
 * Public API registry — the single source of truth for which PortOS services
 * are usable as externally-callable HTTP APIs.
 *
 * One declaration here drives THREE consumers, so they can never drift:
 *   1. `authGate` (server/lib/authGate.js) — when the PortOS password is on, an
 *      entry that is `exposed && !requireAuth` re-opens ONLY its `publicPrefixes`
 *      so external callers can reach it without a session.
 *   2. The Settings UI (VoiceTab + the API Access page) — renders the per-API
 *      `exposed` / `requireAuth` toggles via `resolveApiAccess()`.
 *   3. The OpenAPI spec builder (server/lib/openapiSpec.js) — documents each
 *      exposed API's `docPaths`.
 *
 * SECURITY INVARIANT: `publicPrefixes` lists ONLY read/compute-safe surfaces.
 * Config-mutation / process-control routes (e.g. `/api/voice/config`,
 * `/api/voice/whisper`) are deliberately NOT listed here and stay gated. The
 * voice API uses a dedicated `/api/voice/public/*` mount precisely so the
 * public surface is an explicit allowlist that cannot accidentally grow when a
 * new route is added to the main `/api/voice` router.
 *
 * Per-API runtime state (`exposed`, `requireAuth`) lives in the top-level
 * `apiAccess` settings key — NOT under `secrets` (which is stripped from
 * GET /api/settings), so the client can read these flags to render toggles.
 */

// Static declaration. `defaults` apply when an install has no persisted
// `apiAccess.<settingsKey>` value yet (fresh install / pre-migration): both
// APIs default to NOT exposed (nothing on the network until the user opts in)
// and passwordless (requireAuth:false) once exposed.
export const API_REGISTRY = [
  {
    id: 'voice',
    label: 'Voice / TTS',
    description: 'Text-to-speech synthesis and voice enumeration (Kokoro, Piper).',
    publicPrefixes: ['/api/voice/public/'],
    settingsKey: 'voice',
    defaults: { exposed: false, requireAuth: false },
    docPaths: [
      '/api/voice/public/synthesize',
      '/api/voice/public/voices',
      '/api/voice/public/engines',
    ],
  },
  {
    id: 'sdapi',
    label: 'Image Gen (A1111-compatible)',
    description: 'AUTOMATIC1111-compatible txt2img + model/sampler catalog.',
    publicPrefixes: ['/sdapi/'],
    settingsKey: 'sdapi',
    defaults: { exposed: false, requireAuth: false },
    docPaths: [
      '/sdapi/v1/txt2img',
      '/sdapi/v1/sd-models',
      '/sdapi/v1/samplers',
      '/sdapi/v1/options',
      '/sdapi/v1/progress',
    ],
  },
];

// Resolve one registry entry's runtime flags against persisted settings,
// falling back to the entry's defaults when `apiAccess.<settingsKey>` is absent
// OR carries a non-boolean value. Accepting ONLY real booleans is a security
// requirement, not just hygiene: the auth gate calls this against settings read
// straight off disk (it bypasses the PUT /api/settings Zod validation), so a
// hand-edited / corrupted `"exposed": "false"` must NOT be treated as truthy
// and open the route. A non-boolean falls back to the (closed-by-default)
// value, so corruption fails safe.
const asBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const resolveEntry = (entry, settings) => {
  const persisted = settings?.apiAccess?.[entry.settingsKey] ?? {};
  return {
    ...entry,
    exposed: asBool(persisted.exposed, entry.defaults.exposed),
    requireAuth: asBool(persisted.requireAuth, entry.defaults.requireAuth),
  };
};

/**
 * True iff some registry entry is `exposed && !requireAuth` AND `path` starts
 * with one of that entry's `publicPrefixes`. This is the ONLY thing that
 * re-opens a gated prefix when the PortOS password is on — and it matches only
 * `publicPrefixes`, so mutation routes outside those prefixes stay gated.
 * @param {object} settings full settings object (NOT the secrets-stripped copy)
 * @param {string} path request path (req.path)
 * @returns {boolean}
 */
export const isRegistryPublic = (settings, path) => {
  if (typeof path !== 'string') return false;
  for (const entry of API_REGISTRY) {
    const { exposed, requireAuth } = resolveEntry(entry, settings);
    if (!exposed || requireAuth) continue;
    if (entry.publicPrefixes.some((prefix) => path.startsWith(prefix))) return true;
  }
  return false;
};

/**
 * Merge each registry entry's static metadata with its persisted `exposed` /
 * `requireAuth` flags. Consumed by the Settings UI and the OpenAPI builder.
 * @param {object} settings full settings object
 * @returns {Array<object>} registry entries decorated with resolved flags
 */
export const resolveApiAccess = (settings) =>
  API_REGISTRY.map((entry) => resolveEntry(entry, settings));
