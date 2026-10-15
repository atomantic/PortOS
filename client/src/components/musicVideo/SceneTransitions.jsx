import { MUSIC_VIDEO_TRANSITIONS, MUSIC_VIDEO_TRANSITION_LABELS } from '../../lib/musicVideoTransitions.js';

const SIDES = Object.freeze([
  ['transitionIn', 'Effect in', 'in', 'A glitch, film or camera effect over the cut into this shot. It adds no time: the cut stays where it is.'],
  ['transitionOut', 'Effect out', 'out', 'A glitch, film or camera effect over the cut to the next shot. It adds no time: the cut stays where it is.'],
]);

/**
 * The effect over the cut into and out of a shot (a VHS glitch, a film or camera look), Off by default. It rides
 * on the cut in the animatic and the final render alike, and never moves a cut
 * or changes a lock.
 */
export default function SceneTransitions({ fieldId, scene, onChange, disabled = false }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="scene-transitions">
      {SIDES.map(([key, label, idSuffix, title]) => {
        const value = MUSIC_VIDEO_TRANSITIONS.includes(scene[key]) ? scene[key] : '';
        return (
          <span key={key} className="flex min-w-0 items-center gap-1">
            <label htmlFor={fieldId(`glitch-${idSuffix}`)} className={value ? 'text-port-accent' : 'text-port-text-muted'}>{label}</label>
            <select id={fieldId(`glitch-${idSuffix}`)} value={value} disabled={disabled} title={title}
              onChange={(e) => onChange({ [key]: e.target.value || null })}
              className="min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50">
              <option value="">Off</option>
              {MUSIC_VIDEO_TRANSITIONS.map((style) => <option key={style} value={style}>{MUSIC_VIDEO_TRANSITION_LABELS[style]}</option>)}
            </select>
          </span>
        );
      })}
    </div>
  );
}
