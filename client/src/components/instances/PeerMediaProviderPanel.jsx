import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Film, Gauge, Image, Music2 } from 'lucide-react';
import { probePeer, updatePeer } from '../../services/api';
import Pill from '../ui/Pill';

// Wire v1 shipped audio-only, then grew image and video (#4348). The panel is
// driven off this table rather than one hardcoded lane so a peer that shares a
// GPU for renders is configurable at all — before this, image/video models were
// accepted by the server but had no surface to allowlist them from, which left
// federated renders unreachable from the UI.
const KINDS = Object.freeze([
  { kind: 'audio', label: 'audio', field: 'audioModels', Icon: Music2 },
  { kind: 'image', label: 'image', field: 'imageModels', Icon: Image },
  { kind: 'video', label: 'video', field: 'videoModels', Icon: Film },
]);

const STATE_META = {
  ready: { label: 'ready', tone: 'success' },
  busy: { label: 'busy', tone: 'warning' },
  stale: { label: 'stale', tone: 'warning' },
  unauthorized: { label: 'auth required', tone: 'warning' },
  unsupported: { label: 'older peer', tone: 'note' },
  disabled: { label: 'provider off', tone: 'note' },
  unavailable: { label: 'unavailable', tone: 'warning' },
  unreachable: { label: 'unreachable', tone: 'warning' },
  invalid: { label: 'invalid status', tone: 'warning' },
};

const STATE_HELP = {
  busy: 'The peer is reachable, but its shared media lane is currently at capacity.',
  stale: 'The last capacity snapshot expired. New remote work is blocked until a fresh probe succeeds.',
  unauthorized: 'Store this peer’s instance-password credential above and make sure this instance is registered there.',
  unsupported: 'This peer does not expose the federated-media wire-v1 status endpoint yet.',
  disabled: 'Enable federated media sharing on the peer under Settings → Sharing.',
  unavailable: 'The peer has no currently ready allowlisted media runtime/model.',
  unreachable: 'The media status request failed. New remote work remains blocked.',
  invalid: 'The peer returned a response that did not match the versioned media-provider contract.',
};

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
// NUL separator, matching the server's own model key: a printable separator
// would let an engine name containing it collide with a different pair.
const keyOf = ({ engine, modelId }) => `${engine}\u0000${modelId}`;
const listOf = (raw, field) => (Array.isArray(raw?.[field]) ? raw[field] : []);

function configOf(peer) {
  const raw = isRecord(peer?.mediaProvider) ? peer.mediaProvider : {};
  const models = {};
  for (const { kind, field } of KINDS) models[kind] = listOf(raw, field);
  return { raw, enabled: raw.enabled === true, models };
}

// A peer only advertises the kinds this instance asked for, and it only asks
// for kinds that already have an allowlisted model — so an already-selected
// model the peer has stopped advertising still has to appear, or the user could
// never uncheck it. Those rows render as `not-advertised`.
function modelRows(selected, status, kind) {
  const rows = new Map();
  for (const capability of status?.snapshot?.capabilities || []) {
    if (capability?.kind !== kind || !capability.engine || !capability.modelId) continue;
    rows.set(keyOf(capability), capability);
  }
  for (const model of selected) {
    if (!model?.engine || !model.modelId) continue;
    const key = keyOf(model);
    if (rows.has(key)) continue;
    rows.set(key, {
      kind,
      engine: model.engine,
      engineName: model.engine,
      modelId: model.modelId,
      modelName: model.modelId,
      ready: false,
      unavailableReason: 'not-advertised',
    });
  }
  return [...rows.values()];
}

export default function PeerMediaProviderPanel({ peer, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const config = configOf(peer);
  const status = peer.mediaProviderStatus || null;
  const rowsByKind = useMemo(
    () => Object.fromEntries(KINDS.map(({ kind }) => [kind, modelRows(config.models[kind], status, kind)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.raw, status],
  );
  const stateMeta = !config.enabled
    ? { label: 'off', tone: 'note' }
    : peer.status !== 'online'
      ? { label: 'peer offline', tone: 'warning' }
      : STATE_META[status?.state] || { label: 'checking', tone: 'muted' };
  const queue = status?.snapshot?.queue;

  // Carry every kind's list forward on each write. The server merges the
  // mediaProvider object, but a patch that omitted a list this panel never
  // rendered would only read as "unchanged" by luck — send the full shape.
  const saveConfig = async (patch, { probe = false } = {}) => {
    setSaving(true);
    const next = {
      ...config.raw,
      enabled: config.enabled,
      ...Object.fromEntries(KINDS.map(({ kind, field }) => [field, config.models[kind]])),
      ...patch,
    };
    const updated = await updatePeer(peer.id, { mediaProvider: next }).catch(() => null);
    if (updated && probe) await probePeer(peer.id).catch(() => null);
    if (updated) onRefresh();
    setSaving(false);
  };

  const toggleEnabled = () => saveConfig({ enabled: !config.enabled }, { probe: !config.enabled });

  const toggleModel = (kind, field, model) => {
    const key = keyOf(model);
    const current = config.models[kind];
    const next = current.some((candidate) => keyOf(candidate) === key)
      ? current.filter((candidate) => keyOf(candidate) !== key)
      : [...current, { engine: model.engine, modelId: model.modelId }];
    return saveConfig({ [field]: next });
  };

  const safePeerId = String(peer.id || 'peer').replace(/[^A-Za-z0-9_-]/g, '-');
  const enabledId = `${safePeerId}-remote-media-enabled`;

  return (
    <div className="mt-2 pt-2 border-t border-port-border/50">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1.5 w-full text-left group"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
        <Gauge size={12} className={config.enabled ? 'text-port-accent' : 'text-gray-500'} />
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium group-hover:text-gray-400 transition-colors">
          Remote media provider
        </span>
        <Pill tone={stateMeta.tone} size="xs" bordered={false} className="ml-auto">
          {stateMeta.label}
        </Pill>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="flex items-start gap-2 rounded border border-port-border px-2 py-2">
            <input
              id={enabledId}
              type="checkbox"
              checked={config.enabled}
              disabled={saving || peer.enabled === false}
              onChange={toggleEnabled}
              className="mt-0.5 accent-port-accent"
            />
            <label htmlFor={enabledId} className="flex-1 text-gray-300 cursor-pointer">
              Use this peer for remote media
              <span className="block text-[10px] text-gray-600 mt-0.5">
                Opt-in only. The server also requires an allowlisted model and fresh available capacity before routing.
              </span>
            </label>
          </div>

          {config.enabled && (
            <>
              {queue && (
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <Gauge size={11} />
                  <span>
                    {queue.running} running · {queue.queued} queued · {queue.totalActive}/{queue.maxQueuedJobs} shared slots active
                  </span>
                </div>
              )}

              {status?.state && status.state !== 'ready' && STATE_HELP[status.state] && (
                <p className="text-[10px] text-port-warning leading-snug">{STATE_HELP[status.state]}</p>
              )}

              {KINDS.map(({ kind, label, field, Icon }) => {
                const rows = rowsByKind[kind];
                const selectedKeys = new Set(config.models[kind]
                  .filter((model) => model?.engine && model.modelId)
                  .map(keyOf));
                return (
                  <div key={kind} className="space-y-1">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Allowed {label} models</div>
                    {rows.length === 0 ? (
                      <p className="text-[10px] text-gray-600">
                        No {label} capabilities discovered yet. Verify peer authentication and probe again.
                      </p>
                    ) : rows.map((model, index) => {
                      const key = keyOf(model);
                      const selected = selectedKeys.has(key);
                      const inputId = `${safePeerId}-remote-media-${kind}-model-${index}`;
                      return (
                        <label
                          key={key}
                          htmlFor={inputId}
                          className="flex items-start gap-2 rounded border border-port-border/70 px-2 py-1.5 cursor-pointer"
                        >
                          <input
                            id={inputId}
                            type="checkbox"
                            checked={selected}
                            disabled={saving}
                            onChange={() => toggleModel(kind, field, model)}
                            className="sr-only"
                            aria-label={`Allow ${label} model ${model.modelName}`}
                          />
                          <span className={`w-3 h-3 mt-0.5 rounded-sm border flex items-center justify-center shrink-0 ${
                            selected ? 'bg-port-accent border-port-accent' : 'border-gray-600'
                          }`}>
                            {selected && <Check size={8} className="text-white" />}
                          </span>
                          <Icon size={12} className={model.ready ? 'text-port-success mt-0.5' : 'text-gray-500 mt-0.5'} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-gray-300 truncate">{model.modelName}</span>
                            <span className="block text-[10px] text-gray-600 truncate">
                              {model.engineName} · {model.ready ? 'ready' : model.unavailableReason || 'unavailable'}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
