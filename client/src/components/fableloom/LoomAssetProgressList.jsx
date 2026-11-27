

export function LoomAssetProgressList({ assetScope, scopedAssets, onSelectNode }) {
  return (
    <>
      {scopedAssets.length > 0 && (
        <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
          <div className="text-[10px] uppercase font-semibold text-port-text-muted">
            {assetScope === 'images' ? 'Storyboard image execution order' : 'Asset execution order'}
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1">
            {scopedAssets.map((asset) => (
              <div key={asset.id} className="flex items-center gap-2 text-[11px] py-1 border-b border-port-border/50 last:border-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${asset.status === 'blocked' ? 'bg-port-error' : asset.status === 'already_rendered' || asset.status === 'skipped' ? 'bg-port-success' : 'bg-port-accent'}`} />
                <button
                  type="button"
                  onClick={() => onSelectNode && onSelectNode(asset.nodeId)}
                  className="truncate text-left text-port-text hover:text-port-accent"
                  title={`Open scene ${asset.nodeId}`}
                >
                  {asset.nodeTitle || asset.nodeId}
                </button>
                <span className="text-port-text-muted shrink-0">{asset.type.replaceAll('_', ' ')}</span>
                <span className="text-port-text-muted ml-auto shrink-0">stage {asset.stageIndex + 1}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function LoomAssetProvenanceList({ activeBatchRun }) {
  return (
    <>
      {activeBatchRun?.assets?.length > 0 && (
        <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
          <div className="text-[10px] uppercase font-semibold text-port-text-muted">Recorded asset provenance</div>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {activeBatchRun.assets.map((asset) => {
              const manifest = asset.visualConditioning;
              const capability = manifest?.capability || {};
              const render = manifest?.render || {};
              const params = render.parameters || asset.effectiveParameters || {};
              return (
                <details key={asset.id} className="rounded border border-port-border/70 px-2 py-1 text-[11px]">
                  <summary className="cursor-pointer flex items-center gap-2">
                    <span className="font-medium text-port-text truncate">{asset.nodeTitle || asset.nodeId}</span>
                    <span className="text-port-text-muted">{asset.type.replaceAll('_', ' ')}</span>
                    <span className="ml-auto capitalize text-port-text-muted">{asset.status}</span>
                  </summary>
                  {manifest ? (
                    <div className="pt-1.5 pl-1 space-y-0.5 text-port-text-muted">
                      <div>Provider: {render.provider || capability.backend || 'unknown'} · Model: {render.modelId || capability.modelId || 'unknown'}{render.modelRevision || capability.modelRevision ? ` · revision ${render.modelRevision || capability.modelRevision}` : ''}</div>
                      <div>Canon refs: {manifest.assets?.length || 0} · adapters: {manifest.adapters?.length || 0} · temporal source: {manifest.temporalSourceNodeId || 'none'}</div>
                      <div>Omitted: {manifest.omitted?.length || 0} · warnings: {manifest.warnings?.length || 0}</div>
                      {Object.keys(params).length > 0 && <div>Effective parameters: {Object.entries(params).map(([key, value]) => `${key}=${String(value)}`).join(', ')}</div>}
                    </div>
                  ) : (
                    <div className="pt-1.5 pl-1 text-port-text-muted">No visual conditioning manifest was produced for this asset.</div>
                  )}
                </details>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
