import { useId, useState } from 'react';
import { Copy, RotateCcw } from 'lucide-react';
import {
  FILM_LOOK_CONTROLS, FILM_LOOK_GROUPS, FILM_LOOK_PRESETS, describeFilmLook, filmLookPreset, normalizeFilmLook,
} from '../../lib/filmLook.js';
import { copyToClipboard } from '../../lib/clipboard';

const groupControls = (groupId) => FILM_LOOK_CONTROLS.filter((control) => control.group === groupId);
// Modifiers and tints ride under the effect they shape: they show once that effect is on.
const dependsOn = {
  halationColor: 'halation', castColor: 'cast', shadowColor: 'splitTone', highlightColor: 'splitTone',
  grainSize: 'grain', grainColor: 'grain', leakColor: 'leak',
};
const shown = (control, look) => !dependsOn[control.id] || Math.abs(look[dependsOn[control.id]]) > 0;
const percent = (control, value) => (control.min < 0 ? `${value > 0 ? '+' : ''}${Math.round(value * 100)}` : `${Math.round(value * 100)}%`);

function Slider({ control, value, onChange, onCommit, id }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <label htmlFor={id} className="min-w-0 truncate">
          <span className="text-port-text">{control.label}</span>{' '}
          <span className="ml-1.5 text-port-text-muted">{control.term}</span>
        </label>
        <span className="tabular-nums text-port-text-muted">{percent(control, value)}</span>
      </div>
      <input id={id} type="range" min={control.min} max={control.max} step={control.step} value={value} title={control.hint}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}
        className="block h-6 w-full accent-port-accent" />
    </div>
  );
}

/**
 * The film look's controls: preset chips, then every slider, color and toggle
 * grouped the way a colorist thinks (focus & glow, color, texture, frame).
 * Each row names the effect in photography terms, and the "In a prompt" box
 * rewrites the current settings as the words that ask an image or video model
 * for the same qualities, so tuning a look also teaches the vocabulary.
 *
 * `onChange(look)` fires on every slider move (for a live preview);
 * `onCommit(look)` fires when a control is released (to save). Both receive the
 * whole normalized look. Controlled: `look` is the current value (null = clean).
 */
export default function FilmLookControls({ look: given, onChange, onCommit, compact = false }) {
  const look = normalizeFilmLook(given) || filmLookPreset('none');
  const base = useId();
  const [openGroups, setOpenGroups] = useState(() => new Set(compact ? [] : FILM_LOOK_GROUPS.map((group) => group.id)));
  const set = (patch, { commit = true } = {}) => {
    const next = normalizeFilmLook({ ...look, ...patch, preset: 'custom' });
    onChange?.(next);
    if (commit) onCommit?.(next);
  };
  const live = (patch) => set(patch, { commit: false });
  const commit = () => onCommit?.(look);
  const applyPreset = (id) => { const next = filmLookPreset(id); onChange?.(next); onCommit?.(next); };
  const words = describeFilmLook(look);
  const toggleGroup = (id) => setOpenGroups((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div className="space-y-3 text-xs">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-port-text-muted">Presets</span>
          <button type="button" onClick={() => applyPreset('none')} className="inline-flex min-h-[44px] items-center gap-1 px-1 text-port-accent sm:min-h-0" aria-label="Reset to a clean look">
            <RotateCcw size={12} aria-hidden="true" /> Reset
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Film look presets">
          {FILM_LOOK_PRESETS.filter((preset) => preset.id !== 'none').map((preset) => (
            <button key={preset.id} type="button" onClick={() => applyPreset(preset.id)} title={preset.summary} aria-pressed={look.preset === preset.id}
              className={`min-h-[44px] rounded-full border px-3 py-1 sm:min-h-0 ${look.preset === preset.id ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-port-border bg-port-bg text-port-text-muted hover:text-port-text'}`}>
              {preset.label}
            </button>
          ))}
        </div>
        {look.preset !== 'none' && <p className="mt-1 text-port-text-muted">{FILM_LOOK_PRESETS.find((preset) => preset.id === look.preset)?.summary || 'A custom look. Save it to keep it on this project.'}</p>}
      </div>

      {FILM_LOOK_GROUPS.map((group) => {
        const controls = groupControls(group.id).filter((control) => shown(control, look));
        const open = openGroups.has(group.id);
        const active = controls.filter((control) => !control.type && control.id in look && Math.abs(look[control.id]) > 0 && !dependsOn[control.id]).length;
        return (
          <section key={group.id} aria-label={group.label} className="rounded border border-port-border">
            <button type="button" onClick={() => toggleGroup(group.id)} aria-expanded={open}
              className="flex min-h-[44px] w-full items-center justify-between gap-2 px-2 py-1 text-left">
              <span className="font-medium text-port-text">{group.label}</span>
              <span className="text-port-text-muted">{active ? `${active} on` : 'off'} {open ? '▴' : '▾'}</span>
            </button>
            {open && (
              <div className="grid grid-cols-1 gap-x-4 gap-y-2 px-2 pb-2 sm:grid-cols-2">
                {controls.map((control) => {
                  const id = `${base}-${control.id}`;
                  if (control.type === 'color') {
                    return (
                      <div key={control.id} className="flex items-center justify-between gap-2">
                        <label htmlFor={id} className="min-w-0 truncate" title={control.hint}>
                          <span className="text-port-text">{control.label}</span>{' '}
                          <span className="ml-1.5 text-port-text-muted">{control.term}</span>
                        </label>
                        <input id={id} type="color" value={look[control.id]} onChange={(event) => set({ [control.id]: event.target.value })}
                          className="h-8 w-12 shrink-0 rounded border border-port-border bg-port-bg" />
                      </div>
                    );
                  }
                  if (control.type === 'toggle') {
                    return (
                      <label key={control.id} htmlFor={id} title={control.hint} className="flex min-h-[44px] items-center gap-2 sm:min-h-0">
                        <input id={id} type="checkbox" checked={!!look[control.id]} onChange={(event) => set({ [control.id]: event.target.checked })} className="accent-port-accent" />
                        <span className="text-port-text">{control.label}</span>{' '}
                        <span className="text-port-text-muted">{control.term}</span>
                      </label>
                    );
                  }
                  return <Slider key={control.id} id={id} control={control} value={look[control.id]} onChange={(value) => live({ [control.id]: value })} onCommit={commit} />;
                })}
              </div>
            )}
          </section>
        );
      })}

      <div className="rounded border border-port-border bg-port-bg/60 p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-port-text-muted">In a prompt</span>
          {words && (
            <button type="button" onClick={() => copyToClipboard(words, 'Look words copied')} className="inline-flex min-h-[44px] items-center gap-1 px-1 text-port-accent sm:min-h-0" aria-label="Copy the look as prompt words">
              <Copy size={12} aria-hidden="true" /> Copy
            </button>
          )}
        </div>
        <p className="text-port-text" data-testid="film-look-words">{words || 'Move a control and the words an image or video model understands for it appear here.'}</p>
      </div>
    </div>
  );
}
