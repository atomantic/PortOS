/**
 * Shared canon-entity card — one bible entry (character / place / object)
 * with description, render-reference button, optional AI-differentiate button
 * (characters only), and click-to-preview image thumbnails.
 *
 * Used by NounsStage (per-series, pre-Phase B) and UniverseCanon (per-
 * universe, Phase A and beyond).
 */

import { useEffect, useRef } from 'react';
import { Loader2, ImagePlus, WandSparkles, Lock, Unlock } from 'lucide-react';
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
}) {
  const description = kind.descFor(entry);
  const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];
  const locked = entry.locked === true;
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
  // Refine + Render guarded against locked entries — the server returns 409
  // on refine; UI surfaces that as a disabled button with an explanatory tip
  // so the user doesn't fire a doomed request.
  const refineBlockedByLock = locked && !!onToggleLock;

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
              disabled={refining || refineDisabled || refineBlockedByLock}
              className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
              title={refineBlockedByLock
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
            disabled={!description.trim() || !!inFlightJobId}
            className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
            title={description.trim() ? `Render a canonical reference image for ${entry.name}` : 'Add a description first'}
          >
            {inFlightJobId ? <Loader2 size={10} className="animate-spin" /> : <ImagePlus size={10} />}
            Render reference
          </button>
        </div>
      </div>
      {(refs.length > 0 || inFlightJobId) ? (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {inFlightJobId ? (
            <MediaJobThumb jobId={inFlightJobId} label={`${entry.name} reference`} size="sm" />
          ) : null}
          {refs.map((ref) => (
            <button
              key={ref}
              type="button"
              onClick={() => onPreview?.(ref)}
              title={ref}
              className="w-16 h-16 bg-port-bg rounded overflow-hidden border border-port-border hover:border-port-accent/50 cursor-zoom-in p-0"
            >
              <img
                src={`/data/images/${ref}`}
                alt={`${entry.name} reference`}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
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
