import { useCallback, useState } from 'react';
import { Plus, Play, Lock, Unlock, Edit3, X } from 'lucide-react';
import { COMPOSITE_PROMPT_MAX } from '../../services/api';
import { COMPOSITE_BOARD_KINDS, compositeKindLabel } from '../../lib/universeBuilderShared';
import EntryCard from '../universe/EntryCard';
import EntryThumbSlot from '../universe/EntryThumbSlot';

// Composite-boards editor for the Universe Builder Composites tab. Add / edit /
// remove reference sheets + world-pitch posters, with per-board + bulk lock
// toggles (locked boards survive AI Expand). Extracted from UniverseBuilder.jsx
// (#2374). Pure presentational — `onChange(nextSheets)` owns persistence.
export default function CompositeSheetsEditor({
  sheets, onChange, canRender = false, onRender = null,
  // Clicking a board's thumbnail opens the page-level MediaPreview lightbox,
  // same as variation / canon rows. Receives the visible filename.
  onPreview = null,
  // Per-row render-pending plumbing, mirroring the variation grid.
  // `pendingByEntryId[sheet.id]` is the in-flight jobId (or undefined).
  // `onJobSettled(sheetId, filename | null, jobId)` fires when that job reaches
  // a terminal state, so the parent can append the new filename to the board's
  // imageRefs[] and clear the pending entry — a failure/cancel yields no
  // filename and settles with `null`, which is the same clear either way.
  // `onJobFailed(sheetId, 'failed' | 'canceled')` fires after it, only on a
  // terminal failure, so the parent can report a failed render without having
  // to tell one apart from a user-initiated cancel.
  pendingByEntryId = {}, onJobSettled = null, onJobFailed = null,
}) {
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
              className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded ${
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
            aria-label="Sheet kind"
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
            aria-label="New board label"
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            maxLength={120}
          />
          <textarea
            aria-label="Sheet prompt"
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
            editIdx === idx ? (
              <EntryCard
                key={`${sheet.label}-${idx}`}
                locked={!!sheet.locked}
                body={(
                  <div className="flex flex-col gap-1">
                    <select
                      aria-label="Sheet kind"
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
                      aria-label="Board label"
                      className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                      maxLength={120}
                    />
                    <textarea
                      aria-label="Sheet prompt"
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
                )}
              />
            ) : (
              <SheetRow
                key={`${sheet.label}-${idx}`}
                sheet={sheet}
                canRender={canRender}
                onRender={onRender ? () => onRender(sheet) : null}
                onPreview={onPreview}
                inFlightJobId={pendingByEntryId?.[sheet.id] || null}
                onJobSettled={onJobSettled}
                onJobFailed={onJobFailed}
                onToggleLock={() => toggleLockAt(idx)}
                onStartEdit={() => startEdit(idx, sheet)}
                onRemove={() => removeAt(idx)}
              />
            )
          ))}
        </ul>
      )}
    </section>
  );
}

// Display row for one composite board. Renders through `EntryCard` for the same
// reason VariationCard and CanonCard do — the locked-accent border and the
// thumbnail / title / body / actions slot layout stay in lock-step across every
// universe surface instead of drifting per editor.
function SheetRow({
  sheet, canRender, onRender, onPreview,
  inFlightJobId, onJobSettled, onJobFailed,
  onToggleLock, onStartEdit, onRemove,
}) {
  const renders = Array.isArray(sheet.imageRefs) ? sheet.imageRefs : [];
  // `onComplete` is EntryThumbSlot's own settle bridge — it fires with the
  // rendered filename, or with `null` on a terminal failure/cancel — so the row
  // needs no second `useMediaJobProgress` subscription against a jobId the slot
  // is already watching. `inFlightJobId` rides in from the closure because the
  // parent shifts exactly that jobId out of the board's pending queue.
  //
  // The identity MUST be stable: MediaJobThumb fires its `onFilename` effect on
  // `[effectiveFilename, onFilename]`, so a fresh arrow per render would settle
  // the same job again on every page re-render (every keystroke in the builder
  // draft) — each one a full listImageGallery() refetch — instead of once when
  // the job lands.
  const handleSettled = useCallback(
    (filename) => onJobSettled?.(sheet.id, filename, inFlightJobId),
    [onJobSettled, sheet.id, inFlightJobId],
  );
  const handleFailed = useCallback(
    (status) => onJobFailed?.(sheet.id, status),
    [onJobFailed, sheet.id],
  );
  // Three-state thumbnail (pending spinner / rendered image / empty placeholder
  // with a one-click render button), matching the variation + canon rows so a
  // rendered board reads the same way its characters / places / objects do.
  const thumbnail = (
    <EntryThumbSlot
      inFlightJobId={inFlightJobId}
      imageRefs={renders}
      alt={`${sheet.label} render`}
      canRender={canRender}
      onRender={onRender}
      onPreview={onPreview}
      onComplete={handleSettled}
      onTerminalStatus={handleFailed}
    />
  );
  const title = (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="min-w-0 text-sm text-white font-medium break-words">{sheet.label}</div>
      <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent border border-port-accent/20">
        {compositeKindLabel(sheet.kind)}
      </span>
    </div>
  );
  const body = <div className="text-xs text-gray-400 line-clamp-3">{sheet.prompt}</div>;
  const actions = (
    <div className="flex items-center gap-2">
      {onRender && (
        <button
          onClick={onRender}
          disabled={!canRender}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
          title={canRender ? 'Render this board' : 'Save the world and configure a render backend to enable'} aria-label={canRender ? 'Render this board' : 'Save the world and configure a render backend to enable'}
        >
          <Play size={14} />
        </button>
      )}
      <button
        onClick={onToggleLock}
        className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded ${sheet.locked ? 'text-port-accent hover:bg-port-accent/20' : 'text-gray-500 hover:text-gray-300'}`}
        title={sheet.locked ? 'Locked — AI expand will preserve this board' : 'Lock this board against AI expand'} aria-label={sheet.locked ? 'Locked — AI expand will preserve this board' : 'Lock this board against AI expand'}
        aria-pressed={!!sheet.locked}
      >
        {sheet.locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button
        onClick={onStartEdit}
        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-accent rounded"
        title="Edit" aria-label="Edit"
      >
        <Edit3 size={14} />
      </button>
      <button
        onClick={onRemove}
        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-error rounded"
        title="Remove" aria-label="Remove"
      >
        <X size={14} />
      </button>
    </div>
  );
  return <EntryCard locked={!!sheet.locked} thumbnail={thumbnail} title={title} body={body} actions={actions} />;
}
