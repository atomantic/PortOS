/**
 * One group of same-named-but-different-id duplicate records (Universes or
 * Series in a universe). Renders each copy with its counts + an inline rename,
 * plus group-level "Merge…" and "Keep both" actions. Shared between Sharing →
 * Duplicates (DuplicatesTab) and the inline resolver on the Universes page.
 */

import { useEffect, useState } from 'react';
import { GitMerge, Pencil, Check, X, Copy } from 'lucide-react';
import toast from '../ui/Toast';
import { updateUniverse, updatePipelineSeries } from '../../services/api';

export default function DuplicateGroup({ kind, label, group, onMerge, onRenamed, onKeepBoth }) {
  return (
    <div className="border border-port-border rounded-lg p-4 bg-port-card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-white flex items-center gap-2">
          <Copy size={14} className="text-port-warning" /> {label}: <span className="text-port-warning">{group.records[0].name}</span>
          <span className="text-xs text-gray-500">({group.records.length} copies)</span>
        </h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onMerge(kind, group.records)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent hover:bg-port-accent/90 text-white text-xs font-medium">
            <GitMerge size={13} /> Merge…
          </button>
          <button type="button" onClick={onKeepBoth}
            className="px-2.5 py-1.5 rounded border border-port-border text-gray-400 hover:text-white text-xs">
            Keep both
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {group.records.map((r) => <RecordRow key={r.id} kind={kind} record={r} onRenamed={onRenamed} />)}
      </div>
    </div>
  );
}

function RecordRow({ kind, record, onRenamed }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(record.name);
  const [busy, setBusy] = useState(false);

  // Keep the editable name in sync with the prop after a rename + reload so
  // reopening the inline editor never shows the stale initial value. Only when
  // not actively editing, so we don't clobber the user's in-progress text.
  useEffect(() => {
    if (!editing) setName(record.name);
  }, [record.name, editing]);

  const save = async () => {
    if (!name.trim() || name === record.name) { setEditing(false); return; }
    setBusy(true);
    const update = kind === 'universe' ? updateUniverse : updatePipelineSeries;
    const ok = await update(record.id, { name: name.trim() }, { silent: true })
      .then(() => true).catch((err) => { toast.error(`Rename failed: ${err.message}`); return false; });
    setBusy(false);
    if (ok) { toast.success('Renamed'); setEditing(false); onRenamed(); }
  };

  const counts = record.counts;
  return (
    <div className="flex items-center justify-between gap-3 text-xs bg-port-bg border border-port-border rounded px-3 py-2">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
              className="flex-1 px-2 py-1 bg-port-card border border-port-border rounded text-white" />
            <button type="button" onClick={save} disabled={busy} aria-label="Save" className="text-port-success hover:opacity-80"><Check size={14} /></button>
            <button type="button" onClick={() => { setEditing(false); setName(record.name); }} aria-label="Cancel" className="text-gray-500 hover:text-white"><X size={14} /></button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-white truncate">{record.name}</span>
            <button type="button" onClick={() => setEditing(true)} aria-label="Rename" className="text-gray-500 hover:text-white" title="Rename"><Pencil size={12} /></button>
          </div>
        )}
        <div className="text-gray-500 mt-0.5 font-mono truncate">{record.id}</div>
      </div>
      <div className="text-gray-400 text-right whitespace-nowrap">
        {counts && <div>{counts.characters}c · {counts.places}p · {counts.objects}o · {counts.categories} cats</div>}
        {kind === 'universe' && <div>{record.linkedSeriesCount} series · {record.linkedCollectionItemCount} media</div>}
        {kind === 'series' && <div>{record.seasonCount} seasons{record.hasArc ? ' · arc' : ''}</div>}
        <div className="text-[10px]">updated {record.updatedAt?.slice(0, 10)}</div>
      </div>
    </div>
  );
}
