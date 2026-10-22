import { useEffect, useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import { formatCount, formatDateNumeric } from '../../utils/formatters';

// Per-source counts with a typed-confirmation erase (#12987). Deleting is
// irreversible locally, but importers are idempotent so re-importing the same
// export restores the rows. `onChanged` lets the page refresh the day view.
export default function ManageImportedDataPanel({ reloadKey, onChanged }) {
  const [sources, setSources] = useState([]);
  const [target, setTarget] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.getTimelineSources({ silent: true }).then((r) => { if (active) setSources(r?.sources || []); }).catch(() => {});
    return () => { active = false; };
  }, [reloadKey]);

  const cancel = () => { setTarget(null); setTyped(''); };

  const erase = async () => {
    setBusy(true);
    const result = await api.eraseTimelineSource(target).catch(() => null);
    setBusy(false);
    if (!result) return;
    toast.success(`Deleted ${formatCount(result.deleted)} ${target} event(s)`);
    setSources((list) => list.filter((s) => s.source !== target));
    cancel();
    onChanged?.();
  };

  if (sources.length === 0) return null;

  return (
    <div className="rounded border border-port-border bg-port-card p-3 text-xs">
      <div className="mb-2 font-medium text-gray-300">Manage imported data</div>
      <ul className="space-y-2">
        {sources.map((s) => (
          <li key={s.source}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-gray-200">{s.source}</span>
              <span className="text-gray-400">
                {formatCount(s.eventCount)} events
                {s.earliestAt && ` · ${formatDateNumeric(s.earliestAt)} – ${formatDateNumeric(s.latestAt)}`}
              </span>
              <button
                type="button"
                onClick={() => { setTarget(s.source); setTyped(''); }}
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
                <button type="button" onClick={cancel} className="px-2 py-1 text-gray-400 hover:text-gray-200">Cancel</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
