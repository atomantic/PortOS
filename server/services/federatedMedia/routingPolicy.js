/**
 * What a standing unattended render route IS, and whether one may be SAVED.
 *
 * `defaultRouting.js` owns the other half — resolving a saved route at enqueue
 * time, where it re-runs the full capacity preflight and fails closed. This
 * module owns the route's shape and the durable configuration policy, so the
 * settings route can refuse a bad route where the user is standing rather than
 * only where the job is.
 *
 * The distinction matters because the two failures look nothing alike. A route
 * naming a peer that is unknown, switched off, not enabled as a media provider,
 * not allowlisted for that exact model, or reachable outside the tailnet cannot
 * EVER run — it is not a transient capacity problem, it is a configuration that
 * has no working state. Saved unchecked, it persisted silently and then failed
 * every future Creative Director / Creative Commission render, one job at a
 * time, with nobody watching, because unattended work has no human at the
 * moment of failure. That is the "fail closed, never fail quiet" rule of #4679
 * applied one step earlier: refuse it at the save, where there IS a human.
 *
 * Only DURABLE configuration is checked here — never live capacity. A provider
 * peer is routinely asleep, busy, or mid-probe when its route is configured, so
 * gating the save on a fresh snapshot would make the feature unusable at
 * exactly the moment a user sits down to set it up. Freshness, queue admission,
 * and per-model readiness stay on the enqueue path, which re-checks all of them
 * (`assertFederatedMediaProviderSelection`) and re-checks the tailnet gate again
 * per request, since a peer's host can be edited after the route is saved.
 *
 * Clearing a route is ALWAYS allowed. A route saved before its peer changed
 * must stay removable, or a bad configuration becomes permanent.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { isPlainObject as isRecord } from '../../lib/objects.js';
import { isTailnetPeer } from '../../lib/tailnetPeer.js';

// Only the visual kinds route. A federated audio submission may carry nothing
// but a canonical prompt rendered from a fixed enum profile (free-form music
// prompts and lyrics can hold PII), and a Creative Director music bed is
// free-form by construction — so audio stays local rather than being silently
// rewritten into a profile the user never picked. See the module docblock in
// defaultRouting.js.
export const ROUTABLE_MEDIA_KINDS = Object.freeze(['image', 'video']);

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Normalize one route entry, or `null` when it is not a usable route.
 *
 * A half-written route is not a route. Requiring all three fields up front is
 * what keeps a partially-saved settings blob from resolving to "peer X,
 * whatever model" — the allowlist check downstream is keyed on the exact pair.
 */
export function sanitizeRoute(raw) {
  if (!isRecord(raw)) return null;
  const peerId = trimmed(raw.peerId);
  const engine = trimmed(raw.engine);
  const modelId = trimmed(raw.modelId);
  if (!peerId || !engine || !modelId) return null;
  return { peerId, engine, modelId };
}

/**
 * Project `settings.federation.mediaRouting` down to the routes this build
 * understands. Unknown kinds are dropped rather than carried: a route is only
 * ever consumed by a matching enqueue path, so a kind this version cannot
 * execute must read as "no route" and stay local.
 *
 * @param {object} settings - Full settings record.
 * @returns {{image: object|null, video: object|null}}
 */
export function normalizeMediaRoutingConfig(settings) {
  const raw = settings?.federation?.mediaRouting;
  const config = {};
  for (const kind of ROUTABLE_MEDIA_KINDS) {
    config[kind] = isRecord(raw) ? sanitizeRoute(raw[kind]) : null;
  }
  return config;
}

const reject = (message, code, status) => {
  throw new ServerError(message, { status, code });
};

/**
 * Refuse a `federation.mediaRouting` patch that names a route no enqueue could
 * ever honour.
 *
 * The rejection order mirrors `assertFederatedMediaProviderSelection` so the
 * user sees the same reason at save time that the enqueue would have given
 * them later, rather than two different vocabularies for one misconfiguration.
 *
 * @param {any} routing - The incoming `federation.mediaRouting` value.
 * @returns {Promise<void>} Resolves when every named route is savable.
 */
export async function assertMediaRoutingConfig(routing) {
  if (routing === null || routing === undefined) return;
  if (!isRecord(routing)) {
    reject('Unattended render routing must be an object', 'MEDIA_ROUTING_INVALID', 400);
  }
  // A kind sent as `null` is the user clearing that route, and a kind this
  // build cannot execute is not ours to police — neither reaches a peer, so
  // neither is checked. Only a route actually being SET is.
  const requested = ROUTABLE_MEDIA_KINDS
    .map((kind) => [kind, routing[kind]])
    .filter(([, raw]) => raw !== null && raw !== undefined);
  if (requested.length === 0) return;

  // Imported lazily for the same reason prepareRemoteMediaJob does it: a static
  // edge from the settings route to the peer registry would drag the registry
  // (and its socket-relay / sharing dependencies) into every settings-route
  // suite's module graph. Nothing here loads until a route is actually saved.
  const [{ getPeers }, { modelKey, normalizePeerMediaProviderConfig }] = await Promise.all([
    import('../instances.js'),
    import('../federatedMediaConsumer.js'),
  ]);
  const peers = await getPeers();

  for (const [kind, raw] of requested) {
    const route = sanitizeRoute(raw);
    if (!route) {
      reject(
        `The ${kind} route needs a peer, an engine, and a model`,
        'MEDIA_ROUTING_INVALID',
        400,
      );
    }
    const peer = peers.find((candidate) => candidate.id === route.peerId);
    if (!peer) {
      reject(
        `The peer named by the ${kind} route is not registered on this instance`,
        'MEDIA_PROVIDER_PEER_NOT_FOUND',
        404,
      );
    }
    const name = peer.name || peer.id;
    if (peer.enabled === false) {
      reject(`"${name}" is switched off, so it cannot take unattended ${kind} renders`, 'MEDIA_PROVIDER_PEER_DISABLED', 409);
    }
    const config = normalizePeerMediaProviderConfig(peer);
    if (!config.enabled) {
      reject(`"${name}" is not enabled as a media provider`, 'MEDIA_PROVIDER_NOT_CONFIGURED', 409);
    }
    const allowlist = config[`${kind}Models`] || [];
    if (!allowlist.some((model) => modelKey(model) === modelKey(route))) {
      reject(
        `"${route.modelId}" is not allowlisted for ${kind} on "${name}". Add it on that peer's card under Instances.`,
        'MEDIA_PROVIDER_MODEL_NOT_ALLOWED',
        403,
      );
    }
    // ADR docs/decisions/2026-08-20-federated-visual-prompts.md, rule 5. The
    // enqueue path checks this too and stays authoritative — a host edited from
    // a .ts.net name to a LAN address after the save must not carry a queued
    // job — but a route that can never satisfy it should not be storable in the
    // first place.
    if (!isTailnetPeer(peer)) {
      reject(
        `Unattended ${kind} routing requires a Tailscale peer — "${name}" is reachable outside the tailnet, `
        + 'so a standing route would export every future prompt over an unauthenticated hop.',
        'MEDIA_ROUTING_PEER_NOT_TAILNET',
        403,
      );
    }
  }
}
