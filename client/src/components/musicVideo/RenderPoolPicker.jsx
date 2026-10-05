import { useFederatedMediaTarget } from '../../hooks/useFederatedMediaTarget.js';
import { federatedMediaModelsForPeer, peerMediaProviderSnapshot, summarizePeerMediaQueue } from '../../lib/federatedMediaReadiness.js';

/** Placement narrows existing peer grants; choosing a row never enables sharing. */
export default function RenderPoolPicker({ settings, change, disabled }) {
  const { peers } = useFederatedMediaTarget('video');
  const pool = settings.renderPool || { mode: 'local', peers: [] };
  const save = (patch) => change({ renderPool: { ...pool, ...patch } });
  return (
    <fieldset disabled={disabled} className="w-full space-y-2 rounded border border-port-border p-2 text-sm">
      <legend className="px-1">Generated shot render pool</legend>
      <label htmlFor="mv-render-pool">Run shots on</label>{' '}
      <select id="mv-render-pool" value={pool.mode} onChange={(event) => save({ mode: event.target.value })}
        className="bg-port-bg border border-port-border rounded p-2">
        <option value="local">This Mac</option>
        <option value="peers" disabled={!pool.peers.length}>Selected peers</option>
        <option value="both" disabled={!pool.peers.length}>Both</option>
      </select>
      <p className="text-xs text-port-text-muted">Select peer models below, then enable the pool. Each shot uses the least occupied eligible selected node; retries keep that node. One GPU job per peer. Final composition export stays on this Mac.</p>
      {peers.map((peer) => {
        const selected = pool.peers.find((entry) => entry.peerId === peer.id);
        const models = federatedMediaModelsForPeer(peer, 'video').filter((entry) => entry.engine === 'local');
        const snapshot = peerMediaProviderSnapshot(peer);
        const toggle = (modelId) => save({ peers: [...pool.peers.filter((entry) => entry.peerId !== peer.id),
          ...(modelId ? [{ peerId: peer.id, modelId }] : [])],
        ...(selected && pool.peers.length === 1 && !modelId ? { mode: 'local' } : {}) });
        return <div key={peer.id} className="space-y-1">
          <label htmlFor={`mv-pool-${peer.id}`}>{peer.name || 'Peer'} model</label>{' '}
          <select id={`mv-pool-${peer.id}`} value={selected?.modelId || ''} onChange={(event) => toggle(event.target.value)}
            className="max-w-full bg-port-bg border border-port-border rounded p-2">
            <option value="">Not selected</option>
            {selected && !models.some((model) => model.modelId === selected.modelId)
              && <option value={selected.modelId}>{selected.modelId} · unavailable</option>}
            {models.map((model) => <option key={model.modelId} value={model.modelId}>
              {model.modelName} · {model.hardwareEligible !== true ? 'hardware unverified / ineligible' : !model.ready ? model.unavailableReason : 'hardware eligible'}{model.sourceAudio ? ' · supplied audio' : ''}
            </option>)}
          </select>
          <p className="text-xs text-port-text-muted">{summarizePeerMediaQueue(snapshot?.queue).join(' · ') || 'Capacity unknown'}{snapshot?.queue?.maintenanceHeld ? ' · maintenance held' : ''}. Fresh memory and capacity are checked at submission.</p>
        </div>;
      })}
      {!peers.length && <p className="text-xs text-port-text-muted">No opted-in media peers. Configure sharing and model grants in Instances first.</p>}
      {pool.peers.filter((entry) => !peers.some((peer) => peer.id === entry.peerId)).map((entry) =>
        <button type="button" key={entry.peerId} onClick={() => save({ mode: 'local', peers: pool.peers.filter((candidate) => candidate !== entry) })}>
          Remove unavailable selection ({entry.modelId})
        </button>)}
      {pool.mode !== 'local' && <p className="text-xs text-port-text-muted">Board shots and revisions only. Production runs, lip-sync, LoRA transfer and continuation require This Mac. Both requires an explicit local model.</p>}
    </fieldset>
  );
}
