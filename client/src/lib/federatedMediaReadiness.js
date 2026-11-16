/**
 * One reading of "is this peer usable as a media provider right now?"
 *
 * The Instances peer card and the System Health capacity panel must not
 * disagree, so the state machine, labels and remedy text live here. The server
 * stays authoritative: `assertFederatedMediaProviderSelection`
 * (server/services/federatedMediaConsumer.js) re-probes and fail-closes before
 * any job leaves this instance; `usable` only gates the client's submit
 * affordance.
 */

import { Film, Image, Music2 } from 'lucide-react';

// Every surface iterates this table so a newly federated kind cannot appear on
// one screen and be missing from another.
export const FEDERATED_MEDIA_KINDS = Object.freeze([
  { kind: 'audio', label: 'audio', field: 'audioModels', Icon: Music2 },
  { kind: 'image', label: 'image', field: 'imageModels', Icon: Image },
  { kind: 'video', label: 'video', field: 'videoModels', Icon: Film },
]);

export const FEDERATED_MEDIA_STATE_META = Object.freeze({
  ready: { label: 'ready', tone: 'success' },
  busy: { label: 'busy', tone: 'warning' },
  stale: { label: 'stale', tone: 'warning' },
  unauthorized: { label: 'auth required', tone: 'warning' },
  unsupported: { label: 'older peer', tone: 'note' },
  disabled: { label: 'provider off', tone: 'note' },
  unavailable: { label: 'unavailable', tone: 'warning' },
  unreachable: { label: 'unreachable', tone: 'warning' },
  invalid: { label: 'invalid status', tone: 'warning' },
});

export const FEDERATED_MEDIA_STATE_HELP = Object.freeze({
  busy: 'The peer is reachable, but its shared media lane is currently at capacity.',
  stale: 'The last capacity snapshot expired. New remote work is blocked until a fresh probe succeeds.',
  unauthorized: 'Store this peer’s instance-password credential above and make sure this instance is registered there.',
  unsupported: 'This peer does not expose the federated-media wire-v1 status endpoint yet.',
  disabled: 'Enable federated media sharing on the peer under Settings → Sharing.',
  unavailable: 'The peer has no currently ready allowlisted media runtime/model.',
  unreachable: 'The media status request failed. New remote work remains blocked.',
  invalid: 'The peer returned a response that did not match the versioned media-provider contract.',
});

// Peer-level readings that outrank the last probe. Each carries its own remedy
// because the wire's `state` may be absent (or stale-but-`ready`) while one holds.
// PEER_DISABLED comes first, as on the server (MEDIA_PROVIDER_PEER_DISABLED is
// rejected before anything else), so a switched-off peer never reads `ready`.
const PEER_DISABLED = Object.freeze({
  label: 'peer disabled',
  tone: 'warning',
  help: 'This peer connection is switched off. Re-enable it under Instances before routing work to it.',
});
// Not a real provider state — opted in but no probe has landed yet. Distinct
// from `unavailable` so a first-run instance doesn't accuse a healthy peer.
const CHECKING = Object.freeze({ label: 'checking', tone: 'muted' });
const OFF = Object.freeze({ label: 'off', tone: 'note' });
const PEER_OFFLINE = Object.freeze({ label: 'peer offline', tone: 'warning' });
// Shared empty array: callers memoize on `capabilities`, and a fresh literal
// per call would defeat that memo.
const NO_CAPABILITIES = Object.freeze([]);
// A peer with no snapshot is the common fresh-instance case; avoid allocating.
const NO_QUEUE_SEGMENTS = Object.freeze([]);

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
// NUL separator, matching the server's own model key: a printable separator
// would let an engine name containing it collide with a different pair.
export const federatedMediaModelKey = ({ engine, modelId }) => `${engine}\u0000${modelId}`;
const listOf = (raw, field) => (Array.isArray(raw?.[field]) ? raw[field] : []);

/**
 * The peer's locally-stored provider config, with every kind's list present.
 * @returns {{raw: object, enabled: boolean, models: Record<string, object[]>}}
 */
export function peerMediaProviderConfig(peer) {
  const raw = isRecord(peer?.mediaProvider) ? peer.mediaProvider : {};
  const models = {};
  for (const { kind, field } of FEDERATED_MEDIA_KINDS) models[kind] = listOf(raw, field);
  return { raw, enabled: raw.enabled === true, models };
}

// States that assert currently-available capacity; only these need a
// verifiable freshness window (the others never got a snapshot to date).
const CAPACITY_CLAIMING_STATES = new Set(['ready', 'busy']);

/**
 * The state a stored status has actually earned, which is not always the one it
 * records: `freshUntil` is written at probe time and the record then sits on the
 * peer until the next poll, so a status probed as `ready` would keep saying so
 * after the server would refuse to submit. Re-deriving at render time closes
 * that gap without a second probe.
 *
 * The checks below the guard mirror, in order, the gates
 * `assertFederatedMediaProviderSelection` applies before submitting. They fail
 * CLOSED: an absent or unparseable `freshUntil` parses to NaN, and reading NaN
 * as "not expired" would advertise a provider with no verifiable window.
 *
 * Only the shape is checked; the server does the authoritative wire validation.
 */
function verifiedState(status, now) {
  const state = status?.state;
  const freshUntil = Date.parse(status?.freshUntil);
  if (Number.isFinite(freshUntil) && freshUntil < now) return 'stale';
  // A failure state makes no capacity claim, so it needs nothing to back one.
  if (!CAPACITY_CLAIMING_STATES.has(state)) return state;
  if (!Number.isFinite(freshUntil)) return 'stale';
  if (!isRecord(status.snapshot)) return 'invalid';
  return state;
}

// Input-assets overlap fallback, mirroring FEDERATED_MEDIA_LEGACY_FEATURE_TELL
// in server/lib/federatedMediaWire.js: a provider on the previous build
// advertises this per-model fact in the capability block, not at the status
// root. `Object.create(null)` because the key is a wire feature name and
// `'constructor'` and friends must not resolve to inherited values.
const LEGACY_FEATURE_TELL = Object.freeze(Object.assign(Object.create(null), {
  inputAssets: (capability) => isRecord(capability?.inputAssets),
}));

/**
 * Does the build that sent this status speak `feature`? Client mirror of
 * `federatedMediaSupports` (server/lib/federatedMediaWire.js), and the ONE place
 * the "absent reads as false" reasoning lives on this side.
 *
 * A provider built before a feature shipped omits it and rejects the field at
 * submission, so reading absence as consent would offer a render the peer
 * answers with a 400. Display only; the route and admission re-check.
 *
 * A published list WINS over the legacy tell rather than being OR'd with it: a
 * peer that told us its whole vocabulary and omitted the feature has denied it.
 *
 * @param {object|null} status - a peer's `mediaProviderStatus.snapshot`
 * @param {string} feature - 'lyrics' | 'inputAssets'
 * @param {object|null} [capability] - for the input-assets overlap fallback
 *   against a peer that has not migrated yet
 * @returns {boolean} false whenever the answer cannot be established
 */
export function federatedMediaSupports(status, feature, capability = null) {
  if (Array.isArray(status?.features)) return status.features.includes(feature);
  return LEGACY_FEATURE_TELL[feature]?.(capability) === true;
}

/** The validated (shape-checked only) status payload behind a peer's last probe, or null. */
export const peerMediaProviderSnapshot = (peer) => (isRecord(peer?.mediaProviderStatus?.snapshot)
  ? peer.mediaProviderStatus.snapshot
  : null);

const isCount = (value) => Number.isInteger(value) && value >= 0;

// "<label> 1 running, 2 queued", or null when nothing is there to report.
const occupancySegment = (label, entry) => {
  if (!isRecord(entry) || !isCount(entry.running) || !isCount(entry.queued)) return null;
  const parts = [];
  if (entry.running > 0) parts.push(`${entry.running} running`);
  if (entry.queued > 0) parts.push(`${entry.queued} queued`);
  return parts.length > 0 ? `${label} ${parts.join(', ')}` : null;
};

/**
 * The peer's queue block as finished display segments (phrases, not numbers), so
 * every surface shows the same words. `concurrency` and `byKind` are omitted by
 * older providers; their segments are dropped rather than shown as a zero that
 * would claim an idle lane the peer never reported on.
 *
 * @param {object|null} queue - `snapshot.queue` from a probed peer
 * @returns {string[]} segments to render in order, possibly empty
 */
export function summarizePeerMediaQueue(queue) {
  if (!isRecord(queue)) return NO_QUEUE_SEGMENTS;
  const segments = [];
  // Machine-wide: every local render competes for these slots, so this predicts a wait.
  if (isCount(queue.totalActive) && isCount(queue.maxQueuedJobs)) {
    segments.push(`${queue.totalActive}/${queue.maxQueuedJobs} shared slots active`);
  }
  if (isCount(queue.concurrency) && queue.concurrency > 0) {
    segments.push(`runs ${queue.concurrency} at a time`);
  }
  // Also machine-wide; only kinds holding a lane are reported.
  const byKind = isRecord(queue.byKind) ? queue.byKind : {};
  for (const { kind, label } of FEDERATED_MEDIA_KINDS) {
    const segment = occupancySegment(label, byKind[kind]);
    if (segment) segments.push(segment);
  }
  // Labelled so it cannot be read as the whole picture (an unlabelled "0 running"
  // beside "audio 1 running" says the peer is both busy and idle).
  const federated = occupancySegment('federated', queue);
  if (federated) segments.push(federated);
  return segments;
}

/**
 * Resolve one peer's media-provider readiness for display.
 *
 * @param {object} peer - a sanitized peer record from `GET /api/instances`
 * @param {{now?: number}} [options]
 * @returns {{configured: boolean, state: string|null, usable: boolean, label: string,
 *   tone: string, help: string|null, queue: object|null, capabilities: object[],
 *   checkedAt: string|null, models: Record<string, object[]>, modelCount: number,
 *   kinds: string[]}}
 */
export function resolvePeerMediaReadiness(peer, { now = Date.now() } = {}) {
  const config = peerMediaProviderConfig(peer);
  const status = isRecord(peer?.mediaProviderStatus) ? peer.mediaProviderStatus : null;
  const snapshot = peerMediaProviderSnapshot(peer);
  // An unverifiable status loses even the `ready` it concluded at probe time.
  const state = status ? verifiedState(status, now) : null;
  // `state` is the provider's own verdict and says nothing about whether this peer
  // is switched on or reachable; composing the two here keeps a surface from
  // enabling a button for a disabled/offline peer holding a stale fresh snapshot.
  const blocked = peer?.enabled === false
    ? PEER_DISABLED
    : !config.enabled
      ? OFF
      : peer?.status !== 'online'
        ? PEER_OFFLINE
        : null;
  const meta = blocked ?? (FEDERATED_MEDIA_STATE_META[state] || CHECKING);
  return {
    configured: config.enabled,
    state,
    // The one reading a caller should gate work on.
    usable: !blocked && state === 'ready',
    label: meta.label,
    tone: meta.tone,
    // Peer-level readings carry their own remedy; an offline peer gets none.
    help: meta.help !== undefined
      ? meta.help
      : ((config.enabled && state && state !== 'ready' && FEDERATED_MEDIA_STATE_HELP[state]) || null),
    queue: isRecord(snapshot?.queue) ? snapshot.queue : null,
    capabilities: Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : NO_CAPABILITIES,
    checkedAt: typeof status?.checkedAt === 'string' ? status.checkedAt : null,
    models: config.models,
    modelCount: FEDERATED_MEDIA_KINDS.reduce((sum, { kind }) => sum + config.models[kind].length, 0),
    kinds: FEDERATED_MEDIA_KINDS.filter(({ kind }) => config.models[kind].length > 0).map(({ kind }) => kind),
  };
}

/**
 * The models of one kind a peer will actually accept work for right now.
 *
 * Both lists must agree: the LOCAL allowlist (`mediaProvider.<kind>Models`) is
 * what `assertFederatedMediaProviderSelection` checks on submit, while the
 * peer's advertised `capabilities` carries live readiness. The union would list
 * a model the server refuses; the allowlist alone would hide why one can't run.
 *
 * Returns the advertised capability objects (so callers get `ready` /
 * `unavailableReason`) and the shared empty array when nothing qualifies, for
 * memoization.
 *
 * @param {object} peer - a sanitized peer record from `GET /api/instances`
 * @param {'audio'|'image'|'video'} kind
 * @returns {object[]} capability entries, possibly empty
 */
export function federatedMediaModelsForPeer(peer, kind) {
  if (!FEDERATED_MEDIA_KINDS.some((entry) => entry.kind === kind)) return NO_CAPABILITIES;
  const { models } = peerMediaProviderConfig(peer);
  const allowed = new Set(models[kind]
    .filter((model) => model?.engine && model?.modelId)
    .map(federatedMediaModelKey));
  if (allowed.size === 0) return NO_CAPABILITIES;
  const advertised = peerMediaProviderSnapshot(peer)?.capabilities;
  if (!Array.isArray(advertised)) return NO_CAPABILITIES;
  const matched = advertised.filter((capability) => capability?.kind === kind
    && allowed.has(federatedMediaModelKey(capability)));
  return matched.length > 0 ? matched : NO_CAPABILITIES;
}

/**
 * Does this advertised capability accept a conditioning image in `role`
 * (`initImage` / `referenceImages` / `sourceImage` / `lastImage`)?
 *
 * **Absent reads as NO**: the peer's BUILD must speak conditioning (the
 * `inputAssets` feature, via `federatedMediaSupports`) AND THIS MODEL must
 * advertise the role. Mirrors the server's `inputAssetRejection`
 * (`server/services/federatedMedia/inputAssets.js`); display only.
 *
 * @param {object|null} capability - an entry from `federatedMediaModelsForPeer`
 * @param {string} role
 * @param {object|null} [status] - the peer snapshot the capability came from
 * @returns {boolean}
 */
export function peerModelAcceptsInput(capability, role, status = null) {
  if (!federatedMediaSupports(status, 'inputAssets', capability)) return false;
  const roles = capability?.inputAssets?.roles;
  return Array.isArray(roles) && roles.includes(role);
}

/**
 * Can this model render nothing at all without a conditioning image? True for
 * an edit-only image model or a video model with no text-to-video mode — both
 * are advertisable only because conditioning now crosses, so a text-only
 * submission to one is refused rather than queued.
 *
 * @param {object|null} capability
 * @returns {boolean}
 */
export const peerModelRequiresInput = (capability) => capability?.inputAssets?.required === true;
