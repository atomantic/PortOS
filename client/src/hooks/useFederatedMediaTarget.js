/**
 * "Render here, or on a peer?" — one hook behind every interactive render form
 * that can route a job to a federated media provider (#4348).
 *
 * Three surfaces now ask this question (Music Studio, Image Gen, Video Gen).
 * Each one would otherwise have to fetch the peer list, intersect the local
 * allowlist with the peer's advertised capabilities, and decide for itself what
 * "ready" means — three chances to disagree with the server's own admission
 * check. `resolvePeerMediaReadiness` already collapsed the readiness verdict;
 * this collapses the selection state that feeds it.
 *
 * Deliberately does not poll. A capacity window expires on the clock, not on a
 * state change, so no poll interval makes the button's reading trustworthy at
 * the instant of a click — `verify()` re-derives against the clock at submit
 * time instead, which is the only moment that matters. The server re-probes and
 * fail-closes after that regardless.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getInstances } from '../services/api';
import {
  federatedMediaModelKey,
  federatedMediaModelsForPeer,
  federatedMediaSupports,
  peerMediaProviderConfig,
  peerMediaProviderSnapshot,
  peerModelAcceptsInput,
  resolvePeerMediaReadiness,
  summarizePeerMediaQueue,
} from '../lib/federatedMediaReadiness.js';

// Stable identities so a form that memoizes on these doesn't re-run on every
// render while nothing is selected (the common case).
const NO_PEERS = Object.freeze([]);
const NO_SEGMENTS = Object.freeze([]);

const QUEUE_CLOSED = 'The peer’s shared media queue is not accepting new work right now.';

/**
 * Why this target cannot take the job, or `null` when it can.
 *
 * Mirrors the order `assertFederatedMediaProviderSelection` rejects in, so a
 * form never advertises a target the server is about to refuse. Every branch
 * returns the remedy rather than a bare "not ready".
 *
 * Takes `now` so the submit-time check and the rendered caption run the same
 * gates: the only difference between them is which clock reading they use.
 */
function blockingReason({ peer, models, model, kind, now }) {
  if (!peer) return null;
  const readiness = resolvePeerMediaReadiness(peer, { now });
  if (!readiness.usable) {
    return readiness.help || 'The selected peer is no longer reporting available capacity.';
  }
  if (models.length === 0) {
    // Two different failures, two different remedies: nothing allowlisted here
    // is a local config gap, while an allowlist the peer answers none of means
    // the model was removed or renamed on its side.
    return (peerMediaProviderConfig(peer).models[kind]?.length ?? 0) === 0
      ? `This peer has no allowlisted ${kind} model. Add one on its card under Instances.`
      : `The peer is not advertising any allowlisted ${kind} model right now.`;
  }
  if (readiness.queue?.accepting !== true) return QUEUE_CLOSED;
  if (model?.ready !== true) {
    return model?.unavailableReason || `The selected ${kind} model is not ready on that peer.`;
  }
  return null;
}

/**
 * @param {'audio'|'image'|'video'} kind
 * @returns {{
 *   peers: object[], peer: object|null, peerId: string, setPeerId: (id: string) => void,
 *   models: object[], model: object|null, modelKey: string, setModelKey: (key: string) => void,
 *   isRemote: boolean, readiness: object|null, queueSegments: string[],
 *   supports: (feature: string) => boolean, acceptsInput: (role: string) => boolean,
 *   canSubmit: boolean, blockedReason: string|null,
 *   submissionFields: object|null, verify: () => {ok: boolean, message?: string},
 * }}
 */
export function useFederatedMediaTarget(kind) {
  const [allPeers, setAllPeers] = useState(NO_PEERS);
  const [peerId, setPeerId] = useState('');
  const [modelKey, setModelKey] = useState('');

  // Only the opted-in peers are stored, and only when there is at least one:
  // on an install with no media provider (the common case) the mount fetch then
  // produces NO state update at all, so adding this hook to a form costs it no
  // extra commit. Filtering here rather than in a `useMemo` below is what makes
  // that possible — the raw list is never state, so its identity cannot churn.
  useEffect(() => {
    getInstances({ silent: true })
      .then((data) => {
        if (!Array.isArray(data?.peers)) return;
        const providers = data.peers.filter((candidate) => candidate?.mediaProvider?.enabled === true);
        setAllPeers((current) => (providers.length === 0 && current.length === 0 ? current : providers));
      })
      .catch(() => {});
  }, []);

  // Opting a peer in is a local config fact that survives a failed probe, which
  // is why the stored list is filtered on that alone (above). A peer whose
  // capacity has gone stale stays listed — carrying its own suffix — rather
  // than vanishing from the dropdown with no explanation of where it went.
  const peers = allPeers;
  const peer = useMemo(() => peers.find((candidate) => candidate.id === peerId) || null, [peers, peerId]);
  const models = useMemo(() => federatedMediaModelsForPeer(peer, kind), [peer, kind]);
  // Fall back to the first option for the same reason a native <select> does:
  // that is what the closed dropdown is displaying while `modelKey` is empty or
  // still points at the previous peer's list.
  const model = models.find((entry) => federatedMediaModelKey(entry) === modelKey) || models[0] || null;

  useEffect(() => {
    const next = models[0];
    setModelKey(next ? federatedMediaModelKey(next) : '');
  }, [peer?.id, models]);

  const readiness = useMemo(() => (peer ? resolvePeerMediaReadiness(peer) : null), [peer]);
  // The peer's own status payload, exposed so a form can ask what the peer's
  // BUILD speaks rather than re-deriving it from a per-capability field (#4826).
  // Not memoized: the helper returns the stored reference (or null) rather than
  // building anything, so its identity already tracks `peer`.
  const snapshot = peerMediaProviderSnapshot(peer);
  // Bound to the selected model so callers ask one question instead of two: the
  // root feature list, with the overlap fallback against a peer still on the
  // previous build. Fails closed on an absent status, like every gate here.
  const supports = useCallback(
    (feature) => federatedMediaSupports(snapshot, feature, model),
    [snapshot, model],
  );
  // Bound for the same reason: `peerModelAcceptsInput`'s status argument is
  // optional and omitting it falls silently back to the pre-#4826 reading, so a
  // page that forgot to thread the snapshot would fail OPEN with nothing to
  // catch it. Nothing outside this hook needs to hold the snapshot at all.
  const acceptsInput = useCallback(
    (role) => peerModelAcceptsInput(model, role, snapshot),
    [snapshot, model],
  );
  const queueSegments = useMemo(
    () => (readiness ? summarizePeerMediaQueue(readiness.queue) : NO_SEGMENTS),
    [readiness],
  );
  const blockedReason = useMemo(
    () => blockingReason({ peer, models, model, kind, now: Date.now() }),
    [peer, models, model, kind],
  );

  // The three fields the generate routes read. Built here so a page cannot ship
  // a peer id without the engine that pairs with it — the provider allowlist is
  // keyed on the (engine, modelId) pair, not on the model id alone.
  const submissionFields = useMemo(() => (peer && model ? {
    mediaProviderPeerId: peer.id,
    mediaProviderEngine: model.engine,
    modelId: model.modelId,
  } : null), [peer, model]);

  const verify = useCallback(() => {
    const reason = blockingReason({ peer, models, model, kind, now: Date.now() });
    return reason ? { ok: false, message: reason } : { ok: true };
  }, [peer, models, model, kind]);

  return {
    peers,
    peer,
    peerId,
    setPeerId,
    models,
    model,
    modelKey,
    setModelKey,
    isRemote: Boolean(peer),
    readiness,
    queueSegments,
    supports,
    acceptsInput,
    canSubmit: Boolean(peer) && blockedReason === null,
    blockedReason,
    submissionFields,
    verify,
  };
}
