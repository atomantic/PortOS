/**
 * Merge modal for duplicate Universes / Series. Renders the survivor picker,
 * the per-field conflict resolver (survivor vs. folded value), and the cascade
 * summary, then fires the merge. Driven entirely by the `merge` state object
 * managed by `useRecordMerge` — shared between Sharing → Duplicates
 * (DuplicatesTab) and the inline resolver on the Universes page.
 */

import { Loader2, GitMerge } from 'lucide-react';
import Modal from '../ui/Modal';
import InlineDiff from '../ui/InlineDiff';

// Conflict values can be strings or structured (arrays/objects). Render strings
// as-is so InlineDiff can word-diff them; pretty-print everything else.
const asText = (v) => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

export default function MergeModal({ merge, setMerge, onExecute, onRepreview }) {
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
