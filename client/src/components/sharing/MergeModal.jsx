/**
 * Merge modal for duplicate Universes / Series. Survivor picker + per-field
 * conflict resolver (survivor / folded / AI-merged) + cascade summary. Driven
 * by the `merge` state object from `useRecordMerge`. The AI path synthesizes
 * a unified value per text conflict that's editable in-place and shipped as
 * `fieldOverrides`; switching back to survivor/folded discards the override.
 */

import { Loader2, GitMerge, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal';
import InlineDiff from '../ui/InlineDiff';
import { MERGE_CHOICE } from '../../hooks/useRecordMerge';

// Conflict values can be strings or structured (arrays/objects). Render strings
// as-is so InlineDiff can word-diff them; pretty-print everything else.
const asText = (v) => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

// Only string-vs-string conflicts can be AI-merged. The server enforces the
// same filter but we use it here too so the per-field "AI" button is only
// shown when it would actually run.
const isStringConflict = (c) => typeof c?.survivorValue === 'string' && typeof c?.loserValue === 'string';

export default function MergeModal({ merge, setMerge, onExecute, onRepreview, onAIMerge, onUpdateOverride }) {
  const { kind, records, survivorId, loserId, preview, choices, overrides = {}, busy, aiBusy } = merge;
  const conflicts = preview?.conflicts || [];
  const cascade = preview?.cascade || {};
  const multi = records.length > 2; // 3+ copies fold one pair at a time
  const aiEligible = conflicts.some(isStringConflict);

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
      <div className="bg-port-card border border-port-border rounded-lg p-5 space-y-4 max-h-[85vh] overflow-y-auto">
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
            <div className="flex items-center justify-between mb-2 gap-2">
              <label className="block text-xs text-gray-400">{conflicts.length} conflicting field(s) — pick which value wins:</label>
              {onAIMerge && aiEligible && (
                <button
                  type="button"
                  onClick={onAIMerge}
                  disabled={aiBusy || busy}
                  title="Use the configured AI provider to synthesize a unified value per text-string field"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-port-accent/60 text-port-accent text-xs font-medium hover:bg-port-accent/10 disabled:opacity-50"
                >
                  {aiBusy ? <Loader2 className="animate-spin" size={12} /> : <Sparkles size={12} />} Merge with AI
                </button>
              )}
            </div>
            <div className="space-y-3">
              {conflicts.map((c) => {
                const choice = choices[c.field];
                const canAI = isStringConflict(c);
                const showOverride = choice === MERGE_CHOICE.AI;
                return (
                  <div key={c.field} className="border border-port-border rounded p-3 bg-port-bg/40">
                    <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                      <span className="text-xs font-medium text-white">{c.field}</span>
                      <div className="flex gap-1 text-[11px]">
                        <button type="button" onClick={() => setChoice(c.field, MERGE_CHOICE.SURVIVOR)} className={`px-2 py-0.5 rounded ${choice === MERGE_CHOICE.SURVIVOR ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400'}`}>Keep survivor</button>
                        <button type="button" onClick={() => setChoice(c.field, MERGE_CHOICE.LOSER)} className={`px-2 py-0.5 rounded ${choice === MERGE_CHOICE.LOSER ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400'}`}>Use folded</button>
                        {canAI && typeof overrides[c.field] === 'string' && (
                          <button type="button" onClick={() => setChoice(c.field, MERGE_CHOICE.AI)} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${choice === MERGE_CHOICE.AI ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400'}`}>
                            <Sparkles size={10} /> AI merged
                          </button>
                        )}
                      </div>
                    </div>
                    {showOverride ? (
                      <textarea
                        value={overrides[c.field] || ''}
                        onChange={(e) => onUpdateOverride?.(c.field, e.target.value)}
                        rows={Math.min(10, Math.max(3, (overrides[c.field] || '').split('\n').length + 1))}
                        className="w-full px-2 py-1.5 rounded bg-port-bg border border-port-border text-sm text-white font-mono leading-snug"
                        aria-label={`AI-merged ${c.field}`}
                      />
                    ) : (
                      <InlineDiff oldText={asText(c.survivorValue)} newText={asText(c.loserValue)} />
                    )}
                  </div>
                );
              })}
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
          <button type="button" onClick={onExecute} disabled={busy || aiBusy || !preview || survivorId === loserId}
            className="inline-flex items-center gap-2 px-3 py-2 rounded bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium disabled:opacity-50">
            {busy ? <Loader2 className="animate-spin" size={14} /> : <GitMerge size={14} />} Merge
          </button>
        </div>
      </div>
    </Modal>
  );
}
