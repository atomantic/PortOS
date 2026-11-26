/**
 * Inspector fields for the layered video timeline editor.
 *
 * Every numeric field declares its bounds ONCE: `NumberField` puts them on the
 * `<input>` and clamps the committed value with the same pair, so an input
 * whose `max` and clamp disagree isn't expressible.
 */

import { memo } from 'react';
import { Music, Trash2 } from 'lucide-react';
import useFieldDraft from '../../hooks/useFieldDraft';
import { clamp } from '../../utils/formatters';
import { assetUrl, clampTrim, fitFadePatch, MAX_FADE_SEC, segmentDuration } from '../../lib/videoTimelineModel';

/**
 * Commit-on-blur numeric input. The draft buffer is what lets the user type
 * "0." — committing per keystroke would round-trip each stroke through the
 * clamp and make that impossible.
 */
export const NumberField = memo(function NumberField({ id, label, value, step = 0.05, min = 0, max, hint, onCommit }) {
  const draft = useFieldDraft(Number.isFinite(value) ? Number(value).toFixed(2) : '', (next) => {
    // An emptied or non-numeric field is a discard, not a commit of zero:
    // useFieldDraft clears its buffer either way, so the input snaps back to
    // the persisted value instead of silently writing the clamped minimum.
    if (String(next).trim() === '') return;
    const n = Number(next);
    if (Number.isFinite(n)) onCommit(clamp(n, min, max ?? Infinity));
  });
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="block text-xs text-gray-400">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft.value}
        onChange={draft.onChange}
        onBlur={draft.onBlur}
        // The hint is described-by rather than nested in the label, or it
        // would be read as part of the field's name on every focus.
        aria-describedby={hintId}
        className="w-full mt-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
      />
      {hint && <span id={hintId} className="block mt-0.5 text-[10px] text-gray-500">{hint}</span>}
    </div>
  );
});

/**
 * The fade pair every lane entry carries, bounded by its own duration AND by
 * the server's absolute fade cap — an entry longer than 30s would otherwise
 * let the user type a fade the save rejects with a 400, leaving the editor
 * unsavable until they guessed the real limit.
 */
export const FadeFields = memo(function FadeFields({ idPrefix, entry, duration, onCommit }) {
  const max = Math.min(Math.max(0, duration), MAX_FADE_SEC);
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberField
        id={`${idPrefix}-fade-in`} label="Fade in (s)" value={entry.fadeInSec ?? 0} max={max}
        onCommit={(n) => onCommit({ fadeInSec: n })}
      />
      <NumberField
        id={`${idPrefix}-fade-out`} label="Fade out (s)" value={entry.fadeOutSec ?? 0} max={max}
        onCommit={(n) => onCommit({ fadeOutSec: n })}
      />
    </div>
  );
});

export const RemoveButton = memo(function RemoveButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-2 py-1.5 bg-port-error/20 hover:bg-port-error/40 text-port-error text-xs rounded flex items-center justify-center gap-1"
    >
      <Trash2 className="w-3 h-3" /> {label}
    </button>
  );
});

// Mirrors MAX_STILL_SEC / MIN_MEDIA_SEC on the server.
const MIN_ENTRY_SEC = 0.05;
const MAX_ENTRY_SEC = 600;
const MAX_VOLUME = 4;

export function VideoTimelineInspector({ selected, lane, clipVolume, metaFor, isSegmentMissing, patchLane, removeFromLane, updateLanes }) {
  const selectedSegment = lane === 'segment' ? selected : null;
  const selectedOverlay = lane === 'overlay' ? selected : null;
  const selectedBed = lane === 'audio' ? selected : null;
  const selectedMeta = selectedSegment?.type === 'clip' ? metaFor(selectedSegment.clipId) : null;
  const selectedSourceDur = selectedMeta?.numFrames && selectedMeta?.fps ? selectedMeta.numFrames / selectedMeta.fps : null;

  // Committing a duration also has to refit the fades that were sized against
  // the old one, so the three lanes share one commit path.
  const commitDuration = (lane, key, seconds) => patchLane(lane, key, (e) => fitFadePatch(e, { durationSec: seconds }, seconds));

  return (
    <div className="order-3 bg-port-card/50 border border-port-border rounded-lg p-3 space-y-3">
      <div className="text-xs uppercase text-gray-500 tracking-wide">Inspector</div>

      {!selected && (
        <div className="text-xs text-gray-500">Select a block on the timeline to edit it.</div>
      )}

      {selectedSegment && isSegmentMissing(selectedSegment) && (
        <div className="text-xs text-port-error space-y-2">
          <p>Source missing — it may have been deleted from the gallery. Remove this block from the timeline.</p>
          <RemoveButton label="Remove" onClick={() => removeFromLane('segment', selectedSegment._key)} />
        </div>
      )}

      {selectedSegment && !isSegmentMissing(selectedSegment) && selectedSegment.type === 'clip' && (
        <>
          {selectedMeta?.thumbnail && (
            <img src={assetUrl('video-thumbnails', selectedMeta.thumbnail)} alt="" className="w-full aspect-video object-cover rounded" />
          )}
          <div className="text-[11px] text-gray-300 line-clamp-3" title={selectedMeta?.prompt}>{selectedMeta?.prompt}</div>
          <div className="text-[10px] text-gray-500">
            source: {selectedSourceDur?.toFixed(2) ?? '?'}s · {selectedMeta?.width}×{selectedMeta?.height} · {selectedMeta?.fps}fps
          </div>
          <NumberField
            id="segment-in" label="In (s)" value={selectedSegment.inSec} max={selectedSourceDur ?? undefined}
            onCommit={(n) => patchLane('segment', selectedSegment._key, (s) => clampTrim(s, { inSec: n }, selectedSourceDur, selectedMeta?.fps))}
          />
          <NumberField
            id="segment-out" label="Out (s)" value={selectedSegment.outSec} max={selectedSourceDur ?? undefined}
            onCommit={(n) => patchLane('segment', selectedSegment._key, (s) => clampTrim(s, { outSec: n }, selectedSourceDur, selectedMeta?.fps))}
          />
          <div className="text-[10px] text-gray-500">
            trimmed: {segmentDuration(selectedSegment).toFixed(2)}s
          </div>
          <FadeFields
            idPrefix="segment"
            entry={selectedSegment}
            duration={segmentDuration(selectedSegment)}
            onCommit={(patch) => patchLane('segment', selectedSegment._key, (s) => fitFadePatch(s, patch, segmentDuration(s)))}
          />
          <NumberField
            id="segment-volume" label="Volume (×)" value={selectedSegment.volume ?? 1} max={MAX_VOLUME}
            onCommit={(n) => patchLane('segment', selectedSegment._key, () => ({ volume: n }))}
          />
          <RemoveButton label="Remove from timeline" onClick={() => removeFromLane('segment', selectedSegment._key)} />
        </>
      )}

      {selectedSegment && !isSegmentMissing(selectedSegment) && selectedSegment.type === 'still' && (
        <>
          <img src={assetUrl(selectedSegment.assetKind, selectedSegment.assetFile)} alt="" className="w-full aspect-video object-cover rounded" />
          <div className="text-[11px] text-gray-300 truncate" title={selectedSegment.assetFile}>{selectedSegment.assetFile}</div>
          <NumberField
            id="still-duration" label="Hold (s)" value={selectedSegment.durationSec} min={MIN_ENTRY_SEC} max={MAX_ENTRY_SEC}
            onCommit={(n) => commitDuration('segment', selectedSegment._key, n)}
          />
          <FadeFields
            idPrefix="still"
            entry={selectedSegment}
            duration={segmentDuration(selectedSegment)}
            onCommit={(patch) => patchLane('segment', selectedSegment._key, (s) => fitFadePatch(s, patch, segmentDuration(s)))}
          />
          <RemoveButton label="Remove from timeline" onClick={() => removeFromLane('segment', selectedSegment._key)} />
        </>
      )}

      {selectedOverlay && (
        <>
          <img src={assetUrl(selectedOverlay.assetKind, selectedOverlay.assetFile)} alt="" className="w-full aspect-video object-contain rounded bg-port-bg" />
          <div className="text-[11px] text-gray-300 truncate" title={selectedOverlay.assetFile}>{selectedOverlay.assetFile}</div>
          <NumberField id="overlay-start" label="Start (s)" value={selectedOverlay.startSec}
            onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ startSec: n }))} />
          <NumberField id="overlay-duration" label="Duration (s)" value={selectedOverlay.durationSec} min={MIN_ENTRY_SEC} max={MAX_ENTRY_SEC}
            onCommit={(n) => commitDuration('overlay', selectedOverlay._key, n)} />
          <div className="grid grid-cols-2 gap-2">
            <NumberField id="overlay-x" label="X (0–1)" value={selectedOverlay.x ?? 0} step={0.01} min={-1} max={2}
              onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ x: n }))} />
            <NumberField id="overlay-y" label="Y (0–1)" value={selectedOverlay.y ?? 0} step={0.01} min={-1} max={2}
              onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ y: n }))} />
          </div>
          <NumberField id="overlay-width" label="Width (× canvas)" value={selectedOverlay.width ?? 0.25} step={0.01} min={0.01} max={4}
            onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ width: n }))} />
          <NumberField id="overlay-opacity" label="Opacity (0–1)" value={selectedOverlay.opacity ?? 1} max={1}
            onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ opacity: n }))} />
          <FadeFields
            idPrefix="overlay"
            entry={selectedOverlay}
            duration={selectedOverlay.durationSec}
            onCommit={(patch) => patchLane('overlay', selectedOverlay._key, (o) => fitFadePatch(o, patch, o.durationSec))}
          />
          <RemoveButton label="Remove overlay" onClick={() => removeFromLane('overlay', selectedOverlay._key)} />
        </>
      )}

      {selectedBed && (
        <>
          <div className="flex items-center gap-2 text-[11px] text-gray-300">
            <Music className="w-3 h-3 text-gray-500" aria-hidden="true" />
            <span className="truncate" title={selectedBed.assetFile}>{selectedBed.assetFile}</span>
          </div>
          <NumberField id="bed-start" label="Start (s)" value={selectedBed.startSec}
            onCommit={(n) => patchLane('audio', selectedBed._key, () => ({ startSec: n }))} />
          <NumberField id="bed-offset" label="Source offset (s)" value={selectedBed.offsetSec ?? 0}
            hint="Where playback starts inside the file"
            onCommit={(n) => patchLane('audio', selectedBed._key, () => ({ offsetSec: n }))} />
          <NumberField id="bed-duration" label="Duration (s)" value={selectedBed.durationSec} min={MIN_ENTRY_SEC} max={MAX_ENTRY_SEC}
            hint="Clamped to the file's real length at render"
            onCommit={(n) => commitDuration('audio', selectedBed._key, n)} />
          <NumberField id="bed-volume" label="Volume (×)" value={selectedBed.volume ?? 1} max={MAX_VOLUME}
            onCommit={(n) => patchLane('audio', selectedBed._key, () => ({ volume: n }))} />
          <FadeFields
            idPrefix="bed"
            entry={selectedBed}
            duration={selectedBed.durationSec}
            onCommit={(patch) => patchLane('audio', selectedBed._key, (tr) => fitFadePatch(tr, patch, tr.durationSec))}
          />
          <RemoveButton label="Remove bed" onClick={() => removeFromLane('audio', selectedBed._key)} />
        </>
      )}

      <div className="pt-2 border-t border-port-border">
        <NumberField
          id="mix-clip-volume"
          label="Clip audio (×)"
          value={clipVolume ?? 1}
          max={MAX_VOLUME}
          hint="Scales every video segment's own audio"
          onCommit={(n) => updateLanes((prev) => ({ ...prev, audio: { ...prev.audio, clipVolume: n } }))}
        />
      </div>
    </div>
  );
}
