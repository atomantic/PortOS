import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  MUSIC_VIDEO_GLITCH_EDGES, MUSIC_VIDEO_GLITCH_LENGTHS, MUSIC_VIDEO_GLITCH_REPEAT_LIMIT, MUSIC_VIDEO_SHOT_GLITCH_LIMIT, MUSIC_VIDEO_TINTED_GLITCHES,
  MUSIC_VIDEO_TRANSITIONS, MUSIC_VIDEO_TRANSITION_LABELS,
} from '../../lib/musicVideoTransitions.js';
import { normalizePreMusic } from '../../../../server/lib/musicVideoColdOpen.js';

// The time slider moves a frame at a time on the render's 24 fps grid.
const STEP_SEC = 1 / 24;
const LENGTH_LABELS = { 0.125: '⅛ s', 0.25: '¼ s', 0.5: '½ s', 1: '1 s', 2: '2 s' };
const REPEAT_COUNTS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, MUSIC_VIDEO_GLITCH_REPEAT_LIMIT];
const REPEAT_EVERY_SEC = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8];
const EDGE_LABELS = { left: 'Left edge', right: 'Right edge', top: 'Top edge', bottom: 'Bottom edge' };
const DEFAULT_LEAK_COLOR = '#ff4f8a';
const round3 = (n) => Math.round(n * 1000) / 1000;
const selectCls = 'bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';

/** One glitch: its style, when it hits (a slider over the shot), how long and strong it is, and how often it repeats. */
function GlitchRow({ fieldId, index, glitch, spanSec, onCommit, onRemove, disabled }) {
  // The sliders and color keep their own value while dragging and save once let go.
  const [atSec, setAtSec] = useState(glitch.atSec);
  useEffect(() => { setAtSec(glitch.atSec); }, [glitch.atSec]);
  const savedStrength = glitch.strength ?? 1;
  const [strength, setStrength] = useState(savedStrength);
  useEffect(() => { setStrength(savedStrength); }, [savedStrength]);
  const savedColor = glitch.color || DEFAULT_LEAK_COLOR;
  const [color, setColor] = useState(savedColor);
  useEffect(() => { setColor(savedColor); }, [savedColor]);
  const commitTime = () => { if (atSec !== glitch.atSec) onCommit({ atSec: round3(atSec) }); };
  // Full strength is the style as it always played, so it is stored as no strength at all.
  const commitStrength = () => { if (strength !== savedStrength) onCommit({ strength: strength === 1 ? undefined : strength }); };
  const commitColor = () => { if (color !== savedColor) onCommit({ color }); };
  const repeats = glitch.count > 1;
  const tinted = MUSIC_VIDEO_TINTED_GLITCHES.includes(glitch.style);
  const id = (name) => fieldId(`glitch-${index}-${name}`);
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={id('style')} className="sr-only">Effect {index + 1} style</label>
        <select id={id('style')} value={glitch.style} disabled={disabled}
          onChange={(e) => onCommit({ style: e.target.value })}
          className={`min-w-0 ${selectCls}`}>
          {MUSIC_VIDEO_TRANSITIONS.map((style) => <option key={style} value={style}>{MUSIC_VIDEO_TRANSITION_LABELS[style]}</option>)}
        </select>
        <span className="flex min-w-[8rem] flex-1 items-center gap-1">
          <label htmlFor={id('at')} className="shrink-0 tabular-nums text-port-text-muted">at {atSec.toFixed(2)}s</label>
          <input id={id('at')} type="range" min="0" max={spanSec} step={STEP_SEC} value={Math.min(atSec, spanSec)} disabled={disabled}
            onChange={(e) => setAtSec(Number(e.target.value))}
            onPointerUp={commitTime} onKeyUp={commitTime} onBlur={commitTime}
            className="min-w-0 flex-1 accent-port-accent min-h-[44px] sm:min-h-0" />
        </span>
        <label htmlFor={id('length')} className="sr-only">Effect {index + 1} length</label>
        <select id={id('length')} value={glitch.lengthSec ?? ''} disabled={disabled} title="How long the effect lasts"
          onChange={(e) => onCommit({ lengthSec: e.target.value === '' ? null : Number(e.target.value) })}
          className={selectCls}>
          <option value="">Short</option>
          {MUSIC_VIDEO_GLITCH_LENGTHS.map((sec) => <option key={sec} value={sec}>{LENGTH_LABELS[sec] || `${sec} s`}</option>)}
        </select>
        <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove effect ${index + 1}`}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted hover:text-port-error sm:min-h-[28px] sm:min-w-[28px] disabled:opacity-50">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-2">
        <span className="flex min-w-[8rem] flex-1 items-center gap-1">
          <label htmlFor={id('strength')} className="shrink-0 tabular-nums text-port-text-muted">
            <span className="sr-only">Effect {index + 1} </span>strength {Math.round(strength * 100)}%
          </label>
          <input id={id('strength')} type="range" min="0" max="1" step="0.05" value={strength} disabled={disabled}
            title="0 switches the effect off and keeps its settings"
            onChange={(e) => setStrength(Number(e.target.value))}
            onPointerUp={commitStrength} onKeyUp={commitStrength} onBlur={commitStrength}
            className="min-w-0 flex-1 accent-port-accent min-h-[44px] sm:min-h-0" />
        </span>
        <label htmlFor={id('count')} className="sr-only">Effect {index + 1} repeats</label>
        <select id={id('count')} value={repeats ? glitch.count : ''} disabled={disabled} title="Play it again on a steady interval, never past the shot"
          onChange={(e) => onCommit(e.target.value === ''
            ? { count: undefined, everySec: undefined }
            : { count: Number(e.target.value), everySec: glitch.everySec ?? 1 })}
          className={selectCls}>
          <option value="">Once</option>
          {REPEAT_COUNTS.map((n) => <option key={n} value={n}>{n} times</option>)}
        </select>
        {repeats && (
          <>
            <label htmlFor={id('every')} className="sr-only">Effect {index + 1} repeats every</label>
            <select id={id('every')} value={glitch.everySec ?? 1} disabled={disabled}
              onChange={(e) => onCommit({ everySec: Number(e.target.value) })}
              className={selectCls}>
              {REPEAT_EVERY_SEC.map((sec) => <option key={sec} value={sec}>every {sec} s</option>)}
            </select>
          </>
        )}
        {tinted && (
          <>
            <label htmlFor={id('color')} className="sr-only">Effect {index + 1} leak color</label>
            <input id={id('color')} type="color" value={color} disabled={disabled}
              onChange={(e) => setColor(e.target.value)} onBlur={commitColor}
              className="h-8 w-10 shrink-0 rounded border border-port-border bg-port-bg disabled:opacity-50" />
            <label htmlFor={id('edge')} className="sr-only">Effect {index + 1} leak edge</label>
            <select id={id('edge')} value={glitch.edge ?? ''} disabled={disabled} title="Where the stray light washes in from"
              onChange={(e) => onCommit({ edge: e.target.value || undefined })}
              className={selectCls}>
              <option value="">Top-left corner</option>
              {MUSIC_VIDEO_GLITCH_EDGES.map((edge) => <option key={edge} value={edge}>{EDGE_LABELS[edge]}</option>)}
            </select>
          </>
        )}
      </div>
    </li>
  );
}

// A patch's `undefined` values remove their keys, so a default is stored as an absent field.
const withPatch = (glitch, patch) => Object.fromEntries(Object.entries({ ...glitch, ...patch }).filter(([, value]) => value !== undefined));

/**
 * A restrained home-movie starting point: a half-strength gate jump every few
 * seconds through the whole shot and one soft warm leak. No shutter, no flashing.
 */
function homeMovieGlitches(spanSec) {
  const at = round3(Math.min(0.5, spanSec / 4));
  const everySec = 3;
  const count = Math.min(MUSIC_VIDEO_GLITCH_REPEAT_LIMIT, Math.max(1, Math.floor((spanSec - at) / everySec) + 1));
  return [
    { atSec: at, style: 'gate-jump', strength: 0.5, ...(count > 1 ? { count, everySec } : {}) },
    { atSec: round3(Math.round((spanSec * 0.6) / STEP_SEC) * STEP_SEC), style: 'light-leak', strength: 0.6, color: '#ffb36b', edge: 'right' },
  ];
}

/**
 * Timed film events and glitches at moments inside a shot, none by default.
 * Each rides over the picture in the animatic and the final render alike, adds
 * no time and never changes a lock. Continuous weave and flicker live in the
 * film look; these are the moments on top of it.
 */
export default function SceneGlitches({ fieldId, scene, onChange, disabled = false }) {
  const glitches = Array.isArray(scene.glitches) ? scene.glitches : [];
  // A shot before the song spans its own length, not its old place on the song.
  const coldOpen = normalizePreMusic(scene.preMusic);
  const spanSec = coldOpen ? coldOpen.durationSec : Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec
    ? round3(scene.endSec - scene.startSec) : 10;
  const save = (next) => onChange({ glitches: next.length ? next : null });
  // A new glitch lands halfway through the shot, where it is easy to find and move.
  const add = () => save([...glitches, { atSec: round3(Math.round(spanSec / 2 / STEP_SEC) * STEP_SEC), style: 'color-block' }]);
  const recipe = homeMovieGlitches(spanSec);
  const btnCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-port-text-muted hover:text-port-text sm:min-h-[28px] disabled:opacity-50';
  return (
    <div className="space-y-1 text-xs" data-testid="scene-glitches">
      <div className="flex flex-wrap items-center gap-2">
        <span className={glitches.length ? 'text-port-accent' : 'text-port-text-muted'} title="Timed film events; continuous weave and flicker are in the film look">Effects</span>
        {glitches.length < MUSIC_VIDEO_SHOT_GLITCH_LIMIT && (
          <button type="button" onClick={add} disabled={disabled} className={btnCls}>
            <Plus size={12} aria-hidden="true" /> Add effect
          </button>
        )}
        {glitches.length + recipe.length <= MUSIC_VIDEO_SHOT_GLITCH_LIMIT && (
          <button type="button" onClick={() => save([...glitches, ...recipe])} disabled={disabled} className={btnCls}
            title="A gentle gate jump every few seconds and one soft warm leak">
            <Plus size={12} aria-hidden="true" /> Home-movie events
          </button>
        )}
      </div>
      {glitches.length > 0 && (
        <ul className="space-y-2">
          {glitches.map((glitch, index) => (
            <GlitchRow key={index} fieldId={fieldId} index={index} glitch={glitch} spanSec={spanSec} disabled={disabled}
              onCommit={(patch) => save(glitches.map((g, i) => (i === index ? withPatch(g, patch) : g)))}
              onRemove={() => save(glitches.filter((_, i) => i !== index))} />
          ))}
        </ul>
      )}
    </div>
  );
}
