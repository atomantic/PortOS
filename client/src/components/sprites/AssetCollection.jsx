/**
 * Character asset collection (#2931, phase 3 of the #2930 UX overhaul).
 *
 * Replaces the flat "group by first path segment" dump with a role-grouped
 * collection carrying a lifecycle status badge per asset, and puts the two
 * actions you actually want on the cards that can use them:
 *
 *   - **Regenerate** — re-fires the workflow action that produced this asset
 *     (walk generate for a strip/frame/animation, reference generate for an
 *     anchor), gated on the same in-flight state the workflow itself uses.
 *   - **Edit in Loop Trimmer** — opens the trimmer for the owning run.
 *
 * `ReferenceWorkflow` / `WalkWorkflow` / `PublishWorkflow` stay the
 * authoritative surfaces: this view links INTO them (the trim request is
 * routed back up to WalkWorkflow's panel) rather than duplicating their state.
 */

import { useMemo, useState } from 'react';
import { FolderOpen, RefreshCw, Scissors, Sparkles, Film } from 'lucide-react';
import AssetInspector from './AssetInspector.jsx';
import SpritePreview from './SpritePreview.jsx';
import { hasSpritePreview } from './spriteAssets.js';
import { groupSpriteAssetsByRole } from '../../lib/spriteFacets.js';
import { formatBytes } from '../../utils/formatters.js';

// Status → badge tone. Kept here rather than in the pure facet module so the
// classifier stays free of presentation concerns.
const STATUS_TONE = {
  runtime: 'bg-port-accent/20 text-port-accent border-port-accent/40',
  approved: 'bg-port-success/20 text-port-success border-port-success/40',
  candidate: 'bg-port-warning/20 text-port-warning border-port-warning/40',
  superseded: 'bg-port-bg text-gray-500 border-port-border',
  rejected: 'bg-port-error/20 text-port-error border-port-error/40',
  source: 'bg-port-bg text-gray-400 border-port-border',
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-block px-1 rounded-sm border text-[9px] leading-4 ${STATUS_TONE[status] || STATUS_TONE.source}`}>
      {status}
    </span>
  );
}

function AssetCard({ recordId, asset, actions, onInspect }) {
  const { facets } = asset;
  const name = asset.path.split('/').pop();
  const regenerate = actions?.regenerateFor(asset);
  const trim = actions?.trimFor(asset);

  return (
    <div className="bg-port-bg border border-port-border rounded p-1 space-y-1">
      <button
        type="button"
        onClick={() => onInspect(asset)}
        className="block w-full text-left rounded hover:opacity-80"
        title={asset.path}
      >
        {hasSpritePreview(asset) && (
          <SpritePreview recordId={recordId} path={asset.path} className="h-20 rounded" />
        )}
        <span className="block text-[10px] text-gray-500 truncate">{name}</span>
        <span className="flex items-center gap-1 text-[10px] text-gray-600">
          <StatusBadge status={facets.status} />
          {hasSpritePreview(asset) ? `${asset.width}×${asset.height}` : formatBytes(asset.size)}
        </span>
      </button>
      {(regenerate || trim) && (
        <div className="flex gap-1">
          {regenerate && (
            <button
              type="button"
              onClick={regenerate.onClick}
              disabled={regenerate.disabled}
              title={regenerate.title}
              className="flex-1 flex items-center justify-center gap-1 px-1 py-0.5 text-[10px] bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-40"
            >
              {regenerate.pending
                ? <RefreshCw className="w-3 h-3 animate-spin" />
                : regenerate.kind === 'reference' ? <Sparkles className="w-3 h-3" /> : <Film className="w-3 h-3" />}
              {regenerate.pending ? 'Rendering…' : 'Regenerate'}
            </button>
          )}
          {trim && (
            <button
              type="button"
              onClick={trim.onClick}
              title="Edit in Loop Trimmer"
              aria-label={`Edit ${name} in Loop Trimmer`}
              className="px-1.5 py-0.5 text-[10px] bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
            >
              <Scissors className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * `actions` is null for a non-character record (props families have no walk /
 * reference workflow to re-fire). Shape:
 *   { regenerateFor(asset) → { run, disabled, pending, title, kind } | null,
 *     trimFor(asset)       → { run } | null }
 *
 * `approvedRunIds` (#2938) is the set of run ids the walk selection has
 * approved. A run's strip/frames never move on approval — approval lives in
 * `walk.selection.directions[dir]`, not the path — so `spriteFacets.js` (a pure
 * PATH classifier) still reads their status as `candidate`. This is the ONE
 * facet that needs the record's live selection state, so the enrichment lands
 * here in the caller: an asset whose `runId` is an approved run is promoted to
 * `approved` for its badge, keeping the classifier free of workflow state.
 */
export default function AssetCollection({ recordId, assets, actions = null, approvedRunIds }) {
  const [inspecting, setInspecting] = useState(null);
  const groups = useMemo(() => {
    const grouped = groupSpriteAssetsByRole(assets);
    if (!approvedRunIds || approvedRunIds.size === 0) return grouped;
    return grouped.map((group) => ({
      ...group,
      assets: group.assets.map((row) => (
        row.facets.status === 'candidate' && row.facets.runId && approvedRunIds.has(row.facets.runId)
          ? { ...row, facets: { ...row.facets, status: 'approved' } }
          : row
      )),
    }));
  }, [assets, approvedRunIds]);

  return (
    <div className="space-y-4">
      {groups.map(({ role, label, assets: rows }) => (
        <div key={role}>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-300 mb-2">
            <FolderOpen className="w-4 h-4" /> {label}
            <span className="text-xs text-gray-500 font-normal">({rows.length})</span>
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {/* `actions` is the SINGLE gate on which cards get buttons — its
                two resolvers return null for an asset they can't act on (a
                manifest, an upload, a locked anchor), so there is no second
                role allow-list here to drift out of sync. */}
            {rows.map((asset) => (
              <AssetCard
                key={asset.path}
                recordId={recordId}
                asset={asset}
                actions={actions}
                onInspect={setInspecting}
              />
            ))}
          </div>
        </div>
      ))}
      <AssetInspector recordId={recordId} asset={inspecting} onClose={() => setInspecting(null)} />
    </div>
  );
}
