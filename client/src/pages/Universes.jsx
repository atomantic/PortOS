/**
 * Universes page — universe index.
 *
 * Lists every universe (the long-lived style/canon parent that pipeline series
 * inherit from) in a table and lets the user create, open, or delete any of
 * them. Mirrors the Series Pipeline index (`Pipeline.jsx`): the heavy editor
 * lives at `/universes/:id`, and `New Universe` drops into a blank editor at
 * `/universes/new`.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Globe, Trash2, Users, Workflow as WorkflowIcon, Copy } from 'lucide-react';
import toast from '../components/ui/Toast';
import ShareToButton from '../components/sharing/ShareToButton';
import SyncToPeerButton from '../components/sharing/SyncToPeerButton';
import OriginBadge from '../components/sharing/OriginBadge';
import SyncBadge from '../components/sync/SyncBadge';
import DuplicateGroup from '../components/sharing/DuplicateGroup';
import MergeModal from '../components/sharing/MergeModal';
import { timeAgo } from '../utils/formatters';
import { listUniverses, deleteUniverse, listPipelineSeries, listMediaCollections, listUniverseDuplicates } from '../services/api';
import { useSyncIntegrity, syncBadgeStatus } from '../hooks/useSyncIntegrity';
import { useRecordMerge } from '../hooks/useRecordMerge';

// Named canon entities across all trunks — the "Canon" column reflects the
// characters/places/objects the user has registered, not the looser variation
// buckets (which are render scratch space, not canon).
const canonCount = (u) =>
  (Array.isArray(u?.characters) ? u.characters.length : 0) +
  (Array.isArray(u?.places) ? u.places.length : 0) +
  (Array.isArray(u?.objects) ? u.objects.length : 0);

// Build universeId → latest image filename from media collections. Mirrors
// resolveCover() in MediaCollections.jsx but trimmed: we only care about image
// items (videos don't render as a row thumbnail here) and the bucket is
// already identified by `collection.universeId`, so coverKey-pinning + cross-
// gallery lookup are unnecessary — items are already keyed to /data/images.
// Single O(n) pass per collection to avoid O(n log n) on near-ITEMS_MAX buckets.
const buildLatestImageByUniverse = (collections) => {
  const out = new Map();
  for (const c of collections || []) {
    if (!c?.universeId) continue;
    let bestRef = null;
    let bestTs = -Infinity;
    for (const it of c.items || []) {
      if (it.kind !== 'image') continue;
      const ts = new Date(it.addedAt || 0).getTime();
      if (ts > bestTs) { bestTs = ts; bestRef = it.ref; }
    }
    if (bestRef) out.set(c.universeId, bestRef);
  }
  return out;
};

// 48px square thumbnail showing the latest image from the universe's
// auto-managed media collection (or a Globe placeholder when the collection
// is empty or hasn't loaded yet). onError hides the <img> so a stale
// collection entry pointing at a deleted file falls back to the placeholder
// instead of a broken-image icon. Shared between desktop row and mobile card.
function UniverseThumb({ imageRef }) {
  const [broken, setBroken] = useState(false);
  const showImage = imageRef && !broken;
  return (
    <div className="flex-shrink-0 w-12 h-12 rounded-md overflow-hidden bg-port-bg border border-port-border flex items-center justify-center">
      {showImage ? (
        <img
          src={`/data/images/${encodeURIComponent(imageRef)}`}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <Globe className="w-5 h-5 text-gray-600" aria-hidden="true" />
      )}
    </div>
  );
}

// Shared between the desktop table row and the mobile card so the armed-state
// styling + a11y labels stay in one place.
function DeleteButton({ universe, armed, onDelete }) {
  const name = universe.name || '(untitled universe)';
  return (
    <button
      type="button"
      onClick={() => onDelete(universe)}
      className={`p-2 ${armed ? 'text-port-error' : 'text-gray-500 hover:text-port-error'}`}
      aria-label={armed ? `Confirm delete universe ${name}` : `Delete universe ${name}`}
      title={armed ? 'Click again to confirm delete' : 'Delete universe'}
    >
      <Trash2 size={16} />
    </button>
  );
}

export default function Universes() {
  const navigate = useNavigate();
  const [universes, setUniverses] = useState([]);
  const [series, setSeries] = useState([]);
  const [latestImageByUniverse, setLatestImageByUniverse] = useState(() => new Map());
  const [loading, setLoading] = useState(true);
  // Same-named-but-different-id universes (e.g. cross-install sync produced two
  // "Clandestiny"s). Surfaced as a banner so the user can merge them here even
  // when it wasn't caught at sync time. Mirrors Sharing → Duplicates, scoped to
  // universes. `dismissedDupes` hides a group for the session ("Keep both").
  const [duplicateGroups, setDuplicateGroups] = useState([]);
  const [dismissedDupes, setDismissedDupes] = useState(() => new Set());

  const sync = useSyncIntegrity('universe');

  const loadDuplicates = useCallback(
    () => listUniverseDuplicates({ silent: true })
      .then((d) => setDuplicateGroups(Array.isArray(d?.groups) ? d.groups : []))
      .catch(() => {}),
    [],
  );

  useEffect(() => {
    // Guard setState against a navigate-away before the fetch resolves —
    // mirrors the editor's load effect (UniverseBuilder.jsx).
    let cancelled = false;
    // Universes drive the page; resolve `loading` as soon as they land so a
    // slow/hung series fetch can't keep the list stuck on "Loading…".
    // silent: the custom catch below owns the error toast (CLAUDE.md).
    listUniverses({ silent: true })
      .catch((err) => {
        toast.error(err.message || 'Failed to load universes');
        return [];
      })
      .then((u) => {
        if (cancelled) return;
        setUniverses(Array.isArray(u) ? u : []);
        setLoading(false);
      });
    // Series counts are a nice-to-have join, fetched independently — a failed
    // or slow request should never block the universe list (counts just show
    // 0). silent: swallowed to [] with no toast, so suppress request()'s.
    listPipelineSeries({ silent: true })
      .catch(() => [])
      .then((s) => {
        if (cancelled) return;
        setSeries(Array.isArray(s) ? s : []);
      });
    // Latest-image thumbnails come from each universe's auto-managed media
    // collection (bucket links via `collection.universeId`). Independent fetch
    // so a slow/failed media-collections endpoint never blocks the list —
    // rows just render without a thumbnail.
    listMediaCollections({ silent: true })
      .catch(() => [])
      .then((cols) => {
        if (cancelled) return;
        setLatestImageByUniverse(buildLatestImageByUniverse(cols));
      });
    // Duplicate detection is on-demand (computed server-side from the live
    // universe set), independent of the list/joins above.
    loadDuplicates();
    return () => { cancelled = true; };
  }, [loadDuplicates]);

  // Re-fetch after a merge or rename: the loser is tombstoned (so it drops from
  // the list), its child series are re-pointed (series counts shift), and its
  // media folds into the survivor (thumbnails shift). Re-scan duplicates last so
  // a folded group disappears from the banner.
  const refresh = useCallback(() => {
    listUniverses({ silent: true })
      .then((u) => setUniverses(Array.isArray(u) ? u : []))
      .catch((err) => toast.error(err.message || 'Failed to reload universes'));
    listPipelineSeries({ silent: true })
      .then((s) => setSeries(Array.isArray(s) ? s : []))
      .catch(() => {});
    listMediaCollections({ silent: true })
      .then((cols) => setLatestImageByUniverse(buildLatestImageByUniverse(cols)))
      .catch(() => {});
    return loadDuplicates();
  }, [loadDuplicates]);

  const { merge, setMerge, openMerge, runPreview, executeMerge, runAIMerge, updateOverride } = useRecordMerge({ onMerged: refresh });

  // "Keep both" hides a group for the session; the records are legitimately
  // distinct. Filtered against the live group list so a newly-merged group that
  // re-fetches away is simply gone (no stale dismissal lingering).
  const visibleDupes = duplicateGroups.filter((g) => !dismissedDupes.has(g.normalizedName));

  // universeId → linked-series count. Reverse of the join Pipeline.jsx does
  // (series carry universeId; here we tally per universe).
  const seriesCountByUniverse = useMemo(() => {
    const m = {};
    for (const s of series) {
      if (s.universeId) m[s.universeId] = (m[s.universeId] || 0) + 1;
    }
    return m;
  }, [series]);

  // Two-click delete: first click "arms" the row, second click fires. Avoids
  // window.confirm (banned per CLAUDE.md) without pulling in a modal. armedId
  // resets after the action or when a different row is armed.
  const [armedId, setArmedId] = useState(null);
  const handleDelete = async (u) => {
    if (armedId !== u.id) {
      setArmedId(u.id);
      return;
    }
    setArmedId(null);
    setUniverses((prev) => prev.filter((x) => x.id !== u.id));
    // silent: the custom catch below owns the error toast (CLAUDE.md).
    await deleteUniverse(u.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Delete failed');
      // Roll back only this row (re-insert if still missing) so a concurrent
      // delete's optimistic removal isn't clobbered by a stale full-list
      // snapshot. Re-sort by the server's order (createdAt desc, newest-first)
      // so the restored row lands in its original position, not at the end.
      setUniverses((prev) =>
        prev.some((x) => x.id === u.id)
          ? prev
          : [...prev, u].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
      );
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Globe className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Universes</h1>
        </div>
        <Link
          to="/universes/new"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
        >
          <Plus size={16} aria-hidden="true" />
          New Universe
        </Link>
      </div>

      <p className="text-sm text-gray-400 mb-6">
        A universe holds the shared style, influences, and canon (characters, places, objects) that every
        pipeline series and batch render inherits. Build one here, then link series to it from the Series Pipeline.
      </p>

      {visibleDupes.length > 0 && (
        <div className="mb-6 border border-port-warning/40 bg-port-warning/10 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-port-warning font-medium">
            <Copy size={16} aria-hidden="true" />
            <span>
              {visibleDupes.length} duplicate-named {visibleDupes.length === 1 ? 'universe' : 'universes'} detected.
              Merge folds one copy into the other — unioning canon, re-pointing series, and tombstoning the duplicate.
            </span>
          </div>
          {visibleDupes.map((g) => (
            <DuplicateGroup
              key={g.normalizedName} kind="universe" label="Universe" group={g}
              onMerge={openMerge} onRenamed={refresh}
              onKeepBoth={() => setDismissedDupes((s) => new Set(s).add(g.normalizedName))}
            />
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading universes…</div>
      ) : universes.length === 0 ? (
        <div className="text-gray-500 text-sm">
          No universes yet. Click <span className="text-port-accent">New Universe</span> to start.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto bg-port-card border border-port-border rounded-lg">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-port-border">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Name</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Canon</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Series</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Updated</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {universes.map((u) => (
                  <tr key={u.id} className="border-b border-port-border/50 last:border-0 hover:bg-port-bg/40 transition-colors">
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-start gap-2 min-w-0">
                        <Link to={`/universes/${encodeURIComponent(u.id)}`} className="flex items-start gap-3 min-w-0 group flex-1">
                          <UniverseThumb imageRef={latestImageByUniverse.get(u.id)} />
                          <div className="min-w-0 flex-1">
                            <div className="text-white font-medium flex items-center gap-2 flex-wrap group-hover:text-port-accent transition-colors">
                              <span>{u.name || '(untitled universe)'}</span>
                              {u.origin ? <OriginBadge origin={u.origin} compact /> : null}
                            </div>
                            {u.logline ? (
                              <div className="text-xs text-gray-500 mt-0.5 line-clamp-1 break-words">{u.logline}</div>
                            ) : null}
                          </div>
                        </Link>
                        <SyncBadge
                          status={syncBadgeStatus(sync, u.id)}
                          onClick={() => navigate(`/universes/${encodeURIComponent(u.id)}/sync`)}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-sm text-gray-300 font-mono">{canonCount(u)}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-sm text-gray-300 font-mono">{seriesCountByUniverse[u.id] || 0}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">{timeAgo(u.updatedAt || u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <ShareToButton kind="universe" ids={[u.id]} compact />
                        <SyncToPeerButton recordKind="universe" recordId={u.id} compact />
                        <DeleteButton universe={u} armed={armedId === u.id} onDelete={handleDelete} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 sm:hidden">
            {universes.map((u) => (
              <li key={u.id} className="p-3 bg-port-card border border-port-border rounded-lg">
                <div className="flex items-start justify-between gap-3">
                  <Link to={`/universes/${encodeURIComponent(u.id)}`} className="flex items-start gap-3 flex-1 min-w-0">
                    <UniverseThumb imageRef={latestImageByUniverse.get(u.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-white font-medium flex items-center gap-2 flex-wrap">
                        <span>{u.name || '(untitled universe)'}</span>
                        {u.origin ? <OriginBadge origin={u.origin} compact /> : null}
                      </div>
                      {u.logline ? (
                        <div className="text-xs text-gray-500 mt-0.5 break-words">{u.logline}</div>
                      ) : null}
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        <span className="inline-flex items-center gap-1"><Users size={12} /> {canonCount(u)} canon</span>
                        <span className="inline-flex items-center gap-1"><WorkflowIcon size={12} /> {seriesCountByUniverse[u.id] || 0} series</span>
                        <span>{timeAgo(u.updatedAt || u.createdAt)}</span>
                      </div>
                    </div>
                  </Link>
                  <DeleteButton universe={u} armed={armedId === u.id} onDelete={handleDelete} />
                </div>
                <div className="flex items-center gap-1 mt-2">
                  <ShareToButton kind="universe" ids={[u.id]} compact />
                  <SyncToPeerButton recordKind="universe" recordId={u.id} compact />
                  <SyncBadge
                    status={syncBadgeStatus(sync, u.id)}
                    onClick={() => navigate(`/universes/${encodeURIComponent(u.id)}/sync`)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

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
