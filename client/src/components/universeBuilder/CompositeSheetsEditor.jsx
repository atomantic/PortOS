import { useState } from 'react';
import { Plus, Play, Lock, Unlock, Edit3, X } from 'lucide-react';
import { COMPOSITE_PROMPT_MAX } from '../../services/api';
import { COMPOSITE_BOARD_KINDS, compositeKindLabel } from '../../lib/universeBuilderShared';

// Composite-boards editor for the Universe Builder Composites tab. Add / edit /
// remove reference sheets + world-pitch posters, with per-board + bulk lock
// toggles (locked boards survive AI Expand). Extracted from UniverseBuilder.jsx
// (#2374). Pure presentational — `onChange(nextSheets)` owns persistence.
export default function CompositeSheetsEditor({ sheets, onChange, canRender = false, onRender = null }) {
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState('reference_sheet');
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [editIdx, setEditIdx] = useState(null);
  const [editKind, setEditKind] = useState('reference_sheet');
  const [editLabel, setEditLabel] = useState('');
  const [editPrompt, setEditPrompt] = useState('');

  const addSheet = () => {
    const label = newLabel.trim();
    const prompt = newPrompt.trim();
    if (!label || !prompt) return;
    // Stamp `locked: true` up front so the in-draft row matches the
    // lock-by-default contract before the next save round-trips through
    // sanitizeCompositeSheet — otherwise the bulk-toggle's locked-count
    // gate would treat freshly-added boards as unlocked.
    onChange([...sheets, { kind: newKind, label: label.slice(0, 120), prompt: prompt.slice(0, COMPOSITE_PROMPT_MAX), locked: true }]);
    setNewKind('reference_sheet');
    setNewLabel('');
    setNewPrompt('');
    setAdding(false);
  };

  const removeAt = (idx) => onChange(sheets.filter((_, i) => i !== idx));

  // Sheets default to locked at the sanitizer (locked-by-default contract);
  // persist an unlock as explicit `false` so it survives the next read.
  const toggleLockAt = (idx) => onChange(sheets.map((s, i) => {
    if (i !== idx) return s;
    return { ...s, locked: !s.locked };
  }));

  const startEdit = (idx, sheet) => {
    setEditIdx(idx);
    setEditKind(sheet.kind || 'reference_sheet');
    setEditLabel(sheet.label);
    setEditPrompt(sheet.prompt);
  };

  const saveEdit = () => {
    const label = editLabel.trim();
    const prompt = editPrompt.trim();
    if (!label || !prompt) return;
    const next = [...sheets];
    // Preserve `id`, `locked`, `imageRefs` — see VariationCard.saveEdit for
    // the rationale. The editor only owns kind/label/prompt.
    next[editIdx] = {
      ...next[editIdx],
      kind: editKind,
      label: label.slice(0, 120),
      prompt: prompt.slice(0, COMPOSITE_PROMPT_MAX),
    };
    onChange(next);
    setEditIdx(null);
  };

  const setAllSheetsLocked = (nextLocked) =>
    onChange(sheets.map((s) => (s?.locked === nextLocked ? s : { ...s, locked: nextLocked })));
  const sheetsLockedCount = sheets.filter((s) => s?.locked === true).length;
  const allSheetsLocked = sheets.length > 0 && sheetsLockedCount === sheets.length;

  return (
    <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">
          Composite boards
          <span className="ml-2 text-xs text-gray-500">{sheets.length}</span>
        </h2>
        <div className="flex items-center gap-1">
          {sheets.length > 0 && (
            <button
              onClick={() => setAllSheetsLocked(!allSheetsLocked)}
              title={allSheetsLocked
                ? 'Unlock all composite boards — Expand may overwrite them'
                : 'Lock all composite boards — Expand will preserve them'}
              aria-label={allSheetsLocked ? 'Unlock all composite boards' : 'Lock all composite boards'}
              aria-pressed={allSheetsLocked}
              className={`p-1 rounded ${
                allSheetsLocked
                  ? 'text-port-accent hover:bg-port-accent/20'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {allSheetsLocked ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
          )}
          <button
            onClick={() => setAdding((v) => !v)}
            className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
      {adding && (
        <div className="bg-port-bg border border-port-border rounded p-2 flex flex-col gap-2">
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value)}
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm min-h-[40px]"
          >
            {COMPOSITE_BOARD_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>{kind.label}</option>
            ))}
          </select>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={newKind === 'world_pitch_poster' ? 'World summary concept pitch poster' : 'Gas-Giant Drifters costume sheet'}
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            maxLength={120}
          />
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder={newKind === 'world_pitch_poster'
              ? 'Create a cinematic world summary concept pitch poster with a hero panorama, inset environments, cultures, creatures, visual language, palette, materials, and theme icons...'
              : 'Create a clean illustrated costume reference sheet...'}
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            rows={6}
            maxLength={COMPOSITE_PROMPT_MAX}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={addSheet}
              disabled={!newLabel.trim() || !newPrompt.trim()}
              className="text-xs px-2 py-1 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded min-h-[40px] sm:min-h-0"
            >
              Save
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setNewKind('reference_sheet');
                setNewLabel('');
                setNewPrompt('');
              }}
              className="text-xs px-2 py-1 bg-port-bg hover:bg-port-border text-gray-300 rounded min-h-[40px] sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {sheets.length === 0 ? (
        <p className="text-xs text-gray-500">No composite boards yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-96 overflow-y-auto">
          {sheets.map((sheet, idx) => (
            <li key={`${sheet.label}-${idx}`} className={`bg-port-bg border rounded p-2 text-sm ${sheet.locked ? 'border-port-accent/50' : 'border-port-border'}`}>
              {editIdx === idx ? (
                <div className="flex flex-col gap-1">
                  <select
                    value={editKind}
                    onChange={(e) => setEditKind(e.target.value)}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm min-h-[40px]"
                  >
                    {COMPOSITE_BOARD_KINDS.map((kind) => (
                      <option key={kind.value} value={kind.value}>{kind.label}</option>
                    ))}
                  </select>
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={120}
                  />
                  <textarea
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    rows={8}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={COMPOSITE_PROMPT_MAX}
                  />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="text-xs px-2 py-1 bg-port-accent text-white rounded min-h-[40px] sm:min-h-0">Save</button>
                    <button onClick={() => setEditIdx(null)} className="text-xs px-2 py-1 bg-port-bg text-gray-300 rounded min-h-[40px] sm:min-h-0">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-white font-medium truncate">{sheet.label}</div>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent border border-port-accent/20">
                        {compositeKindLabel(sheet.kind)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 line-clamp-3">{sheet.prompt}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onRender && (
                      <button
                        onClick={() => onRender(sheet)}
                        disabled={!canRender}
                        className="p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
                        title={canRender ? 'Render this board' : 'Save the world and configure a render backend to enable'}
                      >
                        <Play size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => toggleLockAt(idx)}
                      className={`p-1 rounded ${sheet.locked ? 'text-port-accent hover:bg-port-accent/20' : 'text-gray-500 hover:text-gray-300'}`}
                      title={sheet.locked ? 'Locked — AI expand will preserve this board' : 'Lock this board against AI expand'}
                      aria-pressed={!!sheet.locked}
                    >
                      {sheet.locked ? <Lock size={14} /> : <Unlock size={14} />}
                    </button>
                    <button
                      onClick={() => startEdit(idx, sheet)}
                      className="p-1 text-gray-400 hover:text-port-accent rounded"
                      title="Edit"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      onClick={() => removeAt(idx)}
                      className="p-1 text-gray-400 hover:text-port-error rounded"
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
