/**
 * Which HTTP requests need operator authority (#8716, #16018).
 *
 * `hostControlRouteGate` in services/authGate.js applies `requireHostControl`
 * to every request `isHostControlRoute` names: an operator session when a
 * password is set (a signed-in human or a PortOS-spawned agent's
 * `PORTOS_API_TOKEN` session), or a local connection when none is. A peer
 * credential (scoped token or legacy Basic) never qualifies, and a remote
 * LAN/tailnet caller on a password-free install is refused (#8226).
 *
 * The policy is default-deny for writes: every `/api/*` request whose method is
 * not GET, HEAD or OPTIONS needs host control, except the explicit non-operator
 * surfaces below, each of which applies its own admission:
 *   - ALWAYS_PUBLIC_API_PATHS (login, logout, guest travel; lib/apiAccessPolicy.js);
 *   - the federation surface (PEER_API_SURFACE) and the one-time Basic pair
 *     bootstrap (PEER_BASIC_BOOTSTRAP_SURFACE), which authGate confines peer
 *     credentials to and whose handlers check the peer's own grants;
 *   - the managed-app visitor broker (`/api/managed-visitors/v1`), whose app
 *     credentials work only for a local same-origin app (services/managedVisitors.js);
 *   - the opt-in public API prefixes under `/api/` (lib/apiRegistry.js), whose
 *     routers require host control themselves while the API is not exposed.
 *
 * Reads stay open unless listed in HOST_CONTROL_GET_ROUTES: a GET that streams
 * live capture, exports private archives or host listings, steers or reads the
 * signed-in managed browser, or runs a process per request. A GET that only
 * needs host control for part of its answer checks `requestHasHostControl` in
 * its handler instead (GET /api/browser strips page and download listings).
 * The socket twin is HOST_CONTROL_SOCKET_EVENTS in services/socket.js; voice and
 * palette tools that reach these operations without HTTP carry `hostControl: true`.
 *
 * Patterns are `METHOD /path` with Express-style `:param` (one segment) and
 * `*name` (the rest of the path). Matching is case-insensitive and tolerates
 * trailing slashes, as Express routing does, so a request cannot reach a listed
 * handler by a spelling this list does not match. HEAD follows GET.
 */

import { isAlwaysPublicApiPath, isPeerApiRequestAllowed, isPeerBasicBootstrapRequest } from './apiAccessPolicy.js';
import { API_REGISTRY } from './apiRegistry.js';
import { escapeRegExp } from './textUtils.js';

export const HOST_CONTROL_GET_ROUTES = Object.freeze([
  // Live camera and microphone feeds (#11272).
  'GET /api/media/video',
  'GET /api/media/audio',
  // Tailcat serve capabilities (the remote ingress and its bearer address) and device trust.
  'GET /api/instances/peers/tailcat/serve',
  'GET /api/instances/peers/tailcat/devices',
  // Progress of a forge sign-in the operator started on the host.
  'GET /api/apps/:id/forge-auth/refresh/:jobId/events',
  // Raw backup archives export private records and credentials (#8772).
  'GET /api/backup/snapshots/:snapshotId/download',
  // The directory picker lists any readable host directory, not a PortOS record.
  'GET /api/scaffold/directories',
  // Status of a Topaz upscale, part of the gated host upscale workflow (#11076).
  'GET /api/video-gen/upscale/topaz/jobs/:jobId/status',
  // DCP packaging progress, reports and the package's host location.
  'GET /api/music-video/dcp/:jobId/events',
  'GET /api/music-video/:id/dcp/:artifactId/report',
  'GET /api/music-video/:id/dcp/:artifactId/location',
  // Discovers host applications for the code-animation runtime.
  'GET /api/code-animation/execution/blender-candidates',
  // Which binaries, args and endpoints a provider can run with (#8721).
  'GET /api/providers/:id/execution-options',
  // The managed browser carries the operator's signed-in sessions and saves
  // downloads silently, so listing its pages or downloads is operator work
  // (#12488); browser and harness update checks belong to the gated installers (#8798).
  'GET /api/browser/update-preflight',
  'GET /api/browser/pages',
  'GET /api/browser/downloads',
  'GET /api/browser/downloads/:name',
  'GET /api/harnesses/update-reference',
  // The private FableLoom package an export produced.
  'GET /api/fableloom/:id/export/:jobId/download',
  // Reads the Signal Safe Storage keychain secret and the database it decrypts.
  'GET /api/signal/setup-check',
  // Decodes the song master with ffmpeg; the client shows a refusal as unavailable.
  'GET /api/music-video/:id/dependency-impact',
  // Re-encodes the video with ffmpeg on every request (#13156).
  'GET /api/video-gen/history/:id/sharing-download',
  // Opens or reuses a tab in the signed-in managed browser and reads it.
  'GET /api/youtube/setup-check',
]);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MANAGED_VISITOR_BROKER = /^\/api\/managed-visitors\/v1(?:\/|$)/;
const PUBLIC_API_PREFIXES = Object.freeze(API_REGISTRY
  .flatMap((entry) => entry.publicPrefixes)
  .filter((prefix) => prefix.startsWith('/api/')));

const compileRoute = (route) => {
  const [method, path] = route.split(' ');
  const body = path.split('/').slice(1).map((segment) => {
    if (segment.startsWith(':')) return '[^/]+';
    if (segment.startsWith('*')) return '.+';
    return escapeRegExp(segment);
  }).join('/');
  // A mount can consume one slash before its root handler accepts another.
  return { route, method, pattern: new RegExp(`^/${body}/*$`, 'i') };
};

const COMPILED_GET_ROUTES = HOST_CONTROL_GET_ROUTES.map(compileRoute);

const isApiPath = (path) => path === '/api' || path.startsWith('/api/');

/**
 * Whether a write to `path` belongs to a non-operator surface with its own
 * admission. `method` is uppercase and `path` lowercase.
 */
const isOpenWriteSurface = (method, path) => {
  return isAlwaysPublicApiPath(path.replace(/\/+$/, ''))
    || isPeerApiRequestAllowed(method, path)
    || isPeerBasicBootstrapRequest(method, path)
    || MANAGED_VISITOR_BROKER.test(path)
    || PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix));
};

/** The HOST_CONTROL_GET_ROUTES entry a GET/HEAD `method path` matches, or null. */
export const hostControlGetRouteFor = (method, path) => {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return null;
  return COMPILED_GET_ROUTES.find((entry) => entry.pattern.test(path))?.route ?? null;
};

/** Whether `method path` (an Express `req.method` / `req.path`) needs operator authority. */
export const isHostControlRoute = (method, path) => {
  if (typeof method !== 'string' || typeof path !== 'string') return false;
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) return hostControlGetRouteFor(verb, path) !== null;
  const lower = path.toLowerCase();
  return isApiPath(lower) && !isOpenWriteSurface(verb, lower);
};
