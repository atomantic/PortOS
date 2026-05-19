/**
 * Shared canon-entity card — one bible entry (character / place / object)
 * with description, render-reference button, optional AI-differentiate button
 * (characters only), and click-to-preview image thumbnails.
 *
 * Used by NounsStage (per-series, pre-Phase B) and UniverseCanonSection
 * (per-universe, embedded in UniverseBuilder).
 *
 * Renders through `EntryCard` so the locked accent, title row, action column,
 * and thumbnail stay in lock-step with the variation card.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, ImagePlus, WandSparkles, Lock, Unlock, Shirt, Plus, Trash2, ChevronDown, ChevronRight, Star, Square, BookOpen } from 'lucide-react';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import useFieldDraft from '../../hooks/useFieldDraft';
import MediaJobThumb from './MediaJobThumb';
import EntryCard from '../universe/EntryCard';
import EntryThumbSlot from '../universe/EntryThumbSlot';
import CharacterDetailEditor from '../universe/CharacterDetailEditor';
import CharacterReferenceSheetPanel from '../universe/CharacterReferenceSheetPanel';
import { BIBLE_LIMITS } from '../../lib/bibleLimits';

// Place metadata enums — kept in lock-step with `PLACE_INT_EXT` and
// `PLACE_TIME_OF_DAY` in `server/lib/storyBible.js`. Mirror is fine: a
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

// Collapsible wrapper for the universe-only character details panel
// (CharacterDetailEditor + CharacterReferenceSheetPanel). Single toggle so the
// card stays terse by default — the user opens it only when filling in
// novelist / graphic-novelist fields or generating a reference sheet.
function CharacterDetailsToggle({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-white"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <BookOpen size={10} />
        Character details {open ? '' : '+ reference sheet'}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

function SourceSeriesChip({ sourceSeriesId, seriesName }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded bg-port-card border border-port-border text-[9px] uppercase tracking-wider text-gray-400"
      title={seriesName
        ? `Introduced by series "${seriesName}" (${sourceSeriesId})`
        : `Introduced by series ${sourceSeriesId}`}
    >
      {seriesName ? `from ${seriesName}` : 'from series'}
    </span>
  );
}

// One wardrobe row — per-field drafts live inside `useFieldDraft` so the
// state belongs to the row instance, not an indexed map in the parent.
// `onCommit('name'|'description', value)` lets the parent decide between
// patching an existing row, promoting a pending row once name is non-empty,
// or skipping a no-op.
function WardrobeRow({ wardrobe, editable, onCommit, onRemove }) {
  const nameDraft = useFieldDraft(wardrobe.name, (v) => onCommit('name', v));
  const descDraft = useFieldDraft(wardrobe.description, (v) => onCommit('description', v));
  if (!editable) {
    return (
      <div className="space-y-1">
        <div className="text-xs text-port-accent font-medium">{wardrobe.name}</div>
        {wardrobe.description
          ? <p className="text-[11px] text-gray-400 whitespace-pre-wrap">{wardrobe.description}</p>
          : null}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={nameDraft.value}
          onChange={nameDraft.onChange}
          onBlur={nameDraft.onBlur}
          placeholder="Outfit name (e.g. Wedding)"
          className="flex-1 min-w-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white"
          maxLength={BIBLE_LIMITS.WARDROBE_NAME_MAX}
        />
        <button
          type="button"
          onClick={onRemove}
          title={`Remove ${wardrobe.name || 'this outfit'}`}
          className="shrink-0 text-gray-500 hover:text-port-error"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <textarea
        value={descDraft.value}
        onChange={descDraft.onChange}
        onBlur={descDraft.onBlur}
        placeholder="What's the character wearing? (image-gen-ready prose)"
        rows={2}
        className="w-full px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white"
        maxLength={BIBLE_LIMITS.WARDROBE_DESCRIPTION_MAX}
      />
    </div>
  );
}

// Wardrobes (A2) — collapsed summary by default; click to expand into an
// inline editor when `editable`. Per-field edits are buffered inside each
// `WardrobeRow` via `useFieldDraft`, so a keystroke doesn't fire a
// universe-wide round-trip per character.
function WardrobeSection({ wardrobes, editable, onChange }) {
  const [open, setOpen] = useState(false);
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

  const commit = (idx, field, value) => {
    if (isPending(idx)) {
      const pendingIdx = idx - wardrobes.length;
      const current = pendingNew[pendingIdx] || { name: '', description: '' };
      if ((current[field] || '') === value) return;
      const nextPending = pendingNew.map((p, i) => i === pendingIdx ? { ...p, [field]: value } : p);
      // Promote on name-non-empty. The pending row already carries a
      // server-shaped `wd-<uuid>` id (minted client-side in `addOne`) so
      // it persists verbatim — and crucially, the React key stays stable
      // across promotion so the `WardrobeRow` instance doesn't unmount
      // and lose any uncommitted description draft buffered inside its
      // `useFieldDraft` hook.
      if (field === 'name' && value.trim()) {
        setPendingNew(nextPending.filter((_, i) => i !== pendingIdx));
        onChange([...wardrobes, nextPending[pendingIdx]]);
      } else {
        setPendingNew(nextPending);
      }
      return;
    }
    if ((wardrobes[idx]?.[field] || '') === value) return;
    onChange(wardrobes.map((w, i) => (i === idx ? { ...w, [field]: value } : w)));
  };

  const removeAt = (idx) => {
    if (isPending(idx)) {
      const pendingIdx = idx - wardrobes.length;
      setPendingNew(pendingNew.filter((_, i) => i !== pendingIdx));
      return;
    }
    onChange(wardrobes.filter((_, i) => i !== idx));
  };

  const addOne = () => {
    setOpen(true);
    // Mint a server-shaped `wd-<uuid>` client-side so the React key stays
    // stable across the pending → persisted promotion. Server `ensureId`
    // preserves any non-empty string, so this id round-trips unchanged.
    // `globalThis.crypto` — bare `crypto?.…` ReferenceErrors when the
     // identifier is undeclared (e.g. some non-secure contexts); going
     // through `globalThis` short-circuits cleanly to the Date+Math fallback.
    const id = `wd-${(globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2))}`;
    setPendingNew((prev) => [...prev, { id, name: '', description: '' }]);
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
            <WardrobeRow
              key={w.id || i}
              wardrobe={w}
              editable={editable}
              onCommit={(field, value) => commit(i, field, value)}
              onRemove={() => removeAt(i)}
            />
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
  // Optional `{ [seriesId]: name }` lookup so the "from series" chip can
  // render the actual series name. Null/empty falls back to the id-tooltip
  // form for callers that don't have the map handy.
  seriesNameMap = null,
  // Universe-only character extensions. When provided + kind is 'characters',
  // CanonCard reveals an Expand → CharacterDetailEditor section and a
  // Reference Sheet panel. NounsStage (series view) omits this so the
  // per-series cast list stays focused on naming + visual refs.
  // Shape: { universeId, onExpandCharacter, expanding, onSheetCompleted, onSheetDeleted }
  characterExtensions = null,
}) {
  const description = kind.descFor(entry);
  const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];
  const locked = entry.locked === true;
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
  // Lock guards prompt-data rewrites only — `refineUniverseCharacter`
  // returns 409 `UNIVERSE_CANON_LOCKED` on a locked target, and the cast-wide
  // differentiate skips locked entries at apply time. Render paths do NOT
  // consult the lock: rendering a new reference image (or a clean plate for
  // places) doesn't mutate the entry's prompt/description, just appends to
  // `imageRefs[]`. The pipeline view (NounsStage) inherits the same UX —
  // locked entries are still renderable, just not LLM-rewritable.
  const blockedByLock = locked;

  // Visual at-a-glance without scrolling to the footer ref grid. Falls back
  // to the MOST RECENT ref when nothing is pinned so a freshly-rendered entry
  // isn't thumbnail-less just because the user hasn't picked a primary yet,
  // and a re-render lands as the avatar instead of being buried behind older
  // takes. `imageRefs` is chronological (renders append to the end).
  const thumbnailRef = (entry.primaryImageRef && refs.includes(entry.primaryImageRef))
    ? entry.primaryImageRef
    : (refs[refs.length - 1] || null);

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
      // Pass `inFlightJobId` back so the universe-page pending queue can
      // shift exactly this jobId out (vs. dropping every queued job for
      // the row, which would mis-handle batch renders that queue multiple
      // jobs against a single canon entry).
      onJobCompleted?.(entry.id, filename, inFlightJobId);
    } else if (status === 'failed' || status === 'canceled') {
      settledRef.current = inFlightJobId;
      onJobFailed?.(entry.id, error || status, inFlightJobId);
    }
  }, [inFlightJobId, status, filename, error, entry.id, onJobCompleted, onJobFailed]);

  const title = (
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
        <SourceSeriesChip
          sourceSeriesId={entry.sourceSeriesId}
          seriesName={seriesNameMap?.[entry.sourceSeriesId]}
        />
      ) : null}
    </div>
  );

  const body = (
    <>
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
      {kind.key === 'places' && onPatchEntry && !locked ? (
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
      ) : kind.key === 'places' && (entry.intExt || entry.timeOfDay) ? (
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
      {/* Universe-only: extended character detail editor + AI expand action.
          Hidden when the caller didn't pass `characterExtensions` (pipeline
          series view). Locked characters render read-only inputs. */}
      {kind.key === 'characters' && characterExtensions && onPatchEntry ? (
        <CharacterDetailsToggle>
          <CharacterDetailEditor
            entry={entry}
            onPatch={(patch) => onPatchEntry(entry.id, patch)}
            onExpand={characterExtensions.onExpandCharacter ? () => characterExtensions.onExpandCharacter(entry.id) : null}
            expanding={!!characterExtensions.expanding}
            disabled={locked}
          />
          <CharacterReferenceSheetPanel
            universeId={characterExtensions.universeId}
            entry={entry}
            locked={locked}
            onSheetCompleted={characterExtensions.onSheetCompleted}
            onSheetDeleted={characterExtensions.onSheetDeleted}
            onOpenLightbox={(filename) => onPreview?.(filename, { isSheet: true })}
          />
        </CharacterDetailsToggle>
      ) : null}
    </>
  );

  // Icon-only action strip — same visual contract as the variation cards
  // (`VariationCard` in `pages/UniverseBuilder.jsx`): `p-1` icon button per
  // action, horizontal row, 14px icons, accent hover for primary actions,
  // accent-on-locked styling for the lock toggle. Keeps the canon section
  // visually consistent with the bucket cards above it.
  const actions = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onRender}
        disabled={!description.trim() || !!inFlightJobId}
        className="p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
        title={description.trim()
          ? `Render a canonical reference image for ${entry.name}`
          : 'Add a description first'}
        aria-label={`Render reference for ${entry.name}`}
      >
        {inFlightJobId ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
      </button>
      {kind.key === 'places' && onRenderCleanPlate ? (
        <button
          type="button"
          onClick={() => onRenderCleanPlate(entry)}
          disabled={!description.trim() || !!inFlightJobId}
          className="p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
          title={description.trim()
            ? `Render an empty-location plate for ${entry.name} — no people, edge-to-edge`
            : 'Add a description first'}
          aria-label={`Render clean plate for ${entry.name}`}
        >
          {inFlightJobId ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
        </button>
      ) : null}
      {kind.key === 'characters' && onRefine ? (
        <button
          type="button"
          onClick={() => onRefine(entry.id)}
          disabled={refining || refineDisabled || blockedByLock}
          className="p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
          title={blockedByLock
            ? `Unlock ${entry.name} to refine`
            : `AI: rewrite ${entry.name}'s description so they render distinct from every other character`}
          aria-label={`AI differentiate ${entry.name}`}
        >
          {refining ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} />}
        </button>
      ) : null}
      {onToggleLock ? (
        <button
          type="button"
          onClick={() => onToggleLock(entry.id, !locked)}
          disabled={togglingLock}
          className={`p-1 rounded ${locked ? 'text-port-accent hover:bg-port-accent/20' : 'text-gray-500 hover:text-gray-300'}`}
          title={locked
            ? `Unlock ${entry.name} so refine / differentiate / re-extract can modify it`
            : `Lock ${entry.name} so AI passes don't rewrite it`}
          aria-pressed={locked}
        >
          {togglingLock ? <Loader2 size={14} className="animate-spin" /> : (locked ? <Lock size={14} /> : <Unlock size={14} />)}
        </button>
      ) : null}
    </div>
  );

  const footer = (
    <>
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
    </>
  );

  // Three-state thumbnail slot (pending / empty / completed). Empty state
  // shows a placeholder box with a Render button that fires the same handler
  // as the actions-column Image button — surfaces a one-click affordance for
  // canon entries that haven't been visualized yet. Pending shows the live
  // diffusion spinner from MediaJobThumb (also mirrored in the footer's
  // ref-grid for live-progress detail).
  // Lock no longer gates rendering — see the `blockedByLock` comment above.
  // Render still requires a description (the prompt source) + an actual
  // handler from the parent. Pending state is checked inside EntryThumbSlot.
  const canRender = !!onRender && !!description.trim();
  const thumbnail = (
    <EntryThumbSlot
      inFlightJobId={inFlightJobId || null}
      imageRefs={refs}
      primaryImageRef={entry.primaryImageRef || null}
      alt={`${entry.name} reference`}
      onPreview={onPreview ? (visibleFilename) => onPreview(visibleFilename || thumbnailRef) : null}
      onRender={onRender}
      canRender={canRender}
    />
  );

  return (
    <EntryCard
      locked={locked}
      thumbnail={thumbnail}
      title={title}
      body={body}
      actions={actions}
      footer={footer}
    />
  );
}
