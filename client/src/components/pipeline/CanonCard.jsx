/**
 * Shared canon-entity card — one bible entry (character / place / object)
 * with description, render-reference button, optional AI-differentiate button
 * (characters only), and click-to-preview image thumbnails.
 *
 * Used by NounsStage (per-series, pre-Phase B) and UniverseCanonSection
 * (per-universe, embedded in UniverseBuilder).
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, ImagePlus, WandSparkles, Lock, Unlock, Shirt, Plus, Trash2, ChevronDown, ChevronRight, Star, Square } from 'lucide-react';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import MediaJobThumb from './MediaJobThumb';

// Setting metadata enums — kept in lock-step with `SETTING_INT_EXT` and
// `SETTING_TIME_OF_DAY` in `server/lib/storyBible.js`. Mirror is fine: a
// drift would surface immediately as a Zod 400 on the next save.
const INT_EXT_OPTIONS = ['INT', 'EXT'];
const TIME_OF_DAY_OPTIONS = ['dawn', 'day', 'dusk', 'night'];

function ChipPicker({ label, value, options, onChange }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}:</span>
      {options.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(active ? null : opt)}
            className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider border ${
              active
                ? 'bg-port-accent/20 border-port-accent text-port-accent'
                : 'border-port-border text-gray-400 hover:text-white hover:border-gray-500'
            }`}
            title={active ? `Clear ${label}` : `Set ${label} to ${opt}`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function ReadonlyChip({ children }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-port-card border border-port-border text-gray-400">
      {children}
    </span>
  );
}

// Wardrobes (A2) — collapsed summary by default; click to expand into an
// inline editor when `editable`. Per-field edits are buffered in a draft
// state and only PATCHed on blur, so a textarea keystroke doesn't fire a
// universe-wide round-trip per character.
function WardrobeSection({ wardrobes, editable, onChange }) {
  const [open, setOpen] = useState(false);
  // Per-field drafts keyed by `${idx}:${field}`. `undefined` means the
  // textarea reflects the persisted value verbatim.
  const [drafts, setDrafts] = useState({});
  // Pending new rows live entirely client-side until the user types a name
  // — committing immediately would PATCH a nameless entry, the server-side
  // sanitizer would drop it, and the row would vanish mid-type.
  const [pendingNew, setPendingNew] = useState([]);

  const merged = pendingNew.length
    ? [...wardrobes, ...pendingNew]
    : wardrobes;

  if (!editable && merged.length === 0) return null;

  const summary = merged.map((w) => w.name).filter(Boolean).join(', ');
  const isPending = (idx) => idx >= wardrobes.length;
  const draftValue = (idx, field, fallback) => {
    const key = `${idx}:${field}`;
    return key in drafts ? drafts[key] : (fallback ?? '');
  };
  const setDraft = (idx, field, value) => {
    setDrafts((prev) => ({ ...prev, [`${idx}:${field}`]: value }));
  };
  const commitField = (idx, field) => {
    const key = `${idx}:${field}`;
    if (!(key in drafts)) return;
    const value = drafts[key];
    setDrafts((prev) => { const next = { ...prev }; delete next[key]; return next; });

    if (isPending(idx)) {
      const pendingIdx = idx - wardrobes.length;
      const current = pendingNew[pendingIdx] || { name: '', description: '' };
      if ((current[field] || '') === value) return;
      const nextPending = pendingNew.map((p, i) => i === pendingIdx ? { ...p, [field]: value } : p);
      // Once a pending row has a non-empty name it's safe to promote into
      // the persisted list (server sanitizer no longer drops it).
      if (field === 'name' && value.trim()) {
        const promoted = nextPending[pendingIdx];
        const remaining = nextPending.filter((_, i) => i !== pendingIdx);
        setPendingNew(remaining);
        onChange([...wardrobes, promoted]);
      } else {
        setPendingNew(nextPending);
      }
      return;
    }

    if ((wardrobes[idx]?.[field] || '') === value) return;
    const nextList = wardrobes.map((w, i) => (i === idx ? { ...w, [field]: value } : w));
    onChange(nextList);
  };
  const removeAt = (idx) => {
    // Selective draft pruning — keep drafts in earlier indices untouched
    // so editing outfit 3 while deleting outfit 1 doesn't lose the
    // outfit-3 keystrokes. Indices past the removed row shift down by 1.
    setDrafts((prev) => {
      const next = {};
      for (const [k, v] of Object.entries(prev)) {
        const sep = k.indexOf(':');
        if (sep < 0) continue;
        const i = Number(k.slice(0, sep));
        const field = k.slice(sep + 1);
        if (i < idx) next[k] = v;
        else if (i > idx) next[`${i - 1}:${field}`] = v;
      }
      return next;
    });
    if (isPending(idx)) {
      const pendingIdx = idx - wardrobes.length;
      setPendingNew(pendingNew.filter((_, i) => i !== pendingIdx));
      return;
    }
    onChange(wardrobes.filter((_, i) => i !== idx));
  };
  const addOne = () => {
    setOpen(true);
    setPendingNew((prev) => [...prev, { name: '', description: '' }]);
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-white"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Shirt size={10} />
        Outfits ({merged.length}){summary && !open ? `: ${summary}` : ''}
      </button>
      {open ? (
        <div className="mt-1.5 pl-3 border-l border-port-border space-y-1.5">
          {merged.map((w, i) => (
            <div key={w.id || i} className="space-y-1">
              {editable ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={draftValue(i, 'name', w.name)}
                    onChange={(e) => setDraft(i, 'name', e.target.value)}
                    onBlur={() => commitField(i, 'name')}
                    placeholder="Outfit name (e.g. Wedding)"
                    className="flex-1 min-w-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white"
                    maxLength={120}
                  />
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    title={`Remove ${w.name || 'this outfit'}`}
                    className="shrink-0 text-gray-500 hover:text-port-error"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ) : (
                <div className="text-xs text-port-accent font-medium">{w.name}</div>
              )}
              {editable ? (
                <textarea
                  value={draftValue(i, 'description', w.description)}
                  onChange={(e) => setDraft(i, 'description', e.target.value)}
                  onBlur={() => commitField(i, 'description')}
                  placeholder="What's the character wearing? (image-gen-ready prose)"
                  rows={2}
                  className="w-full px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white"
                  maxLength={800}
                />
              ) : w.description ? (
                <p className="text-[11px] text-gray-400 whitespace-pre-wrap">{w.description}</p>
              ) : null}
            </div>
          ))}
          {editable ? (
            <button
              type="button"
              onClick={addOne}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500"
            >
              <Plus size={10} /> Add outfit
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function CanonCard({
  kind, entry,
  inFlightJobId,
  onRender, onJobCompleted, onJobFailed, onPreview, onRefine,
  refining = false, refineDisabled = false,
  // Cross-reference usage: `[{ seriesId, seriesName, issueCount, issueIds }, ...]`
  // populated lazily by the Universe Canon page. Null while still loading.
  usage = null,
  // Optional — NounsStage omits this so per-series canon stays
  // unlockable-only at the universe level. Called with `(entryId, nextLocked)`.
  onToggleLock = null,
  togglingLock = false,
  // Optional — when provided + kind is settings, surfaces inline chip pickers
  // for `intExt` / `timeOfDay`. Called with `(entryId, { intExt?, timeOfDay? })`.
  onPatchEntry = null,
  // Optional — settings-only "Render clean plate" affordance. Called with
  // `(entry)` so the parent can build the no-people prompt variant.
  onRenderCleanPlate = null,
}) {
  const description = kind.descFor(entry);
  const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];
  const locked = entry.locked === true;
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
  // Refine + Render guarded against locked entries — locks signal "frozen
  // identity"; both AI rewrite (refine/differentiate) and new visual refs are
  // gated so the user explicitly unlocks before reshaping the entry.
  // Gate on `locked` alone, NOT on `!!onToggleLock` — consumers like
  // NounsStage embed CanonCard without passing a toggle, but the underlying
  // entry's `locked` flag still represents frozen-identity semantics on the
  // server (Refine → 409 `UNIVERSE_CANON_LOCKED`, Render persists a new
  // visual ref through bypass). The unlock UX lives in Universe Builder; the
  // pipeline view just needs to respect it.
  const blockedByLock = locked;

  // settledRef prevents duplicate completion callbacks under React 18
  // StrictMode's mount→cleanup→mount double-fire in dev. MediaJobThumb
  // opens its own subscription for visuals; ours coexists, filtered by
  // jobId.
  const { status, filename, error } = useMediaJobProgress(inFlightJobId);
  const settledRef = useRef(null);
  useEffect(() => {
    if (!inFlightJobId) { settledRef.current = null; return; }
    if (settledRef.current === inFlightJobId) return;
    if (status === 'completed' && filename) {
      settledRef.current = inFlightJobId;
      onJobCompleted?.(entry.id, filename);
    } else if (status === 'failed' || status === 'canceled') {
      settledRef.current = inFlightJobId;
      onJobFailed?.(entry.id, error || status);
    }
  }, [inFlightJobId, status, filename, error, entry.id, onJobCompleted, onJobFailed]);

  return (
    <li className={`rounded border bg-port-bg/60 p-2 ${locked ? 'border-port-accent/40' : 'border-port-border'}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-white font-medium truncate">{entry.name}</span>
            {entry.aliases?.length ? (
              <span className="text-[10px] text-gray-500 truncate">
                aka {entry.aliases.join(', ')}
              </span>
            ) : null}
            {locked ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-port-accent/15 text-port-accent text-[9px] uppercase tracking-wider">
                <Lock size={9} /> Locked
              </span>
            ) : null}
            {entry.sourceSeriesId ? (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded bg-port-card border border-port-border text-[9px] uppercase tracking-wider text-gray-400"
                title={`Introduced by series ${entry.sourceSeriesId}`}
              >
                from series
              </span>
            ) : null}
          </div>
          {tags.length > 0 ? (
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              {tags.map((tag) => (
                <span key={tag} className="px-1.5 py-0.5 rounded-full bg-port-card border border-port-border text-[9px] text-gray-400">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-gray-400 mt-1 line-clamp-3 whitespace-pre-wrap">
            {description || <em className="text-gray-600">No description yet.</em>}
          </p>
          {kind.key === 'settings' && onPatchEntry && !locked ? (
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <ChipPicker
                label="INT/EXT"
                value={entry.intExt}
                options={INT_EXT_OPTIONS}
                onChange={(v) => onPatchEntry(entry.id, { intExt: v })}
              />
              <ChipPicker
                label="Time"
                value={entry.timeOfDay}
                options={TIME_OF_DAY_OPTIONS}
                onChange={(v) => onPatchEntry(entry.id, { timeOfDay: v })}
              />
            </div>
          ) : kind.key === 'settings' && (entry.intExt || entry.timeOfDay) ? (
            <div className="flex flex-wrap items-center gap-1 mt-2">
              {entry.intExt ? <ReadonlyChip>{entry.intExt}</ReadonlyChip> : null}
              {entry.timeOfDay ? <ReadonlyChip>{entry.timeOfDay}</ReadonlyChip> : null}
            </div>
          ) : null}
          {kind.key === 'characters' ? (
            <WardrobeSection
              wardrobes={Array.isArray(entry.wardrobes) ? entry.wardrobes : []}
              editable={!!onPatchEntry && !locked}
              onChange={(next) => onPatchEntry?.(entry.id, { wardrobes: next })}
            />
          ) : null}
        </div>
        <div className="shrink-0 flex flex-col gap-1 items-stretch">
          {onToggleLock ? (
            <button
              type="button"
              onClick={() => onToggleLock(entry.id, !locked)}
              disabled={togglingLock}
              className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
              title={locked
                ? `Unlock ${entry.name} so refine / differentiate / re-extract can modify it`
                : `Lock ${entry.name} so AI passes don't rewrite it`}
            >
              {togglingLock ? <Loader2 size={10} className="animate-spin" /> : (locked ? <Unlock size={10} /> : <Lock size={10} />)}
              {locked ? 'Unlock' : 'Lock'}
            </button>
          ) : null}
          {kind.key === 'characters' && onRefine ? (
            <button
              type="button"
              onClick={() => onRefine(entry.id)}
              disabled={refining || refineDisabled || blockedByLock}
              className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
              title={blockedByLock
                ? `Unlock ${entry.name} to refine`
                : `Rewrite ${entry.name}'s description so they render distinct from every other character`}
            >
              {refining ? <Loader2 size={10} className="animate-spin" /> : <WandSparkles size={10} />}
              AI: differentiate
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRender}
            disabled={!description.trim() || !!inFlightJobId || blockedByLock}
            className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
            title={blockedByLock
              ? `Unlock ${entry.name} to render a new reference`
              : (description.trim() ? `Render a canonical reference image for ${entry.name}` : 'Add a description first')}
          >
            {inFlightJobId ? <Loader2 size={10} className="animate-spin" /> : <ImagePlus size={10} />}
            Render reference
          </button>
          {kind.key === 'settings' && onRenderCleanPlate ? (
            <button
              type="button"
              onClick={() => onRenderCleanPlate(entry)}
              disabled={!description.trim() || !!inFlightJobId || blockedByLock}
              className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
              title={blockedByLock
                ? `Unlock ${entry.name} to render a clean plate`
                : (description.trim()
                  ? `Render an empty-location plate for ${entry.name} — no people, edge-to-edge`
                  : 'Add a description first')}
            >
              {inFlightJobId ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              Clean plate
            </button>
          ) : null}
        </div>
      </div>
      {(refs.length > 0 || inFlightJobId) ? (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {inFlightJobId ? (
            <MediaJobThumb jobId={inFlightJobId} label={`${entry.name} reference`} size="sm" />
          ) : null}
          {refs.map((ref) => {
            const isPrimary = entry.primaryImageRef === ref;
            const canPin = !!onPatchEntry && !locked;
            return (
              <div key={ref} className="relative w-16 h-16">
                <button
                  type="button"
                  onClick={() => onPreview?.(ref)}
                  title={ref}
                  className={`w-full h-full bg-port-bg rounded overflow-hidden border ${
                    isPrimary ? 'border-port-accent' : 'border-port-border hover:border-port-accent/50'
                  } cursor-zoom-in p-0`}
                >
                  <img
                    src={`/data/images/${ref}`}
                    alt={`${entry.name} reference`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
                {canPin ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPatchEntry(entry.id, { primaryImageRef: isPrimary ? null : ref });
                    }}
                    title={isPrimary
                      ? `Unpin ${ref} as primary reference`
                      : `Pin ${ref} as ${entry.name}'s primary reference`}
                    className={`absolute top-0.5 right-0.5 p-0.5 rounded ${
                      isPrimary
                        ? 'bg-port-accent text-white'
                        : 'bg-port-bg/80 text-gray-400 hover:text-port-accent'
                    }`}
                  >
                    <Star size={10} fill={isPrimary ? 'currentColor' : 'none'} />
                  </button>
                ) : isPrimary ? (
                  <span
                    title="Primary reference image"
                    className="absolute top-0.5 right-0.5 p-0.5 rounded bg-port-accent text-white"
                  >
                    <Star size={10} fill="currentColor" />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {usage && usage.length > 0 ? (
        <div className="mt-2 text-[10px] text-gray-500">
          Appears in:{' '}
          {usage.map((u, i) => (
            <span key={u.seriesId}>
              {i > 0 ? ', ' : ''}
              <span className="text-gray-400">{u.seriesName}</span>
              <span className="text-gray-600"> ({u.issueCount} {u.issueCount === 1 ? 'issue' : 'issues'})</span>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}
