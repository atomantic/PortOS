import { useState } from 'react';
import { MUSIC_VIDEO_TRANSITIONS, MUSIC_VIDEO_TRANSITION_LABELS } from '../../lib/musicVideoTransitions.js';
import {
  MUSIC_VIDEO_EDGED_WIPES, MUSIC_VIDEO_WIPE_GROUP_LABELS, MUSIC_VIDEO_WIPE_GROUPS, MUSIC_VIDEO_WIPE_LABELS, MUSIC_VIDEO_WIPE_LENGTHS,
  MUSIC_VIDEO_WIPE_SEC, MUSIC_VIDEO_WIPES,
} from '../../lib/musicVideoWipes.js';

const SIDES = Object.freeze([
  ['in', 'transitionIn', 'wipeIn', 'Effect in', 'An effect over the cut into this shot: a glitch over the cut, or a wipe from the shot before. It adds no time: the cut stays where it is.'],
  ['out', 'transitionOut', 'wipeOut', 'Effect out', 'An effect over the cut to the next shot: a glitch over the cut, or a wipe into the next shot. It adds no time: the cut stays where it is.'],
]);

// How many shots "Vary wipes" covers, counting this one.
const VARY_COUNTS = Object.freeze([4, 8, 16, 32]);
// Hundredths of a second and the frames they cover at 24 fps.
const lengthLabel = (sec) => `${sec.toFixed(2)} s · ${Math.max(1, Math.round(sec * 24))} f`;
const FIELD = 'min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';

/**
 * The effect over the cut into and out of a shot, Off by default: a glitch (a VHS,
 * film or camera look over the cut) or a wipe (the incoming picture taking over
 * the outgoing one), with a wipe's length and a shape wipe's edge color. It rides
 * on the cut in the animatic and the final render alike, and never moves a cut
 * or changes a lock. `onVaryWipes(count)` gives this shot and the next ones a
 * non-repeating run of wipes out.
 */
export default function SceneTransitions({ fieldId, scene, onChange, onVaryWipes = null, isLast = false, disabled = false, defaults = null }) {
  const [varyCount, setVaryCount] = useState(VARY_COUNTS[1]);
  const [varying, setVarying] = useState(false);
  const vary = () => {
    setVarying(true);
    Promise.resolve(onVaryWipes(varyCount)).finally(() => setVarying(false));
  };
  return (
    <div className="space-y-1 text-xs" data-testid="scene-transitions">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {SIDES.map(([side, glitchKey, wipeKey, label, title]) => {
          const wipe = MUSIC_VIDEO_WIPES.includes(scene[wipeKey]?.style) ? scene[wipeKey] : null;
          const explicit = MUSIC_VIDEO_TRANSITIONS.includes(scene[glitchKey]) ? scene[glitchKey] : null;
          // Absent inherits the camera. Null is Off and stays off.
          const inherited = scene[glitchKey] === undefined && !wipe && MUSIC_VIDEO_TRANSITIONS.includes(defaults?.[glitchKey]) ? defaults[glitchKey] : null;
          const value = wipe ? wipe.style : explicit || inherited || '';
          const pick = (style) => {
            // A cut has a glitch or a wipe: choosing one clears the other when it is set.
            if (MUSIC_VIDEO_WIPES.includes(style)) {
              onChange({ [wipeKey]: { style, ...(wipe?.lengthSec ? { lengthSec: wipe.lengthSec } : {}), ...(wipe?.color && MUSIC_VIDEO_EDGED_WIPES.includes(style) ? { color: wipe.color } : {}) },
                ...(scene[glitchKey] ? { [glitchKey]: null } : {}) });
            } else {
              onChange({ [glitchKey]: style || null, ...(scene[wipeKey] ? { [wipeKey]: null } : {}) });
            }
          };
          const length = wipe?.lengthSec ?? MUSIC_VIDEO_WIPE_SEC.default;
          const lengths = MUSIC_VIDEO_WIPE_LENGTHS.includes(length) ? MUSIC_VIDEO_WIPE_LENGTHS : [...MUSIC_VIDEO_WIPE_LENGTHS, length].sort((a, b) => a - b);
          return (
            <span key={side} className="flex min-w-0 flex-wrap items-center gap-1">
              <label htmlFor={fieldId(`glitch-${side}`)} className={value ? 'text-port-accent' : 'text-port-text-muted'}>{label}</label>
              {inherited && <span className="text-port-text-muted">from camera</span>}
              <select id={fieldId(`glitch-${side}`)} value={value} disabled={disabled} title={title} onChange={(e) => pick(e.target.value)} className={FIELD}>
                <option value="">Off</option>
                <optgroup label="Glitches">
                  {MUSIC_VIDEO_TRANSITIONS.map((style) => <option key={style} value={style}>{MUSIC_VIDEO_TRANSITION_LABELS[style]}</option>)}
                </optgroup>
                {Object.entries(MUSIC_VIDEO_WIPE_GROUPS).map(([group, styles]) => (
                  <optgroup key={group} label={MUSIC_VIDEO_WIPE_GROUP_LABELS[group]}>
                    {styles.map((style) => <option key={style} value={style}>{MUSIC_VIDEO_WIPE_LABELS[style]}</option>)}
                  </optgroup>
                ))}
              </select>
              {wipe && (
                <>
                  <label htmlFor={fieldId(`wipe-${side}-length`)} className="sr-only">{label} wipe length</label>
                  <select id={fieldId(`wipe-${side}-length`)} value={length} disabled={disabled} title="How long the wipe runs from the cut. It never runs past the incoming shot."
                    onChange={(e) => onChange({ [wipeKey]: { ...wipe, lengthSec: Number(e.target.value) } })} className={FIELD}>
                    {lengths.map((sec) => <option key={sec} value={sec}>{lengthLabel(sec)}</option>)}
                  </select>
                  {MUSIC_VIDEO_EDGED_WIPES.includes(wipe.style) && (
                    <span className="flex items-center gap-1">
                      <label htmlFor={fieldId(`wipe-${side}-edge`)} className="text-port-text-muted">Edge</label>
                      <input id={fieldId(`wipe-${side}-edge`)} type="color" value={wipe.color || '#ffffff'} disabled={disabled}
                        title="A band of this color around the growing shape"
                        onChange={(e) => onChange({ [wipeKey]: { ...wipe, color: e.target.value } })}
                        className={`h-8 w-8 rounded border border-port-border bg-port-bg ${wipe.color ? '' : 'opacity-40'}`} />
                      {wipe.color && (
                        <button type="button" disabled={disabled} onClick={() => onChange({ [wipeKey]: { ...wipe, color: null } })}
                          className="min-h-[44px] rounded border border-port-border px-1 text-port-text-muted pointer-fine:sm:min-h-0">No edge</button>
                      )}
                    </span>
                  )}
                </>
              )}
            </span>
          );
        })}
      </div>
      {onVaryWipes && !isLast && (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" onClick={vary} disabled={disabled || varying}
            title="Give this shot and the ones after it a wipe out each, never the same wipe twice in a row. Replaces their glitches out."
            className="min-h-[44px] rounded border border-port-border px-2 text-xs hover:bg-port-border/40 disabled:opacity-50 pointer-fine:sm:min-h-0 sm:py-1">
            {varying ? 'Varying…' : 'Vary wipes'}
          </button>
          <label htmlFor={fieldId('vary-wipes-count')} className="text-port-text-muted">over</label>
          <select id={fieldId('vary-wipes-count')} value={varyCount} disabled={disabled || varying} onChange={(e) => setVaryCount(Number(e.target.value))} className={FIELD}>
            {VARY_COUNTS.map((count) => <option key={count} value={count}>{count} shots</option>)}
            <option value={1000}>every shot to the end</option>
          </select>
        </div>
      )}
    </div>
  );
}
