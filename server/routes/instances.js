/**
 * Instances API Routes
 *
 * Federation endpoints for managing PortOS peer instances.
 */

import { Router } from 'express';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as instances from '../services/instances.js';
import { getSyncStatus, syncWithPeer } from '../services/syncOrchestrator.js';
import { getFullSyncCoverageForPeer } from '../services/sharing/peerSync.js';
import { provisionTailscaleCert } from '../services/certProvisioner.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { DEFAULT_PEER_PORT } from '../lib/ports.js';
import { findTailscale } from '../lib/tailscale.js';
import { safeJSONParse } from '../lib/fileUtils.js';

const execFileAsync = promisify(execFile);

const router = Router();

// Optional HTTP Basic credential for a peer behind an auth proxy. `null` clears
// it; an object sets it. The service's sanitizePeerAuth does the final
// normalize: the password is the secret that defines the credential, so a
// payload with a password stores it (username optional — password-only is
// valid Basic auth), both fields blank is a clear, and a username-only payload
// is ignored (it's most likely a redacted client peer being round-tripped, and
// must not wipe a stored password).
const peerAuthSchema = z.object({
  username: z.string().max(256).optional(),
  password: z.string().max(2048).optional()
}).nullable().optional();

// Validation schemas
const addPeerSchema = z.object({
  address: z.string()
    .regex(/^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/, 'Must be a valid IP address')
    .refine(ip => !ip.startsWith('127.') && !ip.startsWith('169.254.'), 'Loopback and link-local addresses are not allowed'),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PEER_PORT),
  name: z.string().optional(),
  host: z.string().optional(),
  auth: peerAuthSchema
});

const syncCategoriesSchema = z.object({
  brain: z.boolean().optional(),
  memory: z.boolean().optional(),
  goals: z.boolean().optional(),
  character: z.boolean().optional(),
  digitalTwin: z.boolean().optional(),
  meatspace: z.boolean().optional(),
  universe: z.boolean().optional(),
  pipeline: z.boolean().optional(),
  // Default Zod object parsing strips unknown keys, so every key in
  // DEFAULT_SYNC_CATEGORIES (server/services/instances.js) MUST appear
  // here — otherwise PATCH/PUT updates from the Instances UI silently
  // no-op for the missing category. Same regression class as the
  // universe + pipeline omission tracked in .changelog/NEXT.md.
  mediaCollections: z.boolean().optional(),
  videoHistory: z.boolean().optional(),
  storyBuilder: z.boolean().optional(),
  authors: z.boolean().optional(),
  artists: z.boolean().optional(),
  albums: z.boolean().optional(),
  tracks: z.boolean().optional(),
  creativeDirectorProjects: z.boolean().optional(),
  moodBoards: z.boolean().optional(),
  writersRoomWorks: z.boolean().optional(),
  writersRoomFolders: z.boolean().optional(),
  writersRoomExercises: z.boolean().optional(),
  musicVideoProjects: z.boolean().optional(),
  commissionFeedback: z.boolean().optional(),
  catalog: z.boolean().optional()
}).optional();

const updatePeerSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  syncEnabled: z.boolean().optional(),
  // Full-sync ("mirror everything") mode: implies every current + future sync
  // category and back-subscribes all subscribable records to this peer.
  fullSync: z.boolean().optional(),
  syncCategories: syncCategoriesSchema,
  // Accept empty string to clear; any other string is validated/normalized in the service
  host: z.string().optional().nullable(),
  auth: peerAuthSchema
});

const announceSchema = z.object({
  port: z.number().int().min(1).max(65535),
  instanceId: z.string().guid(),
  name: z.string().optional(),
  // Tailscale-issued DNS name announcing peer reaches itself at; receiver
  // stores it on the peer record so callbacks use https://<host>:<port>.
  host: z.string().optional().nullable()
});

const querySchema = z.object({
  path: z.string().startsWith('/api/', 'Path must start with /api/')
});

// Reciprocal sync request from a peer: it enabled `syncCategories` toward us
// and asks us to mirror them so the sync is bidirectional. instanceId is the
// announcing peer's identity (matched against our peer record).
const reciprocalSyncSchema = z.object({
  instanceId: z.string().guid(),
  // `.unwrap()` strips the `.optional()` from the shared schema so the
  // syncCategories KEY is required. An empty `{}` still parses (all fields are
  // optional) and simply no-ops downstream in applyReciprocalSync
  // (sanitizeSyncCategories returns null → changed:false).
  syncCategories: syncCategoriesSchema.unwrap(),
  // Optional: a full-sync peer asks us to mirror everything back. Absent from
  // older peers (they reciprocate via the all-on syncCategories map instead).
  fullSync: z.boolean().optional()
});

// GET /api/instances — list self + all peers
router.get('/', asyncHandler(async (req, res) => {
  const [self, peers, syncStatus] = await Promise.all([
    instances.getSelf(),
    instances.getPeers(),
    getSyncStatus({ includeChecksums: true })
  ]);
  // Redact each peer's stored proxy password (keep username + hasPassword) —
  // the browser never needs the secret. Mirrors providers' hasApiKey pattern.
  res.json({ self, peers: peers.map(instances.sanitizePeerForClient), syncStatus });
}));

// GET /api/instances/sync-status — local sync sequences + checksums (used by peers during probe)
// A probing peer may pass `?forPeer=<its instanceId>` to also receive OUR cursor
// into its data (`cursorForYou`) — how far we've pulled from it. That cursor is
// the peer's push-frontier toward us, so it can render an outbound "N to push"
// count. Older peers omit the param and get the legacy (inbound-only) shape.
//
// `forPeer` is consumed by getSyncStatus() purely as a cursor-cache KEY
// (`cursors[forPeer]`), never as a structurally-validated id — so we must NOT
// demand canonical GUID format here. The endpoint is reachable by ANY tailnet
// machine (not just peers in our list), and a prober running an older PortOS,
// carrying the `unknown` instance-id sentinel, or emitting a bare `?forPeer=`
// (empty string — which `.guid()` rejects) legitimately hits us; rejecting it
// threw a 500 ServerError every probe cycle instead of degrading to the
// unscoped (global) response. Mirror the lenient trim + length-cap the sibling
// /api/sync/* routes already apply (forPeerOf in dataSync.js): any non-empty
// string is a valid key; absent/blank/array → unscoped.
const syncStatusQuerySchema = z.object({
  forPeer: z.preprocess(
    (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 128) : undefined),
    z.string().optional()
  )
});
router.get('/sync-status', asyncHandler(async (req, res) => {
  const { forPeer } = syncStatusQuerySchema.parse(req.query);
  const status = await getSyncStatus({ includeChecksums: true, forPeer });
  res.json({
    brainSeq: status.local.brainSeq,
    memorySeq: status.local.memorySeq,
    checksums: status.local.checksums,
    // Present only when `forPeer` was supplied and we've synced it before.
    ...(status.cursorForYou ? { cursorForYou: status.cursorForYou } : {})
  });
}));

// GET /api/instances/tailnet-suffix — detect local Tailscale MagicDNS suffix
// so the UI can auto-suggest DNS names (e.g., `iphone181` + `.taile8179.ts.net`)
// for peers that currently use bare IP addresses.
router.get('/tailnet-suffix', asyncHandler(async (req, res) => {
  const bin = findTailscale();
  if (!bin) return res.json({ suffix: null, reason: 'tailscale-not-installed' });
  const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 5000 }).catch(() => ({ stdout: null }));
  if (!stdout) return res.json({ suffix: null, reason: 'tailscale-not-running' });
  // Guard against non-JSON output (warnings, partial reads, etc.) so we never 500 the endpoint.
  const status = safeJSONParse(stdout, null);
  if (!status) return res.json({ suffix: null, reason: 'tailscale-parse-error' });
  const suffix = status?.CurrentTailnet?.MagicDNSSuffix ?? status?.MagicDNSSuffix ?? null;
  // Also include the peer map so the UI can auto-match a peer's instanceId/hostname
  // to its tailnet DNS name without asking the peer.
  const peers = Object.values(status?.Peer ?? {}).map(p => ({
    dnsName: (p.DNSName ?? '').replace(/\.$/, ''),
    hostName: p.HostName ?? null,
    ips: p.TailscaleIPs ?? []
  }));
  res.json({ suffix, self: (status?.Self?.DNSName ?? '').replace(/\.$/, '') || null, peers });
}));

// POST /api/instances/provision-cert — runtime helper for the Tailscale/MagicDNS
// certificate path from `npm run setup:cert` (not the script's self-signed fallback
// or regeneration logic). Fetches a Let's Encrypt cert via `tailscale cert` for
// the local MagicDNS hostname so the user can enable trusted HTTPS without dropping
// to a shell.
router.post('/provision-cert', asyncHandler(async (req, res) => {
  const result = await provisionTailscaleCert();
  if (!result.ok) {
    // Map to apiCore.js error envelope so the client auto-toasts the message.
    throw new ServerError(result.message, { status: 400, code: result.reason });
  }
  res.json(result);
}));

// GET /api/instances/self — get this instance's identity
router.get('/self', asyncHandler(async (req, res) => {
  const self = await instances.getSelf();
  res.json(self);
}));

// PUT /api/instances/self — update display name and/or the new-peer full-sync default
const updateSelfSchema = z.object({
  name: z.string().min(1).optional(),
  // Default full-sync ("mirror everything") mode for peers added from now on.
  defaultPeerFullSync: z.boolean().optional()
}).refine((d) => d.name !== undefined || d.defaultPeerFullSync !== undefined, {
  message: 'Provide name and/or defaultPeerFullSync'
});
router.put('/self', asyncHandler(async (req, res) => {
  const data = updateSelfSchema.parse(req.body);
  const updated = await instances.updateSelf(data.name, { defaultPeerFullSync: data.defaultPeerFullSync });
  if (!updated) throw new ServerError('Self identity not initialized', { status: 500 });
  res.json(updated);
}));

// POST /api/instances/peers/announce — receive announcement from remote peer
router.post('/peers/announce', asyncHandler(async (req, res) => {
  const data = announceSchema.parse(req.body);
  // Derive caller IP from req.ip, stripping ::ffff: prefix for IPv4-mapped addresses
  const rawIp = req.ip || req.socket.remoteAddress || '';
  const address = rawIp.replace(/^::ffff:/, '');
  console.log(`🌐 Announce received from ${data.name || 'unknown'} (raw IP: ${rawIp}, resolved: ${address}, port: ${data.port})`);
  if (!address) throw new ServerError('Could not determine caller IP', { status: 400 });

  const result = await instances.handleAnnounce({
    address,
    port: data.port,
    instanceId: data.instanceId,
    name: data.name,
    host: data.host
  });

  const self = await instances.getSelf();
  res.status(result.created ? 201 : 200).json({
    self: { instanceId: self?.instanceId, name: self?.name },
    // Strip our locally-stored proxy credential before echoing the matched
    // peer back to the announcing instance — that password is our secret for
    // reaching them, not theirs to receive.
    peer: instances.redactPeerForWire(result.peer)
  });
}));

// POST /api/instances/peers — add a peer
router.post('/peers', asyncHandler(async (req, res) => {
  const data = addPeerSchema.parse(req.body);
  // Reject invalid DNS names up front so the UI gets a clear error instead of
  // addPeer() silently dropping the field (validHost returns undefined for invalid input).
  if (data.host !== undefined && data.host !== null && data.host !== '') {
    if (instances.validHost(data.host) === undefined) {
      throw new ServerError('Invalid DNS host — use a hostname like "machine.tailnet.ts.net"', { status: 400 });
    }
  }
  const peer = await instances.addPeer(data);
  res.status(201).json(instances.sanitizePeerForClient(peer));
}));

// PUT /api/instances/peers/:id — update peer
router.put('/peers/:id', asyncHandler(async (req, res) => {
  const data = updatePeerSchema.parse(req.body);
  // Reject invalid DNS names up front so the UI gets a clear error instead of a silent no-op.
  if (data.host !== undefined && data.host !== null && data.host !== '') {
    if (instances.validHost(data.host) === undefined) {
      throw new ServerError('Invalid DNS host — use a hostname like "machine.tailnet.ts.net"', { status: 400 });
    }
  }
  const peer = await instances.updatePeer(req.params.id, data);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  res.json(instances.sanitizePeerForClient(peer));
}));

// DELETE /api/instances/peers/:id — remove peer
router.delete('/peers/:id', asyncHandler(async (req, res) => {
  const removed = await instances.removePeer(req.params.id);
  if (!removed) throw new ServerError('Peer not found', { status: 404 });
  res.json({ success: true });
}));

// POST /api/instances/peers/:id/connect — announce ourselves to this peer (make it mutual)
router.post('/peers/:id/connect', asyncHandler(async (req, res) => {
  const result = await instances.connectPeer(req.params.id);
  if (!result) throw new ServerError('Peer not found', { status: 404 });
  res.json(instances.sanitizePeerForClient(result));
}));

// POST /api/instances/peers/sync-categories — reciprocal-sync callback from a
// peer. The peer enabled some categories toward us and is asking us to mirror
// them so the sync is bidirectional. No :id — the peer is identified by the
// instanceId in the body (we may not know its local-peer-id mapping).
router.post('/peers/sync-categories', asyncHandler(async (req, res) => {
  const data = reciprocalSyncSchema.parse(req.body);
  const { changed } = await instances.applyReciprocalSync(data.instanceId, data.syncCategories, { fullSync: data.fullSync });
  // 200 even when the peer is unknown to us / nothing changed — this is a
  // best-effort convergence signal, not a command that must succeed. We return
  // only `applied` (not the peer record) — the remote caller doesn't consume it,
  // and echoing our peer entry would leak our stored proxy-credential metadata
  // (username + hasPassword) for reaching them across the peer boundary, the
  // same leak the /announce route guards against with redactPeerForWire.
  res.json({ applied: changed });
}));

// POST /api/instances/peers/:id/reciprocate — explicit "make all enabled
// categories mutual" for an existing (likely one-directional) peer. Pushes our
// current category map to the peer so it enables the same toward us.
router.post('/peers/:id/reciprocate', asyncHandler(async (req, res) => {
  const peers = await instances.getPeers();
  const peer = peers.find(p => p.id === req.params.id);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  // Go through the per-peer serialized queue (same path as the auto-reciprocate
  // on toggle) so a manual "Make mutual" can't race an in-flight toggle send and
  // land a stale map. The queue re-reads the freshest persisted categories.
  const result = await instances.enqueueReciprocalSync(peer.id);
  res.json(result ?? { ok: false, reason: 'no-result' });
}));

// POST /api/instances/peers/:id/probe — force immediate probe
router.post('/peers/:id/probe', asyncHandler(async (req, res) => {
  const peers = await instances.getPeers();
  const peer = peers.find(p => p.id === req.params.id);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  const result = await instances.probePeer(peer);
  res.json(instances.sanitizePeerForClient(result));
}));

// POST /api/instances/peers/:id/sync — force an immediate sync with this peer.
// Probe first so the cursor-reset detection has fresh remoteSyncSeqs, then run
// the full sync. syncWithPeer emits `sync:progress` events so the card animates
// live and settles to the new directional summary without a manual refresh.
router.post('/peers/:id/sync', asyncHandler(async (req, res) => {
  const peers = await instances.getPeers();
  const peer = peers.find(p => p.id === req.params.id);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  const probed = await instances.probePeer(peer);
  if (probed?.status !== 'online') {
    throw new ServerError('Peer is offline — cannot sync', { status: 409, code: 'PEER_OFFLINE' });
  }
  const result = await syncWithPeer(probed);
  res.json({ ok: true, result });
}));

// GET /api/instances/peers/:id/full-sync-coverage — real coverage diff backing
// the "fully mirrored ✓ / N pending" indicator for a full-sync peer. Computed
// on demand (it lists every subscribable record), so the client fetches it per
// full-sync peer rather than bloating the polled /instances payload.
router.get('/peers/:id/full-sync-coverage', asyncHandler(async (req, res) => {
  const peers = await instances.getPeers();
  const peer = peers.find(p => p.id === req.params.id);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  // Coverage is keyed by the peer's federation identity; an un-probed peer
  // (no instanceId yet) has no subscriptions, so coverage is trivially empty.
  if (!peer.instanceId) {
    res.json({ total: 0, confirmed: 0, pending: 0, fullyMirrored: true, byKind: {} });
    return;
  }
  const coverage = await getFullSyncCoverageForPeer(peer.instanceId);
  res.json(coverage);
}));

// GET /api/instances/peers/:id/query — proxy GET to peer
router.get('/peers/:id/query', asyncHandler(async (req, res) => {
  const { path } = querySchema.parse(req.query);
  const result = await instances.queryPeer(req.params.id, path);
  if (result.error) throw new ServerError(result.error, { status: 502 });
  res.json(result.data);
}));

export default router;
