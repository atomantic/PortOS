/** Shared peer registry fields, redaction and host normalization. */
import { resolveEffectiveCategories } from '../../lib/instanceSyncCategories.js';

export const PROBE_TIMEOUT_MS = 5000;

// Strip the locally-stored proxy credential before a peer record crosses the
// wire (e.g. the announce response echoes the matched local peer back to the
// announcing instance). The password is OUR secret for reaching THEM and must
// never leak to the peer itself. Consumer routing policy and cached capacity
// are local-only too, so peers cannot discover or influence our assignments.
export function redactPeerForWire(peer) {
  if (!peer || typeof peer !== 'object') return peer;
  if (!('auth' in peer) && !('mediaProvider' in peer) && !('mediaDeleteAllowed' in peer) && !('mediaProviderStatus' in peer)
    && !('tcAddress' in peer) && !('syncSecret' in peer)) {
    return peer;
  }
  const {
    auth: _auth,
    syncSecret: _syncSecret,
    mediaProvider: _mediaProvider,
    mediaDeleteAllowed: _mediaDeleteAllowed,
    mediaProviderStatus: _mediaProviderStatus,
    tcAddress: _tcAddress,
    ...rest
  } = peer;
  return rest;
}

// Redact the stored credential before a peer record is returned to the local
// client (API responses + socket broadcasts). Keeps the non-secret username
// and a `hasPassword` marker so the UI can show "credential set" and prefill
// the username, but never ships the password to the browser — mirrors the
// `hasApiKey` pattern in server/routes/providers/presenter.js. The password stays only
// on the server-side record, where peerAuthHeaders reads it.
export function sanitizePeerForClient(peer) {
  if (!peer || typeof peer !== 'object') return peer;
  const auth = peer.auth && typeof peer.auth === 'object'
    ? { username: peer.auth.username ?? '', hasPassword: Boolean(peer.auth.password) }
    : peer.auth;
  // EFFECTIVE categories, not the raw stored map — the SAME resolution the sync
  // loop runs. Shipping the raw map would render a default-ON category's
  // checkbox off while the server is actively syncing it (and make turning it
  // off take two clicks), and a second, subtly different resolver here would
  // put the UI and the sync loop back out of step on the legacy no-map peer.
  // `masterSwitch: false` — show what the user has CONFIGURED, not what the
  // master switch currently lets through. The UI renders `peer.syncEnabled`
  // separately, so masking here would hide the stored selection: every box on a
  // `syncEnabled: false` peer would read unchecked, and ticking one would
  // silently reactivate every other category still true underneath it.
  const { tcAddress: _tcAddress, syncSecret: _syncSecret, ...safePeer } = peer;
  return { ...safePeer, auth, hasSyncSecret: Boolean(peer.syncSecret), syncCategories: resolveEffectiveCategories(peer, { masterSwitch: false }) };
}

export function validName(name, fallback) {
  if (!name || typeof name !== 'string') return fallback;
  if (!name.trim()) return fallback;
  return name.trim();
}

/**
 * Peer display names, hosts, addresses and instance IDs can identify a machine.
 * Keep server logs generic so runtime sync events do not persist that data.
 */
export function peerLogLabel(ordinal = null) {
  return Number.isInteger(ordinal) && ordinal >= 0 ? `peer ${ordinal + 1}` : 'peer';
}

// Returns: null = explicit clear, undefined = invalid input (callers should
// ignore), string = valid lowercased hostname. Three-state distinction lets
// callers choose between "noisy/optional input" (use undefined) vs "user
// asked to clear" (use null).
function validHost(str) {
  if (str === '' || str === null) return null;
  if (typeof str !== 'string') return undefined;
  const trimmed = str.trim();
  if (!trimmed) return null;
  // Accept DNS names: letters, digits, hyphens, dots. No scheme, no port, no path.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

export { validHost };

// How this install obtains the image/video BYTES behind a synced Media
// Collection from a peer: `copy` downloads them into local `data/` (default —
// the historical behavior), `host` keeps only the references and streams each
// file from the peer on demand (see services/peerHostedMedia.js).
export const MEDIA_SYNC_MODES = Object.freeze(['copy', 'host']);
export const DEFAULT_MEDIA_SYNC_MODE = 'copy';
// A peer registered from now on hosts rather than copies, so pairing a machine
// no longer multiplies every render. The absent field keeps reading as `copy`:
// a peer paired before this default keeps the mode it has always had.
export const NEW_PEER_MEDIA_SYNC_MODE = 'host';
export const peerMediaSyncMode = (peer) => (MEDIA_SYNC_MODES.includes(peer?.mediaSyncMode) ? peer.mediaSyncMode : DEFAULT_MEDIA_SYNC_MODE);

// Standing capability: may this paired peer delete media on THIS machine?
// Peers are trusted; the grant is ON unless the operator explicitly refuses it
// (an absent field reads as allowed). Announce-created peers store no field: an
// announcement alone grants nothing, and the delete route separately requires a
// pair-authenticated caller. Machine-local — set per peer in Instances.
export const peerMayDeleteMedia = (peer) => peer?.mediaDeleteAllowed !== false;
