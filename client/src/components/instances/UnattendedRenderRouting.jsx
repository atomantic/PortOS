import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import toast from '../ui/Toast';
import { getSettings, updateSettings } from '../../services/api';

// Only the visual kinds route. A federated audio submission may carry nothing
// but a canonical prompt rendered from a fixed enum profile (free-form music
// prompts and lyrics can hold PII), and a Creative Director music bed is
// free-form by construction — so audio stays local rather than being silently
// rewritten into a profile the user never picked.
const KINDS = Object.freeze([
  { kind: 'image', label: 'Image', field: 'imageModels' },
  { kind: 'video', label: 'Video', field: 'videoModels' },
]);

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const optionValue = ({ peerId, engine, modelId }) => JSON.stringify([peerId, engine, modelId]);
const modelKey = ({ engine, modelId }) => `${engine}\u0000${modelId}`;

// Mirrors the server's fail-closed `isTailnetPeer` gate (server/lib/tailnetPeer.js).
// A standing route exports every future prompt of its kind unreviewed, so ADR
// 2026-08-20-federated-visual-prompts (rule 5) refuses a non-tailnet peer. The
// server is authoritative; this only keeps the UI from offering a choice it
// would reject on the first job.
const isTailnetPeer = (peer) => {
  const host = typeof peer?.host === 'string' ? peer.host.trim() : '';
  if (host) return /\.ts\.net$/i.test(host);
  const address = (typeof peer?.address === 'string' ? peer.address : '').trim().replace(/^\[|\]$/g, '');
  if (!address) return false;
  if (/\.ts\.net$/i.test(address) || /^fd7a:115c:a1e0:/i.test(address)) return true;
  const v4 = address.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  return !!v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
};

// One option per (peer, allowlisted model) pair that the peer currently
// advertises as a capability. A model the user allowlisted but the peer no
// longer advertises is deliberately absent: routing unattended work at it would
// fail the server's capacity preflight on every single job.
function routeOptions(peers, kind, field) {
  const options = [];
  for (const peer of peers) {
    // Both switches matter. `peer.enabled === false` disables the peer wholesale
    // while leaving its last media capabilities cached on the record — offering
    // it here would save a route whose every job dies on
    // MEDIA_PROVIDER_PEER_DISABLED.
    if (peer?.enabled === false) continue;
    if (peer?.mediaProvider?.enabled !== true) continue;
    // Offering a non-tailnet peer here would save a route the server refuses on
    // every job with MEDIA_ROUTING_PEER_NOT_TAILNET.
    if (!isTailnetPeer(peer)) continue;
    const allowed = new Set((peer.mediaProvider[field] || [])
      .filter((model) => model?.engine && model?.modelId)
      .map(modelKey));
    for (const capability of peer.mediaProviderStatus?.snapshot?.capabilities || []) {
      if (capability?.kind !== kind) continue;
      if (!allowed.has(modelKey(capability))) continue;
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
 * Chooses where UNATTENDED renders (Creative Director, Creative Commission) go.
 *
 * The planner never names a peer — that would be exactly the arbitrary-peer
 * routing the provider contract forbids — so the choice lives in this
 * instance's own settings and the server reads it at enqueue time.
 */
export default function UnattendedRenderRouting({ peers }) {
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
    () => Object.fromEntries(KINDS.map(({ kind, field }) => [kind, routeOptions(peers, kind, field)])),
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
    const merged = await updateSettings(
      { federation: { mediaRouting: nextRouting } },
      { silent: true },
    ).catch(() => null);
    setSaving(false);
    if (!merged) {
      // The select is controlled off `routing`, so a failed save silently snaps
      // it back to the old value. Say why, or it reads as the click not landing.
      toast.error('Failed to save unattended render routing');
      return;
    }
    setRouting(isRecord(merged.federation?.mediaRouting) ? merged.federation.mediaRouting : nextRouting);
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
    return (
      <div className="mb-3 rounded-lg border border-port-border bg-port-bg/40 p-3">
        <p className="text-[11px] text-port-warning">
          Unattended render routing could not load this instance&rsquo;s settings, so it is read-only. Reload to try again.
        </p>
      </div>
    );
  }
  if (routing === null || (!anyOptions && !hasSavedRoute)) return null;

  return (
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
          const selectId = `unattended-routing-${kind}`;
          return (
            <label key={kind} className="block" htmlFor={selectId}>
              <span className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</span>
              <select
                id={selectId}
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
          );
        })}
      </div>
    </div>
  );
}
