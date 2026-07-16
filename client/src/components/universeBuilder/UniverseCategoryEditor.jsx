import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpCircle, Edit3, FolderTree, Loader2, Lock, Play, Plus,
  Sparkles, Trash2, Unlock, X,
} from 'lucide-react';
import useClickOutside from '../../hooks/useClickOutside';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import {
  TRUNK_BY_KIND,
  TRUNK_TABS,
  humanizeCategory,
} from '../../lib/universeBuilderShared';
import EntryCard from '../universe/EntryCard';
import EntryThumbSlot from '../universe/EntryThumbSlot';

const GENERATE_PRESETS = [3, 5, 10];
const GENERATE_CUSTOM_MIN = 1;
const GENERATE_CUSTOM_MAX = 50;

export function CategoryEditor({
  category, variations, canRemove = false, onChange, onRemove,
  canRender = false, onRenderCategory = null, onRenderVariation = null,
  onGenerate = null,
  // `bucketKind` drives the promote-button UX: when `'other'` (or absent)
  // the picker opens to choose a trunk; otherwise we promote directly.
  // `canPromote` gates on universe-persisted (the action reads the saved record).
  canPromote = false, bucketKind = null, onPromote = null,
  // Only set by OtherTab — clicking opens a picker that retags the bucket's
  // `kind` to a canon trunk. Variations stay in place; bucket moves tabs.
  onAssignBucketKind = null,
  // Clicking the row's thumbnail opens the page-level MediaPreview lightbox
  // (same modal that the history / gallery uses). Receives the visible
  // filename so the modal lands on the exact ref the user saw, not a stale
  // primary that may have walked-back on a 404.
  onPreviewVariation = null,
  // Per-row render-pending plumbing — `pendingByEntryId[v.id]` returns the
  // in-flight jobId (or undefined). Completion / failure callbacks fire when
  // the row's MediaJobThumb settles.
  pendingByEntryId = {}, onJobCompleted = null, onJobFailed = null,
}) {
  const requiresTargetKind = !TRUNK_BY_KIND[bucketKind];
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [editIdx, setEditIdx] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [genCustom, setGenCustom] = useState('');
  const [generating, setGenerating] = useState(false);
  const [promotingIdx, setPromotingIdx] = useState(null);
  const [pickerIdx, setPickerIdx] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const genWrapRef = useRef(null);
  const pickerWrapRef = useRef(null);
  const assignWrapRef = useRef(null);

  useClickOutside(genWrapRef, genOpen, () => setGenOpen(false));
  useClickOutside(pickerWrapRef, pickerIdx !== null, () => setPickerIdx(null));
  useClickOutside(assignWrapRef, assignOpen, () => setAssignOpen(false));
  useEffect(() => {
    if (!genOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setGenOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [genOpen]);
  useEffect(() => {
    if (pickerIdx === null) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPickerIdx(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pickerIdx]);
  useEffect(() => {
    if (!assignOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setAssignOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [assignOpen]);

  const editorMountedRef = useRef(true);
  useEffect(() => () => { editorMountedRef.current = false; }, []);
  const runPromote = async (idx, variation, opts) => {
    if (!onPromote) return;
    setPickerIdx(null);
    setPromotingIdx(idx);
    try {
      await onPromote(variation, opts);
    } finally {
      if (editorMountedRef.current) setPromotingIdx(null);
    }
  };

  const runGenerate = async (count) => {
    const n = Math.max(GENERATE_CUSTOM_MIN, Math.min(GENERATE_CUSTOM_MAX, parseInt(count, 10) || 0));
    if (!n || !onGenerate) return;
    setGenOpen(false);
    setGenerating(true);
    try {
      await onGenerate(n);
    } finally {
      setGenerating(false);
      setGenCustom('');
    }
  };

  const addVariation = () => {
    const label = newLabel.trim();
    const prompt = newPrompt.trim();
    if (!label || !prompt) return;
    // Stamp `locked: true` so the in-draft row matches the lock-by-default
    // contract before the next save round-trips through sanitizeVariation.
    // Without this, the bulk-toggle counts a freshly-added variation as
    // unlocked even though the user expects every new entry to land locked.
    onChange([...variations, { label: label.slice(0, 120), prompt: prompt.slice(0, 2000), locked: true }]);
    setNewLabel('');
    setNewPrompt('');
    setAdding(false);
  };

  const removeAt = (idx) => onChange(variations.filter((_, i) => i !== idx));

  // Variations default to locked at the sanitizer (locked-by-default contract),
  // so an unlock must persist as explicit `false` — not as an absent key —
  // otherwise the next read would re-lock the entry the user just unlocked.
  const toggleLockAt = (idx) => onChange(variations.map((v, i) => {
    if (i !== idx) return v;
    return { ...v, locked: !v.locked };
  }));

  // Bulk lock/unlock everything in this bucket. Same persistence contract:
  // unlock writes explicit `false` so it survives the round-trip.
  const setAllLocked = (nextLocked) =>
    onChange(variations.map((v) => (v?.locked === nextLocked ? v : { ...v, locked: nextLocked })));
  const lockedCount = variations.filter((v) => v?.locked === true).length;
  const allLocked = variations.length > 0 && lockedCount === variations.length;

  const startEdit = (idx, v) => {
    setEditIdx(idx);
    setEditLabel(v.label);
    setEditPrompt(v.prompt);
  };

  const saveEdit = () => {
    const label = editLabel.trim();
    const prompt = editPrompt.trim();
    // Mirror addVariation()'s validation — server-side sanitize would drop
    // a blank entry on save/reload, so refuse rather than store ghost rows
    // the user can't see why they vanished.
    if (!label || !prompt) return;
    const next = [...variations];
    // Preserve `id`, `locked`, and `imageRefs` — only label + prompt are
    // editable in this row. A naive replacement would re-mint the variation's
    // id (breaking the link to its render history) and drop accrued imageRefs.
    // The server's stale-PATCH guard catches some of this via length + tail
    // comparison (variations with NEW renders in cur survive an empty patch),
    // but a stale variation whose history hasn't grown server-side since the
    // client loaded would still get its imageRefs cleared if we sent an empty
    // array. Echoing cur's array verbatim avoids relying on the guard.
    next[editIdx] = {
      ...next[editIdx],
      label: label.slice(0, 120),
      prompt: prompt.slice(0, 2000),
    };
    onChange(next);
    setEditIdx(null);
  };

  return (
    <div className="bg-port-card border border-port-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white capitalize">
          {humanizeCategory(category)}
          <span className="ml-2 text-xs text-gray-500">{variations.length}</span>
        </h3>
        <div className="flex items-center gap-1">
          {onRenderCategory && (
            <button
              onClick={onRenderCategory}
              disabled={!canRender || variations.length === 0}
              className="p-1 text-port-accent hover:bg-port-accent/20 disabled:opacity-30 disabled:cursor-not-allowed rounded"
              title={variations.length === 0 ? 'Add variations first' : 'Render this category'}
              aria-label="Render this category"
            >
              <Play size={14} />
            </button>
          )}
          {onAssignBucketKind && requiresTargetKind && (
            <div className="relative" ref={assignWrapRef}>
              <button
                onClick={() => setAssignOpen((v) => !v)}
                className="p-1 text-port-accent hover:bg-port-accent/20 rounded"
                title="Move this bucket into a canon trunk (variations stay in place)"
                aria-label="Assign bucket to a canon trunk"
                aria-haspopup="menu"
                aria-expanded={assignOpen}
              >
                <FolderTree size={14} />
              </button>
              {assignOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 z-20 w-44 bg-port-card border border-port-border rounded shadow-lg p-1 flex flex-col gap-0.5"
                >
                  <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500">
                    Move bucket to trunk
                  </div>
                  {TRUNK_TABS.map((trunk) => {
                    const TrunkIcon = trunk.icon;
                    return (
                      <button
                        key={trunk.kind}
                        role="menuitem"
                        onClick={() => { setAssignOpen(false); onAssignBucketKind(trunk.kind); }}
                        className="text-left text-xs px-2 py-1.5 text-gray-200 hover:bg-port-accent/20 rounded flex items-center gap-2"
                      >
                        <TrunkIcon size={12} className="text-port-accent" /> {trunk.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {onGenerate && (
            <div className="relative" ref={genWrapRef}>
              <button
                onClick={() => setGenOpen((v) => !v)}
                disabled={generating}
                className="p-1 text-port-accent hover:bg-port-accent/20 disabled:opacity-30 disabled:cursor-not-allowed rounded"
                title="Ask the LLM for more variations in this category"
                aria-label="Generate more variations"
                aria-haspopup="menu"
                aria-expanded={genOpen}
              >
                {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              </button>
              {genOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 z-20 w-44 bg-port-card border border-port-border rounded shadow-lg p-1 flex flex-col gap-0.5"
                >
                  {GENERATE_PRESETS.map((n) => (
                    <button
                      key={n}
                      role="menuitem"
                      onClick={() => runGenerate(n)}
                      className="text-left text-xs px-2 py-1.5 text-gray-200 hover:bg-port-accent/20 rounded"
                    >
                      Generate {n} more
                    </button>
                  ))}
                  <div className="border-t border-port-border my-1" />
                  <div className="flex items-center gap-1 px-1 pb-1">
                    <input
                      type="number"
                      min={GENERATE_CUSTOM_MIN}
                      max={GENERATE_CUSTOM_MAX}
                      value={genCustom}
                      onChange={(e) => setGenCustom(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') runGenerate(genCustom); }}
                      placeholder="Custom"
                      className="w-16 bg-port-bg border border-port-border rounded px-1.5 py-1 text-white text-xs focus:outline-none focus:border-port-accent"
                    />
                    <button
                      onClick={() => runGenerate(genCustom)}
                      disabled={!Number(genCustom) || Number(genCustom) < GENERATE_CUSTOM_MIN}
                      className="flex-1 text-xs px-2 py-1 bg-port-accent/20 hover:bg-port-accent/30 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded"
                    >
                      Go
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {variations.length > 0 && (
            // Single toggle — mirrors the per-row lock button. Lock icon when
            // every variation is locked (click unlocks all); Unlock icon for
            // the all-unlocked + mixed cases so a click always locks the
            // holdouts.
            <button
              onClick={() => setAllLocked(!allLocked)}
              title={allLocked
                ? 'Unlock all variations — Expand / Generate may overwrite them'
                : 'Lock all variations — Expand / Generate will preserve them'}
              aria-label={allLocked ? 'Unlock all variations' : 'Lock all variations'}
              aria-pressed={allLocked}
              className={`p-1 rounded ${
                allLocked
                  ? 'text-port-accent hover:bg-port-accent/20'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {allLocked ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
          )}
          {canRemove && (
            <button
              onClick={onRemove}
              className="p-1 text-gray-400 hover:text-port-error rounded"
              title="Remove category"
            >
              <Trash2 size={14} />
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
        <div className="bg-port-bg border border-port-border rounded p-2 mb-2 flex flex-col gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. Crystalline canyon basin)"
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            maxLength={120}
          />
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="Prompt fragment (subject only)"
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            rows={2}
            maxLength={2000}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={addVariation}
              disabled={!newLabel.trim() || !newPrompt.trim()}
              className="text-xs px-2 py-1 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded min-h-[40px] sm:min-h-0"
            >
              Save
            </button>
            <button
              onClick={() => { setAdding(false); setNewLabel(''); setNewPrompt(''); }}
              className="text-xs px-2 py-1 bg-port-bg hover:bg-port-border text-gray-300 rounded min-h-[40px] sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {variations.length === 0 ? (
        <p className="text-xs text-gray-500">No variations yet — expand the starter prompt or add one manually.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {variations.map((v, idx) => (
            <VariationCard
              key={`${v.label}-${idx}`}
              variation={v}
              idx={idx}
              editMode={editIdx === idx}
              editLabel={editLabel}
              editPrompt={editPrompt}
              setEditLabel={setEditLabel}
              setEditPrompt={setEditPrompt}
              saveEdit={saveEdit}
              cancelEdit={() => setEditIdx(null)}
              startEdit={() => startEdit(idx, v)}
              toggleLock={() => toggleLockAt(idx)}
              remove={() => removeAt(idx)}
              onPromote={onPromote}
              canPromote={canPromote}
              requiresTargetKind={requiresTargetKind}
              promotingIdx={promotingIdx}
              pickerIdx={pickerIdx}
              setPickerIdx={setPickerIdx}
              pickerWrapRef={pickerWrapRef}
              runPromote={runPromote}
              onRenderVariation={onRenderVariation}
              canRender={canRender}
              onPreviewVariation={onPreviewVariation}
              inFlightJobId={pendingByEntryId[v.id] || null}
              onJobCompleted={onJobCompleted}
              onJobFailed={onJobFailed}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Renders through `EntryCard` so the locked accent + layout stay in
// lock-step with `CanonCard`.
function VariationCard({
  variation: v, idx, editMode,
  editLabel, editPrompt, setEditLabel, setEditPrompt,
  saveEdit, cancelEdit, startEdit, toggleLock, remove,
  onPromote, canPromote, requiresTargetKind, promotingIdx,
  pickerIdx, setPickerIdx, pickerWrapRef, runPromote,
  onRenderVariation, canRender,
  onPreviewVariation = null,
  inFlightJobId = null, onJobCompleted = null, onJobFailed = null,
}) {
  const locked = !!v.locked;
  // Hooks MUST run unconditionally and in stable order — calling them after
  // the editMode early-return below would change the hook count between
  // display ↔ edit toggles and crash React with "Rendered more hooks than
  // during the previous render". Subscribe to the row's in-flight job here
  // so completion / failure callbacks fire back up to the parent (which
  // clears pending state + appends the new filename to the variation's
  // imageRefs[] optimistically). settledRef prevents duplicate fires under
  // React 18 StrictMode's mount → cleanup → mount dev double-fire.
  const { status: jobStatus, filename: jobFilename, error: jobError } = useMediaJobProgress(inFlightJobId);
  const settledRef = useRef(null);
  useEffect(() => {
    if (!inFlightJobId) { settledRef.current = null; return; }
    if (settledRef.current === inFlightJobId) return;
    if (jobStatus === 'completed' && jobFilename) {
      settledRef.current = inFlightJobId;
      // Pass `inFlightJobId` back so the parent can shift exactly this jobId
      // out of its per-entry queue. Without the jobId, `clearPendingForEntry`
      // would drop every queued job for the row — wrong when `batchPerVariation
      // > 1` queues N siblings and only one has just finished.
      onJobCompleted?.(v.id, jobFilename, inFlightJobId);
    } else if (jobStatus === 'failed' || jobStatus === 'canceled') {
      settledRef.current = inFlightJobId;
      onJobFailed?.(v.id, jobError || jobStatus, inFlightJobId);
    }
  }, [inFlightJobId, jobStatus, jobFilename, jobError, v.id, onJobCompleted, onJobFailed]);

  if (editMode) {
    return (
      <EntryCard
        locked={locked}
        body={(
          <div className="flex flex-col gap-1">
            <input
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
              maxLength={120}
            />
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              rows={3}
              className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
              maxLength={2000}
            />
            <div className="flex gap-2">
              <button onClick={saveEdit} className="text-xs px-2 py-1 bg-port-accent text-white rounded min-h-[40px] sm:min-h-0">Save</button>
              <button onClick={cancelEdit} className="text-xs px-2 py-1 bg-port-bg text-gray-300 rounded min-h-[40px] sm:min-h-0">Cancel</button>
            </div>
          </div>
        )}
      />
    );
  }

  const promoteTitle = !canPromote
    ? 'Save the universe first to enable promote'
    : requiresTargetKind
      ? 'Promote to canon — pick a trunk'
      : 'Promote to canon — LLM expands this variation into a full canon entry';

  // Thumbnail slot is three-state (pending / empty / completed) — see
  // `EntryThumbSlot`. Hook subscription that drives this lives above the
  // editMode early-return so the hook order stays stable across toggles.
  const renders = Array.isArray(v.imageRefs) ? v.imageRefs : [];
  const thumbnail = (
    <EntryThumbSlot
      inFlightJobId={inFlightJobId}
      imageRefs={renders}
      alt={`${v.label} render`}
      canRender={!!onRenderVariation && canRender}
      onRender={onRenderVariation ? () => onRenderVariation(v) : null}
      onPreview={onPreviewVariation || null}
    />
  );

  const title = <div className="text-sm text-white font-medium truncate">{v.label}</div>;
  const body = <div className="text-xs text-gray-400 line-clamp-2 mt-1">{v.prompt}</div>;
  const actions = (
    <div className="flex items-center gap-1">
      {onPromote && (
        <div className="relative" ref={pickerIdx === idx ? pickerWrapRef : null}>
          <button
            onClick={() => {
              if (requiresTargetKind) {
                setPickerIdx(pickerIdx === idx ? null : idx);
                return;
              }
              runPromote(idx, v);
            }}
            disabled={!canPromote || promotingIdx !== null}
            className="p-1 text-gray-400 hover:text-port-success disabled:opacity-30 disabled:cursor-not-allowed rounded"
            title={promoteTitle}
            aria-haspopup={requiresTargetKind ? 'menu' : undefined}
            aria-expanded={requiresTargetKind ? pickerIdx === idx : undefined}
          >
            {promotingIdx === idx
              ? <Loader2 size={14} className="animate-spin" />
              : <ArrowUpCircle size={14} />}
          </button>
          {pickerIdx === idx && requiresTargetKind && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 z-20 w-44 bg-port-card border border-port-border rounded shadow-lg p-1 flex flex-col gap-0.5"
            >
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500">
                Promote to canon as…
              </div>
              {TRUNK_TABS.map((trunk) => (
                <button
                  key={trunk.kind}
                  role="menuitem"
                  onClick={() => runPromote(idx, v, { targetKind: trunk.kind })}
                  className="text-left text-xs px-2 py-1.5 text-gray-200 hover:bg-port-success/20 rounded"
                >
                  {trunk.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {onRenderVariation && (
        <button
          onClick={() => onRenderVariation(v)}
          disabled={!canRender}
          className="p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
          title={canRender ? 'Render this variation' : 'Save the world and configure a render backend to enable'}
        >
          <Play size={14} />
        </button>
      )}
      <button
        onClick={toggleLock}
        className={`p-1 rounded ${locked ? 'text-port-accent hover:bg-port-accent/20' : 'text-gray-500 hover:text-gray-300'}`}
        title={locked ? 'Locked — AI expand will preserve this variation' : 'Lock this variation against AI expand'}
        aria-pressed={locked}
      >
        {locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button
        onClick={startEdit}
        className="p-1 text-gray-400 hover:text-port-accent rounded"
        title="Edit"
      >
        <Edit3 size={14} />
      </button>
      <button
        onClick={remove}
        className="p-1 text-gray-400 hover:text-port-error rounded"
        title="Remove"
      >
        <X size={14} />
      </button>
    </div>
  );

  return <EntryCard locked={locked} thumbnail={thumbnail} title={title} body={body} actions={actions} />;
}
