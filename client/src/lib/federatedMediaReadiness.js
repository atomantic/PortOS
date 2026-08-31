/**
 * One reading of "is this peer usable as a media provider right now?" (#4348).
 *
 * Two surfaces answer that question — the Instances peer card (which also
 * edits the per-kind allowlist) and the System Health capacity panel — and they
 * must not disagree: a card reading `ready` beside a panel reading `stale` is
 * worse than either alone. The state machine, its labels, and the remedy text
 * therefore live here rather than inside one component.
 *
 * The server stays authoritative: `assertFederatedMediaProviderSelection`
 * (server/services/federatedMediaConsumer.js) re-probes and fail-closes before
 * any job leaves this instance. What `usable` gates is the client's own
 * submit affordance, so a peer the server would refuse is refused before the
 * user commits to it rather than after.
 */

import { Film, Image, Music2 } from 'lucide-react';

// Wire v1 shipped audio-only, then grew image and video (#4348). Every surface
// iterates this table so a newly federated kind cannot appear on one screen and
// be missing from another.
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

// Peer-level readings that outrank whatever the last probe concluded. None of
// them is a provider state from the wire; each carries its own remedy because
// the wire's `state` may legitimately be absent (or stale-but-`ready`) while
// one of these holds.
//
// PEER_DISABLED comes first for the same reason the server checks it first:
// `assertFederatedMediaProviderSelection` rejects a submission to a disabled
// peer with MEDIA_PROVIDER_PEER_DISABLED before it looks at anything else, so a
// peer whose connection is switched off must never read as `ready` here no
// matter how healthy its cached snapshot looks.
const PEER_DISABLED = Object.freeze({
  label: 'peer disabled',
  tone: 'warning',
  help: 'This peer connection is switched off. Re-enable it under Instances before routing work to it.',
});
// Not a real provider state — the peer is opted in but no probe has landed yet.
// Kept distinct from `unavailable` so a first-run instance doesn't accuse a
// perfectly healthy peer of having nothing to offer.
const CHECKING = Object.freeze({ label: 'checking', tone: 'muted' });
const OFF = Object.freeze({ label: 'off', tone: 'note' });
const PEER_OFFLINE = Object.freeze({ label: 'peer offline', tone: 'warning' });
// One shared empty array rather than a fresh literal per call: callers memoize
// on `capabilities`, and a new identity every render would defeat that memo for
// exactly the peers that have nothing to recompute.
const NO_CAPABILITIES = Object.freeze([]);
// A peer with no snapshot yet is the common case on a fresh instance, and its
// row re-renders on every 15s poll — no reason to allocate a fresh empty array.
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

// The states that assert currently-available capacity. Only these need a
// verifiable freshness window; `unreachable`, `disabled`, `unsupported`,
// `unauthorized`, `unavailable` and `invalid` legitimately carry none, because
// the probe never got a snapshot to date.
const CAPACITY_CLAIMING_STATES = new Set(['ready', 'busy']);

/**
 * The state a stored status has actually earned, which is not always the one it
 * records.
 *
 * The probe writes `freshUntil` from the provider's own `generatedAt +
 * staleAfterMs`, then the record sits on the peer until the next poll — so a
 * status probed as `ready` keeps saying `ready` long after the server would
 * refuse to submit against it. Re-deriving the verdict at render time closes
 * that gap without a second probe.
 *
 * The checks below the guard mirror, in order, the gates
 * `assertFederatedMediaProviderSelection` applies before it will submit, so
 * neither surface can advertise a peer the server would reject. They all fail
 * CLOSED: an absent or unparseable `freshUntil` makes `Date.parse` return NaN,
 * and reading NaN as "not expired" would advertise a provider with no
 * verifiable window at all — the fail-open version of the very bug this
 * function exists to fix.
 *
 * Only the shape is checked here, not the full wire schema: the server does the
 * authoritative validation, and duplicating it client-side would be a second
 * copy to keep in sync. The bar is that a claim of current capacity must have
 * something behind it.
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

// The input-assets overlap fallback mirrors FEDERATED_MEDIA_LEGACY_FEATURE_TELL
// in server/lib/federatedMediaWire.js. A provider on the previous build
// advertises this genuinely per-model fact in the capability block instead of
// at the status root.
// `Object.create(null)` for the same reason the server table uses it: the key
// is a feature name off the wire, and on a normal object `'constructor'` and
// friends resolve to inherited values rather than being absent.
const LEGACY_FEATURE_TELL = Object.freeze(Object.assign(Object.create(null), {
  inputAssets: (capability) => isRecord(capability?.inputAssets),
}));

/**
 * Does the build that sent this status speak `feature`? Client mirror of
 * `federatedMediaSupports` (server/lib/federatedMediaWire.js), and the ONE
 * place the "absent reads as false" reasoning lives on this side (#4826).
 *
 * A provider built before a feature shipped omits it and then rejects the field
 * outright at submission, so a surface that read an absent signal as consent
 * would offer a render the peer answers with a 400. Display only — the route
 * re-checks and the provider re-checks again at admission.
 *
 * A published list WINS over the input-assets legacy tell rather than being
 * OR'd with it: a peer that told us its whole vocabulary and left this feature
 * out has positively denied it, so the legacy tell is consulted only when there
 * is no list to read. Mirrors the server rule exactly.
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

/**
 * The validated status payload behind a peer's last probe, or null.
 *
 * Shape-checked only, like everything else here: the server does the
 * authoritative wire validation, and a second copy client-side would be one
 * more thing to keep in sync.
 */
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
 * The peer's queue block as finished display segments.
 *
 * Returns the rendered phrases rather than the numbers behind them, so every
 * surface shows the same words — a lib that stopped at "3/4 slots" and left
 * each caller to append its own connective would reintroduce, one layer down,
 * exactly the disagreement this module exists to prevent.
 *
 * `concurrency` and `byKind` reached the wire after v1 shipped (#4348): an
 * older provider omits them, so their segments are dropped rather than shown as
 * a zero that would claim an idle lane the peer never reported on.
 *
 * @param {object|null} queue - `snapshot.queue` from a probed peer
 * @returns {string[]} segments to render in order, possibly empty
 */
export function summarizePeerMediaQueue(queue) {
  if (!isRecord(queue)) return NO_QUEUE_SEGMENTS;
  const segments = [];
  // Machine-wide: every local render on that peer competes for these slots,
  // which is why this is the number that predicts a wait.
  if (isCount(queue.totalActive) && isCount(queue.maxQueuedJobs)) {
    segments.push(`${queue.totalActive}/${queue.maxQueuedJobs} shared slots active`);
  }
  if (isCount(queue.concurrency) && queue.concurrency > 0) {
    segments.push(`runs ${queue.concurrency} at a time`);
  }
  // Also machine-wide — this is what breaks the slot count down. The provider
  // reports only the kinds holding a lane, so an idle kind is simply absent.
  const byKind = isRecord(queue.byKind) ? queue.byKind : {};
  for (const { kind, label } of FEDERATED_MEDIA_KINDS) {
    const segment = occupancySegment(label, byKind[kind]);
    if (segment) segments.push(segment);
  }
  // The federated share of the same slots, labelled so it cannot be read as the
  // whole picture: an unlabelled "0 running" beside "audio 1 running" says the
  // peer is both busy and idle.
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
  // An unverifiable status does not get to keep whatever the probe concluded —
  // including the `ready` it concluded at probe time.
  const state = status ? verifiedState(status, now) : null;
  // `state` is the provider's own verdict on its provider surface — it says
  // nothing about whether this peer is switched on or reachable. Composing the
  // two happens once, here, rather than at each caller: a surface that gated a
  // button on the bare `state` would enable it for a disabled or offline peer
  // still holding a fresh snapshot from before it went away.
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
    // A peer-level reading carries its own remedy; otherwise the remedy belongs
    // to the provider state. An offline peer gets none — its own row says so.
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
 * Two independent lists have to agree before a model is offerable, and each one
 * alone is misleading: the LOCAL allowlist (`mediaProvider.<kind>Models`) is
 * what this instance opted into and is exactly what
 * `assertFederatedMediaProviderSelection` checks on submit, while the peer's
 * advertised `capabilities` is the only thing carrying live readiness. Offering
 * the union would list a model the server refuses; offering the allowlist alone
 * would hide why a listed model can't run.
 *
 * Returns the advertised capability objects (not the config rows) so callers get
 * `ready` / `unavailableReason` with each option, and the shared empty array
 * when nothing qualifies — callers memoize on this result, and a fresh `[]` per
 * render would defeat that memo for every peer with nothing to offer.
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
 * **Absent reads as NO**, and two independent things must both hold: the
 * peer's BUILD has to speak conditioning at all (the `inputAssets` feature,
 * asked through `federatedMediaSupports` so the fail-closed reasoning stays in
 * one place), and THIS MODEL has to advertise the role.
 *
 * Mirrors the server's `inputAssetRejection`
 * (`server/services/federatedMedia/inputAssets.js`) — display only; the route
 * re-checks and the provider re-checks again at admission.
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
