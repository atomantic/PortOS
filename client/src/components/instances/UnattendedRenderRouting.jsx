import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
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

// One option per (peer, allowlisted model) pair that the peer currently
// advertises as a capability. A model the user allowlisted but the peer no
// longer advertises is deliberately absent: routing unattended work at it would
// fail the server's capacity preflight on every single job.
function routeOptions(peers, kind, field) {
  const options = [];
  for (const peer of peers) {
    if (peer?.mediaProvider?.enabled !== true) continue;
    const allowed = new Set((peer.mediaProvider[field] || [])
      .filter((model) => model?.engine && model?.modelId)
      .map((model) => `${model.engine}\u0000${model.modelId}`));
    for (const capability of peer.mediaProviderStatus?.snapshot?.capabilities || []) {
      if (capability?.kind !== kind) continue;
      if (!allowed.has(`${capability.engine}\u0000${capability.modelId}`)) continue;
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
  const [routing, setRouting] = useState(null);
  const [federation, setFederation] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings({ silent: true })
      .then((settings) => {
        const slice = isRecord(settings?.federation) ? settings.federation : {};
        setFederation(slice);
        setRouting(isRecord(slice.mediaRouting) ? slice.mediaRouting : {});
      })
      .catch(() => setRouting({}));
  }, []);

  const optionsByKind = useMemo(
    () => Object.fromEntries(KINDS.map(({ kind, field }) => [kind, routeOptions(peers, kind, field)])),
    [peers],
  );

  const save = async (kind, route) => {
    setSaving(true);
    const nextRouting = { ...routing, [kind]: route };
    // The settings PATCH shallow-merges TOP-LEVEL keys, so `federation` is
    // replaced wholesale — carry the rest of the slice forward or a save here
    // would drop the provider config the Sharing tab owns.
    const merged = await updateSettings(
      { federation: { ...federation, mediaRouting: nextRouting } },
      { silent: true },
    ).catch(() => null);
    if (merged) {
      setRouting(nextRouting);
      setFederation(isRecord(merged.federation) ? merged.federation : { ...federation, mediaRouting: nextRouting });
    }
    setSaving(false);
  };

  // Nothing is routable until at least one peer advertises an allowlisted
  // visual model, and an empty control would read as a broken feature.
  const anyOptions = KINDS.some(({ kind }) => optionsByKind[kind].length > 0);
  if (routing === null || !anyOptions) return null;

  return (
    <div className="mb-3 rounded-lg border border-port-border bg-port-bg/40 p-3">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={14} className="text-port-accent" />
        <h3 className="text-xs font-medium text-gray-300 uppercase tracking-wider">Unattended render routing</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-2">
        Where Creative Director and Creative Commission send their renders. Agents never choose a peer;
        this instance does. A routed kind fails with the peer&rsquo;s reason rather than quietly rendering
        locally, so unavailable capacity is visible instead of silent.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {KINDS.map(({ kind, label }) => {
          const options = optionsByKind[kind];
          const current = isRecord(routing[kind]) ? routing[kind] : null;
          const selectId = `unattended-routing-${kind}`;
          return (
            <label key={kind} className="block" htmlFor={selectId}>
              <span className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</span>
              <select
                id={selectId}
                value={current ? optionValue(current) : ''}
                disabled={saving || options.length === 0}
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
