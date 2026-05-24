/**
 * Universes page — universe index.
 *
 * Lists every universe (the long-lived style/canon parent that pipeline series
 * inherit from) in a table and lets the user create, open, or delete any of
 * them. Mirrors the Series Pipeline index (`Pipeline.jsx`): the heavy editor
 * lives at `/universes/:id`, and `New Universe` drops into a blank editor at
 * `/universes/new`.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Globe, Trash2, Users, Workflow as WorkflowIcon } from 'lucide-react';
import toast from '../components/ui/Toast';
import ShareToButton from '../components/sharing/ShareToButton';
import SyncToPeerButton from '../components/sharing/SyncToPeerButton';
import OriginBadge from '../components/sharing/OriginBadge';
import { timeAgo } from '../utils/formatters';
import { listUniverses, deleteUniverse, listPipelineSeries } from '../services/api';

// Named canon entities across all trunks — the "Canon" column reflects the
// characters/places/objects the user has registered, not the looser variation
// buckets (which are render scratch space, not canon).
const canonCount = (u) =>
  (Array.isArray(u?.characters) ? u.characters.length : 0) +
  (Array.isArray(u?.places) ? u.places.length : 0) +
  (Array.isArray(u?.objects) ? u.objects.length : 0);

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
  const [universes, setUniverses] = useState([]);
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(true);

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
    return () => { cancelled = true; };
  }, []);

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
                      <Link to={`/universes/${encodeURIComponent(u.id)}`} className="block min-w-0 group">
                        <div className="text-white font-medium flex items-center gap-2 flex-wrap group-hover:text-port-accent transition-colors">
                          <span>{u.name || '(untitled universe)'}</span>
                          {u.origin ? <OriginBadge origin={u.origin} compact /> : null}
                        </div>
                        {u.logline ? (
                          <div className="text-xs text-gray-500 mt-0.5 line-clamp-1 break-words">{u.logline}</div>
                        ) : null}
                      </Link>
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
                  <Link to={`/universes/${encodeURIComponent(u.id)}`} className="flex-1 min-w-0">
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
                  </Link>
                  <DeleteButton universe={u} armed={armedId === u.id} onDelete={handleDelete} />
                </div>
                <div className="flex items-center gap-1 mt-2">
                  <ShareToButton kind="universe" ids={[u.id]} compact />
                  <SyncToPeerButton recordKind="universe" recordId={u.id} compact />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
