/**
 * SongScoreParts — manage a song's sheet-music harmony variations (Bass, Mid
 * Harmony I/II, High Harmony I/II …) in the editor. Each part is its own staff
 * in the PortOS lead-sheet DSL, rhythm-aligned to the base melody so the parts
 * stack when sung together.
 *
 * Two ways to fill it:
 *   - "Derive with AI" → POST /api/rounds/:id/derive-parts reads the song's SAVED
 *     base melody and returns harmony parts; we merge them into the draft (the
 *     parent owns Save). Because the server reads the *persisted* base score, the
 *     button is gated on the base melody being saved (not the in-memory draft) —
 *     the project's "Run Now actions gate on saved state" rule.
 *   - "Add part" → a blank part seeded from the base melody to hand-edit.
 *
 * Each part has a live <ScoreSheet> preview (with its own reference-tone playback,
 * so you can hear a harmony in isolation) and a textarea for the notation. State
 * is lifted: every edit calls `onChange(nextParts)`; the parent persists on Save.
 */

import { useState } from 'react';
import { Music2, Plus, Trash2, Wand2, Loader2, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import ScoreSheet from './ScoreSheet.jsx';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { deriveRoundParts } from '../../services/api';
import { HARMONY_PARTS, harmonyPartLabel, harmonyPartOrder } from '../../lib/songCraft';
import { scoreHasMusic } from '../../lib/scoreNotation';

// In-session temp id for a part not yet persisted. MUST end in `-new-<n>` so the
// editor's stripTempId (/-new-\d+$/) blanks it on save and the server assigns a
// stable `part-<uuid>` — otherwise a reload could re-mint the same id and collide.
let seq = 0;
const tempPartId = () => `part-new-${seq++}`;

// Roles the user can tag a part with (drives ordering + a sensible default
// label). Only the derivable harmony roles are offered; "melody" is the base.
const ROLE_OPTIONS = HARMONY_PARTS.filter((p) => p.derivable);

export default function SongScoreParts({ songId, baseScore = '', baseDirty = false, scoreParts = [], onChange }) {
  const [deriving, setDeriving] = useState(false);
  const [openId, setOpenId] = useState(null);

  // AI provider/model for the derive run, via the shared hook. `allowDefault`
  // keeps the empty-string "use the active provider's default" sentinel selected
  // until the user picks (the server's optProvider coerces '' → undefined), and
  // `silent` means a failed provider fetch just hides the picker rather than
  // toasting. The choice is transient — it scopes this derive call only, not
  // persisted on the song (unlike the pipeline's SeriesLlmPicker → series.llm).
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });

  const hasBase = scoreHasMusic(baseScore);
  // Derive needs a SAVED base melody — the server reads the persisted score, so a
  // dirty (unsaved) base would derive harmony from stale notes.
  const canDerive = hasBase && !baseDirty && !deriving;

  const update = (id, patch) => onChange(scoreParts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id) => onChange(scoreParts.filter((p) => p.id !== id));

  const addBlank = () => {
    const id = tempPartId();
    // Seed from the base melody so the user transposes rather than starting blank.
    onChange([...scoreParts, { id, label: 'Part', role: '', score: baseScore || '' }]);
    setOpenId(id);
  };

  const derive = async () => {
    setDeriving(true);
    const data = await deriveRoundParts(songId, { providerId: selectedProviderId, model: selectedModel }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not derive harmony parts'); return null; });
    setDeriving(false);
    if (!data?.scoreParts?.length) return;
    // Merge by role: a derived part replaces an existing part of the same role
    // (re-deriving updates in place); roles not present yet are appended. Parts
    // with no role (hand-added/custom) are never clobbered.
    const next = [...scoreParts];
    for (const dp of data.scoreParts) {
      const idx = dp.role ? next.findIndex((p) => p.role && p.role === dp.role) : -1;
      if (idx >= 0) next[idx] = { ...next[idx], label: dp.label || next[idx].label, score: dp.score };
      else next.push({ id: tempPartId(), label: dp.label || harmonyPartLabel(dp.role) || 'Part', role: dp.role || '', score: dp.score });
    }
    // Keep the list ordered low→high register for a predictable stack.
    next.sort((a, b) => harmonyPartOrder(a.role) - harmonyPartOrder(b.role));
    onChange(next);
    const n = data.scoreParts.length;
    toast.success(`Derived ${n} harmony part${n === 1 ? '' : 's'} — review & Save`);
  };

  const labelInput = 'flex-1 min-w-0 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none';
  const selectCls = 'bg-port-bg border border-port-border rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:border-port-accent focus:outline-none';

  return (
    <section>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Music2 size={15} className="text-port-accent" /> Sheet music parts (harmony variations)
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={derive}
            disabled={!canDerive}
            title={!hasBase ? 'Add a base melody first' : baseDirty ? 'Save the base melody first' : 'Derive harmony parts from the base melody'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
          >
            {deriving ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            Derive with AI
          </button>
          <button
            type="button"
            onClick={addBlank}
            disabled={!hasBase}
            title={hasBase ? 'Add a blank part seeded from the melody' : 'Add a base melody first'}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
          >
            <Plus size={14} /> Add part
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-2">
        Bass, mid & high harmonies built from the melody above — each rhythm-aligned so the parts stack when sung together.
        Derive writes a full set with AI (Bass, Mid Harmony I/II, High Harmony I/II); review and <strong>Save</strong> to keep.
      </p>

      {/* AI provider/model for the derive run (defaults to the active provider). */}
      {hasBase && providers.length > 0 && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500 shrink-0">Derive with</span>
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            label="AI provider"
            disabled={deriving}
            modelDisabled={availableModels.length === 0}
            compact
            alwaysShowModel
            emptyProviderOption="Active provider (default)"
            emptyModelOption="Default model"
          />
        </div>
      )}

      {!hasBase && (
        <p className="text-xs text-gray-500">Add a base melody in the Sheet music editor above, then derive or add harmony parts.</p>
      )}
      {hasBase && baseDirty && (
        <p className="flex items-center gap-1.5 text-xs text-port-warning mb-2">
          <AlertTriangle size={12} className="shrink-0" />
          You have unsaved changes to the base melody — Save first so AI derives harmony from the current notes.
        </p>
      )}

      {scoreParts.length > 0 && (
        <div className="space-y-3">
          {scoreParts.map((p) => {
            const open = openId === p.id;
            const partHasMusic = scoreHasMusic(p.score);
            return (
              <div key={p.id} className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : p.id)}
                    className="p-1 text-gray-400 hover:text-white shrink-0"
                    aria-label={open ? 'Collapse part' : 'Edit part notation'}
                    aria-expanded={open}
                  >
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <input
                    type="text"
                    value={p.label}
                    onChange={(e) => update(p.id, { label: e.target.value })}
                    placeholder="Part label (Bass, High Harmony I…)"
                    aria-label="Part label"
                    className={labelInput}
                  />
                  <select
                    value={p.role || ''}
                    onChange={(e) => update(p.id, { role: e.target.value })}
                    aria-label="Part role"
                    className={selectCls}
                  >
                    <option value="">— role —</option>
                    {ROLE_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                  <button type="button" onClick={() => remove(p.id)} className="p-1.5 text-gray-500 hover:text-port-error shrink-0" aria-label="Remove part">
                    <Trash2 size={15} />
                  </button>
                </div>

                {/* Live staff preview with its own reference-tone playback. */}
                {partHasMusic && (
                  <div className="bg-port-bg border border-port-border rounded-lg p-3 mb-2 overflow-x-auto">
                    <ScoreSheet text={p.score} />
                  </div>
                )}

                {open && (
                  <textarea
                    value={p.score}
                    onChange={(e) => update(p.id, { score: e.target.value })}
                    placeholder="Notation for this part (same lead-sheet format as the melody)…"
                    aria-label="Part notation"
                    rows={6}
                    spellCheck={false}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none font-mono leading-relaxed"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
