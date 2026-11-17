import { Trash2, Drama } from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../../lib/bibleLimits';
import { CHARACTER_ARC_TYPES, CHARACTER_SLIDER_AXES } from '../../../lib/characterFramework';
import BoxedSection from './BoxedSection';

// Declared arc type + Three Sliders (CWQE Phase 10, #2175). Arc type is a plain
// enum <select> ('' clears); each slider is an integer 1–10 range input with an
// explicit "unset" state (null) so an un-rated axis stays absent rather than
// snapping to a default. Patches commit immediately (no draft buffer needed —
// these are discrete controls, not free text). `idPrefix` scopes the field ids
// so two open cards don't collide.
export default function ArcFrameworkControls({ entry, onPatch, disabled, idPrefix }) {
  const sliders = (entry.sliders && typeof entry.sliders === 'object') ? entry.sliders : {};
  const arcId = `chr-arc-${idPrefix || 'unknown'}`;
  const patchSlider = (axis, value) => onPatch?.({ sliders: { ...sliders, [axis]: value } });
  const setCount = CHARACTER_SLIDER_AXES.reduce((n, a) => n + (typeof entry[a] === 'string' ? 0 : (sliders[a] != null ? 1 : 0)), 0);
  const summary = `${entry.arcType || 'no arc'}${setCount ? ` · ${setCount}/3 sliders` : ''}`;
  return (
    <BoxedSection icon={Drama} label="Arc type & sliders" summary={summary}>
      <div className="space-y-0.5">
        <label htmlFor={arcId} className="block text-[10px] uppercase tracking-wider text-gray-500">
          Arc type
        </label>
        <select
          id={arcId}
          value={entry.arcType || ''}
          onChange={(e) => onPatch?.({ arcType: e.target.value })}
          disabled={disabled}
          className="w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
        >
          <option value="">— unset —</option>
          {CHARACTER_ARC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <p className="text-[10px] text-gray-500 leading-snug">
        Rule: HIGH (≥7) on at least two sliders, or high on one with room to grow. All-low = boring; all-high = Mary Sue.
      </p>
      {CHARACTER_SLIDER_AXES.map((axis) => {
        const id = `chr-slider-${idPrefix || 'unknown'}-${axis}`;
        const val = sliders[axis];
        const set = val != null;
        return (
          <div key={axis} className="space-y-0.5">
            <div className="flex items-center justify-between">
              <label htmlFor={id} className="text-[10px] uppercase tracking-wider text-gray-500 capitalize">
                {axis}
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-gray-400 tabular-nums w-6 text-right">{set ? val : '—'}</span>
                {set ? (
                  <button
                    type="button"
                    onClick={() => patchSlider(axis, null)}
                    disabled={disabled}
                    title={`Clear ${axis}`} aria-label={`Clear ${axis}`}
                    className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-port-error disabled:opacity-30"
                  >
                    <Trash2 size={11} />
                  </button>
                ) : null}
              </div>
            </div>
            <input
              id={id}
              type="range"
              min={L.SLIDER_MIN}
              max={L.SLIDER_MAX}
              step={1}
              value={set ? val : L.SLIDER_MIN}
              onChange={(e) => patchSlider(axis, Number(e.target.value))}
              disabled={disabled}
              className="w-full disabled:opacity-50"
              aria-label={`${axis} rating 1 to 10`}
            />
          </div>
        );
      })}
    </BoxedSection>
  );
}
