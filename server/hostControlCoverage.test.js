/**
 * Host control over the mounted route graph (#12952, #16018).
 *
 * Every `/api` write needs operator authority by default (lib/hostControlRoutes.js),
 * so a new route needs no classification. This guard reads the live mounted
 * route graph (`getApiRouteCatalog`, sub-routers included) and pins the two
 * places where the default does not decide:
 *   - the writes that bypass the gate, which must be exactly the reviewed
 *     non-operator surfaces below — a route added under one of those prefixes
 *     (or a new public prefix) fails here until someone reviews its admission;
 *   - HOST_CONTROL_GET_ROUTES, every entry of which must name a mounted GET, so
 *     a rename cannot silently ungate a sensitive read.
 */
import { describe, expect, it } from 'vitest';
import { isAlwaysPublicApiPath, isPeerApiRequestAllowed, isPeerBasicBootstrapRequest } from './lib/apiAccessPolicy.js';
import { getApiRouteCatalog } from './lib/apiRouteGraph.js';
import { API_REGISTRY } from './lib/apiRegistry.js';
import { HOST_CONTROL_GET_ROUTES, hostControlGetRouteFor, isHostControlRoute } from './lib/hostControlRoutes.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// 'METHOD /path' as the route catalog spells it, with the admission each applies.
const OPEN_WRITES = {
  // ALWAYS_PUBLIC_API_PATHS: auth.js owns the session lifecycle.
  'POST /api/auth/login': 'public',
  'POST /api/auth/logout': 'public',
  // PEER_API_SURFACE: peer credentials are confined here, and each handler
  // checks the calling peer's own grants or capabilities.
  'POST /api/eidoverse/travel/federation/chat': 'peer',
  'POST /api/eidoverse/travel/federation/leave': 'peer',
  'POST /api/eidoverse/travel/federation/visit': 'peer',
  'POST /api/federation/admin/v1/execute': 'peer',
  'POST /api/federation/admin/v1/execution/dispatch': 'peer',
  'POST /api/federation/admin/v1/execution/preflight': 'peer',
  'POST /api/federation/admin/v1/execution/status': 'peer',
  'POST /api/federation/admin/v1/plans': 'peer',
  'POST /api/federation/admin/v1/preflight': 'peer',
  'POST /api/federation/admin/v1/receipt': 'peer',
  'POST /api/federation/media/v1/assets': 'peer',
  'POST /api/federation/media/v1/jobs': 'peer',
  'POST /api/federation/media/v1/jobs/:id/cancel': 'peer',
  'POST /api/instances/peers/announce': 'peer',
  'POST /api/instances/peers/sync-categories': 'peer',
  'POST /api/peer-media/delete': 'peer',
  'POST /api/peer-media/release': 'peer',
  'POST /api/peer-sync/push': 'peer',
  'POST /api/providers/fleet-host/key': 'peer',
  // PEER_BASIC_BOOTSTRAP_SURFACE: provisions a pair secret over legacy Basic.
  'POST /api/instances/peers/pair-secret': 'peer-bootstrap',
  // Managed-app visitor broker: app credentials, local same-origin apps only.
  'POST /api/managed-visitors/v1/admissions': 'managed-visitor',
  'POST /api/managed-visitors/v1/admissions/cancel': 'managed-visitor',
  'POST /api/managed-visitors/v1/sessions/:id/actions': 'managed-visitor',
  'POST /api/managed-visitors/v1/sessions/:id/leave': 'managed-visitor',
  'POST /api/managed-visitors/v1/sessions/:id/observations': 'managed-visitor',
  // Opt-in public API (lib/apiRegistry.js): the router requires host control
  // while the operator has not exposed it.
  'POST /api/voice/public/synthesize': 'exposed-api',
  // Outside /api: the A1111-compatible surface gates Codex/Grok/Antigravity
  // backends in its handler (#11138); options is a read over POST.
  'POST /sdapi/v1/options': 'exposed-api',
  'POST /sdapi/v1/txt2img': 'exposed-api',
};

const catalog = () => getApiRouteCatalog().routes;

// Which surface's admission a route answers to, from the policy modules
// themselves (a catalog `:param` segment stands in for any value).
const admissionOf = (method, path) => {
  const lower = path.toLowerCase();
  if (isAlwaysPublicApiPath(lower)) return 'public';
  if (isPeerApiRequestAllowed(method, lower)) return 'peer';
  if (isPeerBasicBootstrapRequest(method, lower)) return 'peer-bootstrap';
  if (/^\/api\/managed-visitors\/v1(?:\/|$)/.test(lower)) return 'managed-visitor';
  if (API_REGISTRY.some((entry) => entry.publicPrefixes.some((prefix) => lower.startsWith(prefix)))) return 'exposed-api';
  return 'operator';
};

describe('host-control default over mounted writes (#16018)', () => {
  it('opens only the reviewed non-operator surfaces; every other mounted write is gated', () => {
    const open = Object.fromEntries(catalog()
      .filter(({ method, path }) => !READ_METHODS.has(method) && !isHostControlRoute(method, path))
      .map(({ method, path }) => [`${method} ${path}`, admissionOf(method, path)]));
    // Keys pin which writes bypass the gate; values pin whose admission each answers to.
    expect(open).toEqual(OPEN_WRITES);
  });
});

describe('HOST_CONTROL_GET_ROUTES', () => {
  it('names only mounted GET routes, so a rename cannot silently ungate one', () => {
    // A catalog path keeps its `:param` / `*wildcard` tokens, which the
    // compiled patterns accept as ordinary segment text.
    const reached = new Set(catalog().map(({ method, path }) => hostControlGetRouteFor(method, path)).filter(Boolean));
    expect(HOST_CONTROL_GET_ROUTES.filter((route) => !reached.has(route))).toEqual([]);
  });

  it('lists each gated read once', () => {
    expect(HOST_CONTROL_GET_ROUTES.filter((route, index) => HOST_CONTROL_GET_ROUTES.indexOf(route) !== index)).toEqual([]);
  });
});
