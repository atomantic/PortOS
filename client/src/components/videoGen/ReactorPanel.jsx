/**
 * reactor.inc fast-h3 render controls.
 *
 * Presentational — every value is owned by the VideoGen page. Two of the three
 * fields exist because fast-h3's contract is narrower than a free-text box can
 * express:
 *
 * - **Continue from clip** picks a clip id off a PREVIOUS reactor render (the
 *   id is stamped on its history record) and chains this one onto it with
 *   `continue_from_clip_id`. Typing an id was the old shape, and there was no
 *   way for a user to know one; it is exclusive with a starting image, since
 *   both say "begin from this picture".
 * - **Clip length** offers only lengths fast-h3 renders (see
 *   `lib/reactorVideoClip.js`) — the accepted range neither starts nor ends on
 *   a round number, so a number box mostly offered a way to type a rejected one.
 */
import { REACTOR_CLIP_LENGTHS, reactorClipLengthLabel } from '../../lib/reactorVideoClip.js';
import { FormField } from '../ui/FormField';

export default function ReactorPanel({
  clipId,
  onClipIdChange,
  continuableClips,
  imageModeActive,
  seconds,
  onSecondsChange,
  seed,
  onSeedChange,
}) {
  const fieldClass = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';
  const continuationBlocked = imageModeActive || continuableClips.length === 0;
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField label="Continue from clip" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          value={clipId}
          disabled={continuationBlocked}
          onChange={(e) => onClipIdChange(e.target.value)}
          className={fieldClass}
        >
          <option value="">
            {imageModeActive
              ? 'Not available with a starting image'
              : continuableClips.length === 0
                ? 'No Reactor clips rendered yet'
                : 'Start a fresh shot'}
          </option>
          {continuableClips.map((clip) => (
            <option key={clip.clipId} value={clip.clipId}>{clip.label}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Clip length" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          value={seconds}
          onChange={(e) => onSecondsChange(Number(e.target.value))}
          className={fieldClass}
        >
          {REACTOR_CLIP_LENGTHS.map((length) => (
            <option key={length} value={length}>{reactorClipLengthLabel(length)}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Seed" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <input
          type="number"
          min={0}
          value={seed}
          onChange={(e) => onSeedChange(e.target.value)}
          placeholder="random"
          className={fieldClass}
        />
      </FormField>
      <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
        Renders on reactor.inc&apos;s fast-h3 API — near-realtime, and every finished clip can be
        continued frame-accurately by picking it above. Reactor decides how long it keeps a clip
        continuable, so an older one may come back rejected. Counts against your reactor.inc balance.
      </p>
    </div>
  );
}
