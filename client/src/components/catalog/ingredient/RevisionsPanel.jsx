// Revision history for a catalog ingredient: per-field diff against the saved
// record and an inline-confirmed restore into the editable form.

import { useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair.jsx';
import { humanizeIntegrityField } from '../../../lib/characterIntegrity';
import { timeAgo } from '../../../utils/formatters';
import { sameValue } from './ingredientDraft';

const SOURCE_BADGE = {
  user:    'bg-port-accent/20 text-port-accent border-port-accent/40',
  extract: 'bg-port-accent-2/20 text-port-accent-2 border-port-accent-2/40',
  refine:  'bg-port-warning/20 text-port-warning border-port-warning/40',
  sync:    'bg-port-success/20 text-port-success border-port-success/40',
};

// Build the label set for diffing: the editor fields plus name + tags. Used to
// render a field-by-field "what changed" diff between a revision and the
// currently-saved record.
function diffRevisionAgainstCurrent(revision, current, fields) {
  const out = [];
  const curName = current?.name || '';
  if ((revision.name || '') !== curName) {
    out.push({ key: '__name', label: 'Name', from: revision.name || '', to: curName });
  }
  const curTags = (current?.tags || []).join(', ');
  const revTags = (revision.tags || []).join(', ');
  if (revTags !== curTags) {
    out.push({ key: '__tags', label: 'Tags', from: revTags, to: curTags });
  }
  const curPayload = current?.payload || {};
  const revPayload = revision.payload || {};
  // `fields` is either the system tuple form `[key, label, kind]` or the
  // user-type object form `{ key, label, widget }` — normalize to [key, label].
  const fieldPairs = (fields || []).map((f) => (Array.isArray(f) ? [f[0], f[1]] : [f.key, f.label]));
  for (const [key, label] of fieldPairs) {
    const from = revPayload[key] ?? '';
    const to = curPayload[key] ?? '';
    if (String(from) !== String(to)) out.push({ key, label, from: String(from), to: String(to) });
  }
  // Array editors and read-only/forward-compatible canon fields are not in
  // editorFields. Their changes must never make a revision look identical.
  const displayed = new Set(out.map((change) => change.key));
  const additional = [...new Set([...Object.keys(revPayload), ...Object.keys(curPayload)])]
    .filter((key) => !displayed.has(key) && !sameValue(revPayload[key], curPayload[key]));
  if (additional.length > 0) out.push({
    key: '__additional', label: 'Additional fields changed',
    summary: additional.map(humanizeIntegrityField).join(', '),
  });
  return out;
}

export default function RevisionsPanel({ revisions, loading, error, onLoad, current, fields, onRestore, readOnly = false, retainedSourceId }) {
  const [openId, setOpenId] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [pendingRestore, setPendingRestore] = useState(null);

  const list = Array.isArray(revisions) ? revisions : [];

  const handleRestore = async (id) => {
    setRestoring(id);
    try {
      if (await onRestore(id)) setPendingRestore(null);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
        <History size={15} className="text-port-accent" aria-hidden="true" /> Revision history
        {list.length > 0 && <span className="text-xs text-gray-500 font-normal">({list.length})</span>}
      </h2>
      {error && <p role="alert" className="text-xs text-port-error">{error} <button type="button" onClick={onLoad} disabled={loading} className="underline">Retry history</button></p>}
      {loading && revisions !== null && <p role="status" className="text-xs text-gray-400">Refreshing history…</p>}
      {revisions === null ? <button type="button" onClick={onLoad} disabled={loading} className="min-h-[44px] px-3 py-2 text-xs text-port-accent border border-port-border rounded">{loading ? 'Loading history…' : 'Load revision history'}</button> : list.length === 0 ? (
        <p className="text-xs text-gray-500">No revisions recorded yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((rev, i) => {
            const open = openId === rev.id;
            const isLatest = i === 0;
            const diff = open ? diffRevisionAgainstCurrent(rev, current, fields) : [];
            const badge = SOURCE_BADGE[rev.source] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
            return (
              <li key={rev.id} className="border border-port-border rounded bg-port-bg">
                <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : rev.id)}
                    className="flex items-center gap-2 min-w-0 text-left flex-1 hover:opacity-90"
                    aria-expanded={open}
                  >
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge}`}>
                      {rev.source}
                    </span>
                    <span className="text-xs text-gray-300 truncate">{rev.name || '(untitled)'}</span>
                    {rev.actor && <span className="text-[10px] text-gray-500 truncate">· {rev.actor}</span>}
                    <span className="text-[10px] text-gray-500 whitespace-nowrap ml-auto">{timeAgo(rev.createdAt)}</span>
                  </button>
                  {!isLatest && !readOnly && !(retainedSourceId && rev.ingredientId === retainedSourceId) && (
                    pendingRestore === rev.id ? (
                      <ConfirmButtonPair
                        prompt="Replace current form?"
                        confirmText="Restore"
                        confirmIcon={RotateCcw}
                        tone="warning"
                        busy={restoring === rev.id}
                        busyText="Restoring"
                        onConfirm={() => handleRestore(rev.id)}
                        onCancel={() => setPendingRestore(null)}
                        ariaLabel={`Confirm restore of ${rev.name || 'revision'}`}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPendingRestore(rev.id)}
                        disabled={restoring === rev.id}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-port-border text-gray-400 hover:text-white disabled:opacity-50"
                        title="Restore this revision"
                      >
                        <RotateCcw size={11} aria-hidden="true" /> Restore
                      </button>
                    )
                  )}
                  {isLatest && (
                    <span className="text-[10px] text-gray-500 px-1 whitespace-nowrap">current</span>
                  )}
                </div>
                {open && (
                  <div className="px-2.5 pb-2 pt-0.5 border-t border-port-border">
                    {diff.length === 0 ? (
                      <p className="text-[11px] text-gray-500 mt-1.5">Identical to the current saved state.</p>
                    ) : (
                      <dl className="mt-1.5 space-y-1.5">
                        {diff.map((d) => (
                          <div key={d.key} className="text-[11px]">
                            <dt className="text-gray-500 uppercase tracking-wider text-[9px] mb-0.5">{d.label}</dt>
                            {d.summary ? <dd className="text-gray-300 break-words">{d.summary}</dd> : <dd className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                              <span className="px-1.5 py-0.5 rounded bg-port-error/10 text-port-error/90 break-words">
                                {d.from || <em className="text-gray-600">empty</em>}
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-port-success/10 text-port-success/90 break-words">
                                {d.to || <em className="text-gray-600">empty</em>}
                              </span>
                            </dd>}
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
