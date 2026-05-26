/**
 * Sharing → Duplicates. Lists same-named-but-different-id Universes / Series
 * that cross-install sync produced, and lets the user MERGE (smart field-union
 * + cascade) or RENAME one to disambiguate. "Keep both" hides the group for the
 * session (the records are legitimately distinct).
 *
 * The merge flow itself lives in shared pieces so the Universes page can offer
 * the same resolution inline: `useRecordMerge` (orchestration), `MergeModal`
 * (conflict picker), and `DuplicateGroup` (per-group rows + rename).
 */

import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { listUniverseDuplicates, listSeriesDuplicates } from '../../services/api';
import { useRecordMerge } from '../../hooks/useRecordMerge';
import DuplicateGroup from './DuplicateGroup';
import MergeModal from './MergeModal';

export default function DuplicatesTab() {
  const [loading, setLoading] = useState(true);
  const [universeGroups, setUniverseGroups] = useState([]);
  const [seriesGroups, setSeriesGroups] = useState([]);
  const [orphanCount, setOrphanCount] = useState(0);
  const [dismissed, setDismissed] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const [uni, ser] = await Promise.all([
      listUniverseDuplicates({ silent: true }).catch(() => ({ groups: [] })),
      listSeriesDuplicates({ silent: true }).catch(() => ({ series: [], orphanCount: 0 })),
    ]);
    setUniverseGroups(uni.groups || []);
    setSeriesGroups(ser.series || []);
    setOrphanCount(ser.orphanCount || 0);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const { merge, setMerge, openMerge, runPreview, executeMerge, runAIMerge, updateOverride } = useRecordMerge({ onMerged: load });

  const groupKey = (kind, normalizedName, scope = '') => `${kind}:${scope}:${normalizedName}`;

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-400 text-sm py-8"><Loader2 className="animate-spin" size={16} /> Scanning for duplicates…</div>;
  }

  const visibleUniverse = universeGroups.filter((g) => !dismissed.has(groupKey('universe', g.normalizedName)));
  const visibleSeries = seriesGroups.filter((g) => !dismissed.has(groupKey('series', g.normalizedName, g.universeId)));
  const nothing = visibleUniverse.length === 0 && visibleSeries.length === 0;

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Cross-install sync can leave two records with the same name but different ids (e.g. both machines created
        “Clandestiny”). Merge folds one into the other (unioning canon, re-pointing children) or rename one to keep both.
      </p>

      {nothing && (
        <div className="text-sm text-gray-500 py-8 text-center border border-port-border rounded-lg">
          ✓ No duplicates found.
          {orphanCount > 0 && <div className="mt-1 text-xs text-port-warning">{orphanCount} orphan series (no universe) — they’ll be adopted on next migration.</div>}
        </div>
      )}

      {visibleUniverse.map((g) => (
        <DuplicateGroup
          key={groupKey('universe', g.normalizedName)} kind="universe" label="Universe" group={g}
          onMerge={openMerge} onRenamed={load}
          onKeepBoth={() => setDismissed((s) => new Set(s).add(groupKey('universe', g.normalizedName)))}
        />
      ))}
      {visibleSeries.map((g) => (
        <DuplicateGroup
          key={groupKey('series', g.normalizedName, g.universeId)} kind="series"
          label={`Series in “${g.universeName || g.universeId}”`} group={g}
          onMerge={openMerge} onRenamed={load}
          onKeepBoth={() => setDismissed((s) => new Set(s).add(groupKey('series', g.normalizedName, g.universeId)))}
        />
      ))}

      {merge && (
        <MergeModal
          merge={merge} setMerge={setMerge} onExecute={executeMerge}
          onRepreview={(survivorId, loserId) => runPreview(merge.kind, survivorId, loserId, merge.records)}
          onAIMerge={runAIMerge} onUpdateOverride={updateOverride}
        />
      )}
    </div>
  );
}
