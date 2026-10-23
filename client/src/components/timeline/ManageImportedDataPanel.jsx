import { useEffect, useRef, useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import { formatCount, formatDateNumeric } from '../../utils/formatters';

// Per-source counts with a typed-confirmation erase (#12987). Deleting is
// irreversible locally, but importers are idempotent so re-importing the same
// export restores the rows. `onChanged` lets the page refresh the day view.
export default function ManageImportedDataPanel({ reloadKey, onChanged }) {
  const [sources, setSources] = useState([]);
  const [target, setTarget] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);
  const pending = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    const current = ++generation.current;
    api.getTimelineSources({ silent: true }).then((r) => {
      if (active && generation.current === current) { setSources(r?.sources || []); setError(null); }
    }).catch((err) => { if (active && generation.current === current) setError(err.message || 'Could not load imported data.'); });
    return () => { active = false; };
  }, [reloadKey]);

  const cancel = () => { setTarget(null); setTyped(''); };

  const erase = async () => {
    const source = target;
    if (pending.current || !source || typed !== source) return;
    pending.current = true;
    generation.current++;
    setBusy(true);
    setError(null);
    const result = await api.eraseTimelineSource(source, { silent: true })
      .catch((err) => { setError(err.message || 'Could not delete imported data.'); return null; });
    pending.current = false;
    setBusy(false);
    if (!result) return;
    toast.success(`Deleted ${formatCount(result.deleted)} ${source} event(s)`);
    setRemoving(source);
    cancel();
  };

  const finishRemoval = (source) => {
    setSources((list) => list.filter((row) => row.source !== source));
    setRemoving(null);
    onChanged?.();
  };

  if (sources.length === 0 && !error) return null;

  return (
    <div className="rounded border border-port-border bg-port-card p-3 text-xs">
      <div className="mb-2 font-medium text-gray-300">Manage imported data</div>
      {error && <p role="alert" className="mb-2 text-port-error">{error}</p>}
      <div role="list" tabIndex={-1}>
        {sources.map((s) => (
          <CollapsibleListItem key={s.source} removing={removing === s.source} onExited={() => finishRemoval(s.source)}>
            <div role="listitem">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-gray-200">{s.source}</span>
              <span className="text-gray-400">
                {formatCount(s.eventCount)} events
                {s.earliestAt && ` · ${formatDateNumeric(s.earliestAt)} – ${formatDateNumeric(s.latestAt)}`}
              </span>
              <button
                type="button"
                disabled={busy || !!removing}
                onClick={() => { setTarget(s.source); setTyped(''); setError(null); }}
                className="ml-auto inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-port-error hover:border-port-error"
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
            {target === s.source && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label htmlFor={`erase-${s.source}`} className="text-gray-400">
                  Type <span className="font-mono text-gray-200">{s.source}</span> to delete all {formatCount(s.eventCount)} events
                </label>
                <input
                  id={`erase-${s.source}`}
                  disabled={busy}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="rounded border border-port-border bg-port-bg px-2 py-1 text-gray-200"
                />
                <button
                  type="button"
                  disabled={typed !== s.source || busy}
                  onClick={erase}
                  className="inline-flex items-center gap-1 rounded bg-port-error px-2 py-1 text-white disabled:opacity-40"
                >
                  {busy && <Loader2 size={12} className="animate-spin" />} Confirm delete
                </button>
                <button type="button" disabled={busy} onClick={cancel} className="px-2 py-1 text-gray-400 hover:text-gray-200">Cancel</button>
              </div>
            )}
          </div>
          </CollapsibleListItem>
        ))}
      </div>
    </div>
  );
}
