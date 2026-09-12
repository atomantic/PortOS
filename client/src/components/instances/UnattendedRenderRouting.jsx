import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import toast from '../ui/Toast';
import { getSettings, updateSettings } from '../../services/api';
import {
  federatedMediaModelsForPeer,
  peerMediaProviderConfig,
  resolvePeerMediaReadiness,
  summarizePeerMediaQueue,
} from '../../lib/federatedMediaReadiness.js';
import { isTailnetPeer } from '../../lib/tailnetPeer.js';

// Only the visual kinds route. A federated audio submission may carry nothing
// but a canonical prompt rendered from a fixed enum profile (free-form music
// prompts and lyrics can hold PII), and a Creative Director music bed is
// free-form by construction — so audio stays local rather than being silently
// rewritten into a profile the user never picked.
const KINDS = Object.freeze([
  { kind: 'image', label: 'Image' },
  { kind: 'video', label: 'Video' },
]);

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const optionValue = ({ peerId, engine, modelId }) => JSON.stringify([peerId, engine, modelId]);

const TONE_CLASS = {
  success: 'text-port-success',
  warning: 'text-port-warning',
  note: 'text-gray-400',
  muted: 'text-gray-500',
};

// One option per (peer, allowlisted model) pair that the peer currently
// advertises as a capability. A model the user allowlisted but the peer no
// longer advertises is deliberately absent: routing unattended work at it would
// fail the server's capacity preflight on every single job.
//
// The two hard filters below are DURABLE configuration, which is why they can
// gate the option list: a peer switched off or not enabled as a provider stays
// that way until someone changes it. Live capacity deliberately does NOT gate —
// a provider is routinely asleep when its route is configured, and hiding it
// then would make the card unusable at exactly the moment it is being set up.
// Current state is reported as a caption instead, and the server re-checks
// everything at enqueue.
function routeOptions(peers, kind) {
  const options = [];
  for (const peer of peers) {
    // Both switches matter. `peer.enabled === false` disables the peer wholesale
    // while leaving its last media capabilities cached on the record — offering
    // it here would save a route whose every job dies on
    // MEDIA_PROVIDER_PEER_DISABLED.
    if (peer?.enabled === false) continue;
    if (!peerMediaProviderConfig(peer).enabled) continue;
    // Offering a non-tailnet peer here would save a route the server refuses,
    // now at save time and again on every job, with
    // MEDIA_ROUTING_PEER_NOT_TAILNET.
    if (!isTailnetPeer(peer)) continue;
    for (const capability of federatedMediaModelsForPeer(peer, kind)) {
      options.push({
        peerId: peer.id,
        engine: capability.engine,
        modelId: capability.modelId,
        label: `${peer.name || peer.address || 'Peer'} — ${capability.modelName || capability.modelId}`,
        ready: capability.ready === true,
      });
    }
  }
  return options;
}

/**
 * What the peer behind a saved route is reporting right now.
 *
 * Read through the same `resolvePeerMediaReadiness` the Instances card, System
 * Health, and the interactive pickers use, so this card cannot become a fourth
 * surface with its own opinion — the reason it is advisory here and blocking
 * there is the standing-vs-interactive distinction, not a different verdict.
 */
function routeStatus(peers, route) {
  if (!route) return null;
  const peer = peers.find((candidate) => candidate.id === route.peerId);
  if (!peer) {
    return { tone: 'warning', label: 'peer not registered', help: null, segments: [] };
  }
  const readiness = resolvePeerMediaReadiness(peer);
  return {
    tone: readiness.tone,
    label: readiness.label,
    help: readiness.help,
    segments: summarizePeerMediaQueue(readiness.queue),
  };
}

/**
 * Chooses where UNATTENDED renders (Creative Director, Creative Commission) go.
 *
 * The planner never names a peer — that would be exactly the arbitrary-peer
 * routing the provider contract forbids — so the choice lives in this
 * instance's own settings and the server reads it at enqueue time.
 */
export default function UnattendedRenderRouting({ peers, renderPanel = (panel) => panel }) {
  // `null` = not loaded yet, and NOT the same as `{}` (loaded, nothing routed).
  // Conflating them is what would let a failed settings read save a routing map
  // rebuilt from an empty object, clearing a route this page never saw.
  // `loadFailed` keeps the card visible but read-only so the failure is legible
  // instead of silently destructive.
  const [routing, setRouting] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings({ silent: true })
      .then((settings) => {
        const slice = isRecord(settings?.federation) ? settings.federation : {};
        setRouting(isRecord(slice.mediaRouting) ? slice.mediaRouting : {});
      })
      .catch(() => setLoadFailed(true));
  }, []);

  const optionsByKind = useMemo(
    () => Object.fromEntries(KINDS.map(({ kind }) => [kind, routeOptions(peers, kind)])),
    [peers],
  );

  const save = async (kind, route) => {
    // Belt and braces with the `disabled` below: without a loaded routing map
    // there is nothing to merge this kind onto.
    if (!isRecord(routing)) return;
    setSaving(true);
    // The server merges the `federation` slice per sub-key (#4703), so this
    // patch carries `mediaRouting` alone and can no longer revert the Sharing
    // tab's `mediaProvider` / `strictPullAuthorization`.
    //
    // The re-read is still worth its round trip: it merges this kind onto the
    // freshest routing map rather than the one captured at mount, and it turns
    // "settings are unreachable" into a stated error instead of a select that
    // silently snaps back. A FAILED read (`null`) aborts. A SUCCESSFUL response
    // with no `federation` key is a fresh install that has simply never opted
    // into anything — the correct base is `{}`, and treating it as unreadable
    // would make the very first route unsavable on every install.
    const fresh = await getSettings({ silent: true }).catch(() => null);
    if (fresh === null) {
      setSaving(false);
      toast.error('Could not read current settings — routing not saved');
      return;
    }
    const base = isRecord(fresh.federation) ? fresh.federation : {};
    const baseRouting = isRecord(base.mediaRouting) ? base.mediaRouting : routing;
    const nextRouting = { ...baseRouting, [kind]: route };
    const outcome = await updateSettings(
      { federation: { mediaRouting: nextRouting } },
      { silent: true },
    ).then((merged) => ({ merged }), (error) => ({ error }));
    setSaving(false);
    if (outcome.error) {
      // The select is controlled off `routing`, so a failed save silently snaps
      // it back to the old value. Say why, or it reads as the click not landing
      // — and the server's own reason is the useful half now that it refuses a
      // route that could never run (unknown/disabled/un-allowlisted/non-tailnet
      // peer) instead of storing it to fail on every future render.
      toast.error(outcome.error.message || 'Failed to save unattended render routing');
      return;
    }
    const { merged } = outcome;
    setRouting(isRecord(merged?.federation?.mediaRouting) ? merged.federation.mediaRouting : nextRouting);
  };

  const savedRoute = (kind) => (isRecord(routing?.[kind]) ? routing[kind] : null);
  // A persisted route must stay editable even when nothing is advertised for it
  // any more — otherwise the card hides, the route keeps failing every enqueue,
  // and there is no way left to clear it.
  const hasSavedRoute = KINDS.some(({ kind }) => savedRoute(kind));
  const anyOptions = KINDS.some(({ kind }) => optionsByKind[kind].length > 0);
  // Shown regardless of whether any peer currently advertises a model: a failed
  // settings read is not the same as "nothing is configured", and hiding it
  // would leave a persisted route silently failing every enqueue with no
  // on-screen explanation and no way to clear it.
  if (loadFailed) {
    return renderPanel(
      <div className="mb-3 rounded-lg border border-port-border bg-port-bg/40 p-3">
        <p className="text-[11px] text-port-warning">
          Unattended render routing could not load this instance&rsquo;s settings, so it is read-only. Reload to try again.
        </p>
      </div>,
      true,
    );
  }
  if (routing === null || (!anyOptions && !hasSavedRoute)) return renderPanel(null, false);

  const needsAttention = KINDS.some(({ kind }) => {
    const current = savedRoute(kind);
    if (!current) return false;
    const option = optionsByKind[kind].find((candidate) => optionValue(candidate) === optionValue(current));
    return !option || !option.ready || routeStatus(peers, current)?.tone !== 'success';
  });

  return renderPanel(
    <div className="mb-3 rounded-lg border border-port-border bg-port-bg/40 p-3">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={14} className="text-port-accent" />
        <h3 className="text-xs font-medium text-gray-300 uppercase tracking-wider">Unattended render routing</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-2">
        Where Creative Director and Creative Commission send their renders. Agents never choose a peer;
        this instance does. A routed kind fails with the peer&rsquo;s reason rather than quietly rendering
        locally, so unavailable capacity is visible instead of silent. Only Tailscale peers can be
        chosen &mdash; a standing route exports every future prompt of its kind without review.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {KINDS.map(({ kind, label }) => {
          const options = optionsByKind[kind];
          const current = savedRoute(kind);
          const status = routeStatus(peers, current);
          const selectId = `unattended-routing-${kind}`;
          const statusId = `${selectId}-status`;
          return (
            <div key={kind}>
              <label className="block" htmlFor={selectId}>
                <span className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</span>
                <select
                  id={selectId}
                  // The caption below reports the routed peer's live state; tie
                  // it to the control so it is announced with it rather than
                  // read as unrelated text after it.
                  aria-describedby={status ? statusId : undefined}
                  value={current ? optionValue(current) : ''}
                  // Enabled whenever there is something to choose OR something to
                  // clear; only a kind with neither is inert.
                  disabled={saving || (options.length === 0 && !current)}
                  onChange={(event) => save(kind, event.target.value
                    ? (([peerId, engine, modelId]) => ({ peerId, engine, modelId }))(JSON.parse(event.target.value))
                    : null)}
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                >
                  <option value="">This instance</option>
                  {options.map((option) => (
                    <option key={optionValue(option)} value={optionValue(option)}>
                      {option.label}{option.ready ? '' : ' (not ready)'}
                    </option>
                  ))}
                  {/* A route saved against a model no longer advertised must stay
                      selectable, or the control would silently show "This
                      instance" while the server still routes every job. */}
                  {current && !options.some((option) => optionValue(option) === optionValue(current)) && (
                    <option value={optionValue(current)}>{current.modelId} (unavailable)</option>
                  )}
                </select>
              </label>
              {/* Capacity messaging for a routed kind. Advisory, not a gate:
                  what it answers is "will the next unattended render actually
                  run, or queue behind something?" — which the select alone
                  cannot say, and which nobody is watching for at enqueue time. */}
              {status && (
                <p id={statusId} className={`mt-1 text-[10px] ${TONE_CLASS[status.tone] || TONE_CLASS.muted}`}>
                  {status.label}
                  {status.segments.length > 0 && ` · ${status.segments.join(' · ')}`}
                  {status.help && <span className="block text-gray-500">{status.help}</span>}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>,
    needsAttention,
  );
}
