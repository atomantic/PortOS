/** Shared authentication-boundary metadata for HTTP API discovery and auth. */

export const ALWAYS_PUBLIC_API_PATHS = Object.freeze([
  '/api/auth/status',
  '/api/auth/whoami',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/system/health',
  '/api/eidoverse/travel/guest',
]);

export const GATED_NON_API_PREFIXES = Object.freeze(['/sdapi/']);

const alwaysPublicPathSet = new Set(ALWAYS_PUBLIC_API_PATHS);

export const isAlwaysPublicApiPath = (path) => alwaysPublicPathSet.has(path);

// The federation surface a paired peer's scoped credential (`method: 'peer'`,
// #8356) may reach. Everything else — agent spawns, app lifecycle, git/file
// routes, settings writes — needs an operator session (#8387), except the
// separately listed one-time Basic-auth pair bootstrap. Each entry
// matches one `path` exactly (a trailing `/` is ignored) or every path under
// `prefix`; `methods: null` admits any method. This list IS the peer contract
// across versions: dropping an entry makes an older peer that still calls it
// fail loudly with 403 PEER_SCOPE_FORBIDDEN, so keep docs/PEER_PUSH_AUTH.md in
// step with it.
const READ = Object.freeze(['GET', 'HEAD']);
const ANY_METHOD = null;

export const PEER_API_SURFACE = Object.freeze([
  // Probe (instances.probePeer) and the peer socket relay's agent snapshot.
  { path: '/api/system/health/details', methods: READ },
  { path: '/api/apps', methods: READ },
  { path: '/api/apps/quality-federation', methods: READ },
  { path: '/api/instances/sync-status', methods: READ },
  { path: '/api/cos/agents', methods: READ },
  // Registration handshake.
  { path: '/api/instances/peers/announce', methods: Object.freeze(['POST']) },
  { path: '/api/instances/peers/sync-categories', methods: Object.freeze(['POST']) },
  // Snapshot / log pulls (syncOrchestrator, brainParity).
  { path: '/api/brain/sync', methods: READ },
  { path: '/api/brain/reconcile/checksum', methods: READ },
  { path: '/api/brain/reconcile/snapshot', methods: READ },
  { path: '/api/brain/reconcile/manifest', methods: READ },
  { path: '/api/memory/sync', methods: READ },
  { path: '/api/catalog/sync', methods: READ },
  { prefix: '/api/sync/', methods: READ },
  // Record push/pull (sharing/*): reads, plus the one inbound push.
  { prefix: '/api/peer-sync/', methods: READ },
  { path: '/api/peer-sync/push', methods: Object.freeze(['POST']) },
  // Peer-facing provider APIs; each applies its own per-peer admission.
  { prefix: '/api/federation/media/v1/', methods: ANY_METHOD },
  { path: '/api/providers/fleet-host', methods: READ },
  { path: '/api/providers/fleet-host/key', methods: Object.freeze(['POST']) },
  { prefix: '/api/eidoverse/travel/federation/', methods: ANY_METHOD },
  // Static asset mounts the sync workers pull bytes from.
  { prefix: '/data/images/', methods: READ },
  { prefix: '/data/image-refs/', methods: READ },
  { prefix: '/data/videos/', methods: READ },
  { prefix: '/data/music/', methods: READ },
  { prefix: '/data/audio/', methods: READ },
  { prefix: '/data/writers-room/works/', methods: READ },
]);

// One explicit, Basic-authenticated bootstrap operation provisions a generated
// pair secret onto the caller's existing peer record. It is deliberately not
// in PEER_API_SURFACE: a scoped peer token cannot change local peer settings.
export const PEER_BASIC_BOOTSTRAP_SURFACE = Object.freeze([
  { path: '/api/instances/peers/pair-secret', methods: Object.freeze(['POST']) },
]);

// Dot segments and empty segments never appear in a URL a peer builds; refusing
// them keeps a prefix match from being argued past by a path that a later layer
// might normalize differently.
const hasAmbiguousSegment = (path) => /\/\/|\/\.\.?(?:\/|$)|%2e|%2f|%5c|\\/i.test(path);

/** Whether a peer credential may call `method path`. `path` must be lowercased. */
export const isPeerApiRequestAllowed = (method, path) => {
  if (typeof path !== 'string' || typeof method !== 'string' || hasAmbiguousSegment(path)) return false;
  const verb = method.toUpperCase();
  const exact = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return PEER_API_SURFACE.some((rule) => (rule.methods === ANY_METHOD || rule.methods.includes(verb))
    && (rule.path ? rule.path === exact : path.startsWith(rule.prefix) && path.length > rule.prefix.length));
};

/** Whether a path is reserved for a caller verified with instance-password Basic auth. */
export const isPeerBasicBootstrapRequest = (method, path) => {
  if (typeof path !== 'string' || typeof method !== 'string' || hasAmbiguousSegment(path)) return false;
  const verb = method.toUpperCase();
  const exact = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return PEER_BASIC_BOOTSTRAP_SURFACE.some((rule) => rule.methods.includes(verb) && rule.path === exact);
};
