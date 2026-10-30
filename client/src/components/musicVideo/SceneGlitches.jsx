import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  MUSIC_VIDEO_GLITCH_LENGTHS, MUSIC_VIDEO_SHOT_GLITCH_LIMIT, MUSIC_VIDEO_TRANSITIONS, MUSIC_VIDEO_TRANSITION_LABELS,
} from '../../lib/musicVideoTransitions.js';
import { normalizePreMusic } from '../../../../server/lib/musicVideoColdOpen.js';

// The time slider moves a frame at a time on the render's 24 fps grid.
const STEP_SEC = 1 / 24;
const LENGTH_LABELS = { 0.125: '⅛ s', 0.25: '¼ s', 0.5: '½ s', 1: '1 s', 2: '2 s' };
const round3 = (n) => Math.round(n * 1000) / 1000;

/** One glitch: its style, when it hits (a slider over the shot) and how long it lasts. */
function GlitchRow({ fieldId, index, glitch, spanSec, onCommit, onRemove, disabled }) {
  // The slider keeps its own value while dragging and saves once it is let go.
  const [atSec, setAtSec] = useState(glitch.atSec);
  useEffect(() => { setAtSec(glitch.atSec); }, [glitch.atSec]);
  const commitTime = () => { if (atSec !== glitch.atSec) onCommit({ atSec: round3(atSec) }); };
  const id = (name) => fieldId(`glitch-${index}-${name}`);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label htmlFor={id('style')} className="sr-only">Effect {index + 1} style</label>
      <select id={id('style')} value={glitch.style} disabled={disabled}
        onChange={(e) => onCommit({ style: e.target.value })}
        className="min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50">
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
        className="bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50">
        <option value="">Short</option>
        {MUSIC_VIDEO_GLITCH_LENGTHS.map((sec) => <option key={sec} value={sec}>{LENGTH_LABELS[sec] || `${sec} s`}</option>)}
      </select>
      <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove effect ${index + 1}`}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted hover:text-port-error sm:min-h-[28px] sm:min-w-[28px] disabled:opacity-50">
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * Glitches at moments inside a shot, none by default. Each rides over the
 * picture in the animatic and the final render alike, adds no time and never
 * changes a lock.
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
  return (
    <div className="space-y-1 text-xs" data-testid="scene-glitches">
      <div className="flex items-center gap-2">
        <span className={glitches.length ? 'text-port-accent' : 'text-port-text-muted'}>Effects</span>
        {glitches.length < MUSIC_VIDEO_SHOT_GLITCH_LIMIT && (
          <button type="button" onClick={add} disabled={disabled}
            className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-port-text-muted hover:text-port-text sm:min-h-[28px] disabled:opacity-50">
            <Plus size={12} aria-hidden="true" /> Add effect
          </button>
        )}
      </div>
      {glitches.length > 0 && (
        <ul className="space-y-1">
          {glitches.map((glitch, index) => (
            <GlitchRow key={index} fieldId={fieldId} index={index} glitch={glitch} spanSec={spanSec} disabled={disabled}
              onCommit={(patch) => save(glitches.map((g, i) => (i === index ? { ...g, ...patch } : g)))}
              onRemove={() => save(glitches.filter((_, i) => i !== index))} />
          ))}
        </ul>
      )}
    </div>
  );
}
