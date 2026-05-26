/**
 * Sharing → Duplicates. Lists same-named-but-different-id Universes / Series
 * that cross-install sync produced, and lets the user MERGE (smart field-union
 * + cascade) or RENAME one to disambiguate. "Keep both" hides the group for the
 * session (the records are legitimately distinct).
 */

import { useEffect, useState, useCallback } from 'react';
import { Loader2, GitMerge, Pencil, Check, X, Copy } from 'lucide-react';
import toast from '../ui/Toast';
import Modal from '../ui/Modal';
import InlineDiff from '../ui/InlineDiff';
import {
  listUniverseDuplicates, listSeriesDuplicates,
  previewUniverseMerge, mergeUniverses, previewSeriesMerge, mergeSeries,
  updateUniverse, updatePipelineSeries,
} from '../../services/api';

const asText = (v) => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

export default function DuplicatesTab() {
  const [loading, setLoading] = useState(true);
  const [universeGroups, setUniverseGroups] = useState([]);
  const [seriesGroups, setSeriesGroups] = useState([]);
  const [orphanCount, setOrphanCount] = useState(0);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [merge, setMerge] = useState(null); // { kind, records, survivorId, loserId, preview, choices, busy }

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

  const groupKey = (kind, normalizedName, scope = '') => `${kind}:${scope}:${normalizedName}`;

  const openMerge = async (kind, records) => {
    const survivorId = records[0].id;
    const loserId = records[1].id;
    setMerge({ kind, records, survivorId, loserId, preview: null, choices: {}, busy: true });
    await runPreview(kind, survivorId, loserId, records);
  };

  const runPreview = async (kind, survivorId, loserId, records) => {
    // Commit the new survivor/loser ids and invalidate the current preview up
    // front so a quick "Merge" click during the in-flight request can't run with
    // stale ids/choices (the Merge button gates on `busy || !preview`).
    setMerge((m) => (m ? {
      ...m, kind, survivorId, loserId, records: records || m.records, preview: null, choices: {}, busy: true,
    } : m));
    const preview = (kind === 'universe' ? previewUniverseMerge : previewSeriesMerge);
    const result = await preview({ survivorId, loserId }, { silent: true }).catch((err) => {
      toast.error(`Preview failed: ${err.message}`);
      return null;
    });
    setMerge((m) => (m ? {
      ...m, kind, survivorId, loserId, records: records || m.records, preview: result,
      // Default each conflicting field to the survivor's value.
      choices: Object.fromEntries((result?.conflicts || []).map((c) => [c.field, 'survivor'])),
      busy: false,
    } : m));
  };

  const executeMerge = async () => {
    const { kind, survivorId, loserId, choices } = merge;
    setMerge((m) => ({ ...m, busy: true }));
    const run = kind === 'universe' ? mergeUniverses : mergeSeries;
    const ok = await run({ survivorId, loserId, fieldChoices: choices }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Merge failed: ${err.message}`); return false; });
    if (ok) {
      toast.success('Merged — the duplicate was folded in and tombstoned.');
      setMerge(null);
      await load();
    } else {
      setMerge((m) => (m ? { ...m, busy: false } : m));
    }
  };

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
        />
      )}
    </div>
  );
}

function DuplicateGroup({ kind, label, group, onMerge, onRenamed, onKeepBoth }) {
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
            <button type="button" onClick={save} disabled={busy} className="text-port-success hover:opacity-80"><Check size={14} /></button>
            <button type="button" onClick={() => { setEditing(false); setName(record.name); }} className="text-gray-500 hover:text-white"><X size={14} /></button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-white truncate">{record.name}</span>
            <button type="button" onClick={() => setEditing(true)} className="text-gray-500 hover:text-white" title="Rename"><Pencil size={12} /></button>
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

function MergeModal({ merge, setMerge, onExecute, onRepreview }) {
  const { kind, records, survivorId, loserId, preview, choices, busy } = merge;
  const conflicts = preview?.conflicts || [];
  const cascade = preview?.cascade || {};
  const multi = records.length > 2; // 3+ copies fold one pair at a time

  const setChoice = (field, val) => setMerge((m) => ({ ...m, choices: { ...m.choices, [field]: val } }));
  const swapSurvivor = (newSurvivorId) => {
    // Keep the current loser unless it collides with the new survivor, then
    // pick the first remaining record so survivor and loser always differ.
    const keepLoser = loserId !== newSurvivorId && records.some((r) => r.id === loserId);
    const newLoser = keepLoser ? loserId : records.find((r) => r.id !== newSurvivorId)?.id;
    onRepreview(newSurvivorId, newLoser);
  };
  const loser = records.find((r) => r.id === loserId);

  return (
    <Modal open onClose={() => !busy && setMerge(null)} size="2xl" ariaLabel="Merge duplicates">
      <div className="p-5 space-y-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2"><GitMerge size={18} /> Merge {kind}</h2>

        <div>
          <label className="block text-xs text-gray-400 mb-1">Keep (survivor)</label>
          <div className="grid gap-2">
            {records.map((r) => (
              <label key={r.id} className={`flex items-center gap-2 px-3 py-2 rounded border cursor-pointer text-sm ${r.id === survivorId ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400'}`}>
                <input type="radio" name="survivor" checked={r.id === survivorId} onChange={() => swapSurvivor(r.id)} />
                <span className="truncate">{r.name} <span className="font-mono text-[10px] text-gray-500">{r.id.slice(0, 12)}</span></span>
                {r.id === loserId && <span className="ml-auto text-[10px] text-port-error">→ folds in</span>}
              </label>
            ))}
          </div>
        </div>

        {multi ? (
          <div>
            <label className="block text-xs text-gray-400 mb-1">Fold in (this merge folds one copy at a time — repeat for the rest)</label>
            <div className="grid gap-2">
              {records.filter((r) => r.id !== survivorId).map((r) => (
                <label key={r.id} className={`flex items-center gap-2 px-3 py-2 rounded border cursor-pointer text-sm ${r.id === loserId ? 'border-port-error/60 bg-port-error/10 text-white' : 'border-port-border text-gray-400'}`}>
                  <input type="radio" name="loser" checked={r.id === loserId} onChange={() => onRepreview(survivorId, r.id)} />
                  <span className="truncate">{r.name} <span className="font-mono text-[10px] text-gray-500">{r.id.slice(0, 12)}</span></span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-500">Folding in &amp; tombstoning <span className="text-port-error">{loser?.name}</span> <span className="font-mono text-[10px]">{loser?.id.slice(0, 12)}</span>.</p>
        )}

        {busy && !preview && <div className="flex items-center gap-2 text-gray-400 text-sm"><Loader2 className="animate-spin" size={14} /> Building preview…</div>}

        {preview && conflicts.length > 0 && (
          <div>
            <label className="block text-xs text-gray-400 mb-2">{conflicts.length} conflicting field(s) — pick which value wins:</label>
            <div className="space-y-3">
              {conflicts.map((c) => (
                <div key={c.field} className="border border-port-border rounded p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-white">{c.field}</span>
                    <div className="flex gap-1 text-[11px]">
                      <button type="button" onClick={() => setChoice(c.field, 'survivor')} className={`px-2 py-0.5 rounded ${choices[c.field] === 'survivor' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400'}`}>Keep survivor</button>
                      <button type="button" onClick={() => setChoice(c.field, 'loser')} className={`px-2 py-0.5 rounded ${choices[c.field] === 'loser' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400'}`}>Use folded</button>
                    </div>
                  </div>
                  <InlineDiff oldText={asText(c.survivorValue)} newText={asText(c.loserValue)} />
                </div>
              ))}
            </div>
          </div>
        )}

        {preview && conflicts.length === 0 && (
          <div className="text-xs text-port-success">No conflicting fields — unique data from both will be unioned.</div>
        )}

        {preview && (
          <div className="text-xs text-gray-400 border-t border-port-border pt-3">
            Cascade: {kind === 'universe'
              ? `${cascade.seriesToRepoint?.length || 0} child series re-pointed · ${cascade.loserCollectionItemCount || 0} media items folded`
              : `${cascade.issuesToRepoint || 0} issues re-pointed · ${cascade.loserCollectionItemCount || 0} media items folded`}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={() => setMerge(null)} disabled={busy} className="px-3 py-2 rounded border border-port-border text-gray-300 text-sm">Cancel</button>
          <button type="button" onClick={onExecute} disabled={busy || !preview || survivorId === loserId}
            className="inline-flex items-center gap-2 px-3 py-2 rounded bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium disabled:opacity-50">
            {busy ? <Loader2 className="animate-spin" size={14} /> : <GitMerge size={14} />} Merge
          </button>
        </div>
      </div>
    </Modal>
  );
}
