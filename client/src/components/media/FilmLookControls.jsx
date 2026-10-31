import { useId, useState } from 'react';
import { Copy, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  FILM_LOOK_CONTROLS, FILM_LOOK_GROUPS, FILM_LOOK_PRESETS, describeFilmLook, filmLookPreset, isFilmLookNeutral, normalizeFilmLook, sameFilmLook, scaleFilmLook,
} from '../../lib/filmLook.js';
import { copyToClipboard } from '../../lib/clipboard';

const groupControls = (groupId) => FILM_LOOK_CONTROLS.filter((control) => control.group === groupId);
// Modifiers and tints ride under the effect they shape: they show once that effect is on.
const dependsOn = {
  halationColor: 'halation', halationSpread: 'halation', castColor: 'cast', shadowColor: 'splitTone', highlightColor: 'splitTone',
  grainSize: 'grain', grainColor: 'grain', leakColor: 'leak', weaveRate: 'weave', flickerRate: 'flicker',
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

const chipCls = (on) => `min-h-[44px] rounded-full border px-3 py-1 sm:min-h-0 ${on ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-port-border bg-port-bg text-port-text-muted hover:text-port-text'}`;

// The install's saved looks: tap one to apply it, save the current look under a
// name, or delete the saved look the controls currently match.
function SavedLooks({ look, saved, matched, onApply }) {
  const nameId = useId();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const submit = (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    saved.save(name, look);
    setNaming(false);
    setName('');
  };
  if (!saved.loaded) return null;
  return (
    <div className="space-y-1.5">
      {saved.presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your saved looks">
          {saved.presets.map((preset) => (
            <button key={preset.id} type="button" onClick={() => { setConfirming(false); onApply(preset.look); }} aria-pressed={matched?.id === preset.id}
              className={chipCls(matched?.id === preset.id)}>{preset.label}</button>
          ))}
        </div>
      )}
      {naming ? (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <label htmlFor={nameId} className="text-port-text-muted">Name</label>
          <input id={nameId} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoFocus
            className="min-h-[44px] min-w-0 flex-1 rounded border border-port-border bg-port-bg px-2 sm:min-h-0 sm:py-1" />
          <button type="submit" disabled={!name.trim()} className="min-h-[44px] rounded bg-port-accent px-3 text-port-bg disabled:opacity-50 sm:min-h-0 sm:py-1">Save</button>
          <button type="button" onClick={() => setNaming(false)} className="min-h-[44px] px-2 sm:min-h-0">Cancel</button>
        </form>
      ) : matched ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>Delete &ldquo;{matched.label}&rdquo;?</span>
            <button type="button" onClick={() => { saved.remove(matched.id); setConfirming(false); }} className="min-h-[44px] px-2 text-port-error sm:min-h-0">Delete</button>
            <button type="button" onClick={() => setConfirming(false)} className="min-h-[44px] px-2 sm:min-h-0">Keep</button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className="inline-flex min-h-[44px] items-center gap-1 px-1 text-port-text-muted hover:text-port-text sm:min-h-0">
            <Trash2 size={12} aria-hidden="true" /> Delete saved look
          </button>
        )
      ) : !isFilmLookNeutral(look) && (
        <button type="button" onClick={() => { setName(''); setNaming(true); }} className="inline-flex min-h-[44px] items-center gap-1 px-1 text-port-accent sm:min-h-0">
          <Save size={12} aria-hidden="true" /> Save as preset
        </button>
      )}
    </div>
  );
}

/**
 * The film look's controls: preset chips, then every slider, color and toggle
 * grouped the way a colorist thinks (focus & glow, color, texture, frame, continuous motion).
 * Each row names the effect in photography terms, and the "In a prompt" box
 * rewrites the current settings as the words that ask an image or video model
 * for the same qualities, so tuning a look also teaches the vocabulary.
 *
 * `onChange(look)` fires on every slider move (for a live preview);
 * `onCommit(look)` fires when a control is released (to save). Both receive the
 * whole normalized look. Controlled: `look` is the current value (null = clean).
 * `saved` (from `useFilmLookPresets`) adds the install's saved looks and the
 * Save as preset action.
 */
export default function FilmLookControls({ look: given, onChange, onCommit, compact = false, saved = null }) {
  const look = normalizeFilmLook(given) || filmLookPreset('none');
  const base = useId();
  // Strength scales the look as it stood after the last preset pick or control
  // edit (its anchor), so dragging it back to 100% restores that look exactly.
  const [anchor, setAnchor] = useState(() => ({ look, amount: 1 }));
  const anchored = sameFilmLook(scaleFilmLook(anchor.look, anchor.amount), look) ? anchor : { look, amount: 1 };
  const [openGroups, setOpenGroups] = useState(() => new Set(compact ? [] : FILM_LOOK_GROUPS.map((group) => group.id)));
  const set = (patch, { commit = true } = {}) => {
    const next = normalizeFilmLook({ ...look, ...patch, preset: 'custom' });
    setAnchor({ look: next, amount: 1 });
    onChange?.(next);
    if (commit) onCommit?.(next);
  };
  const live = (patch) => set(patch, { commit: false });
  const commit = () => onCommit?.(look);
  const applyLook = (next) => { setAnchor({ look: next, amount: 1 }); onChange?.(next); onCommit?.(next); };
  const strengthId = `${base}-strength`;
  const setStrength = (amount) => {
    const next = amount === 1 ? anchored.look : { ...scaleFilmLook(anchored.look, amount), preset: 'custom' };
    setAnchor({ look: anchored.look, amount });
    onChange?.(next);
  };
  const applyPreset = (id) => applyLook(filmLookPreset(id));
  const matched = saved?.presets.find((preset) => sameFilmLook(preset.look, look)) || null;
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
              className={chipCls(look.preset === preset.id)}>
              {preset.label}
            </button>
          ))}
        </div>
        {look.preset !== 'none' && !matched && <p className="mt-1 text-port-text-muted">{FILM_LOOK_PRESETS.find((preset) => preset.id === look.preset)?.summary || 'A custom look.'}</p>}
      </div>
      {!isFilmLookNeutral(anchored.look) && (
        <div className="space-y-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={strengthId} className="text-port-text">Strength <span className="ml-1.5 text-port-text-muted">the whole look, lighter</span></label>
            <span className="tabular-nums text-port-text-muted">{Math.round(anchored.amount * 100)}%</span>
          </div>
          <input id={strengthId} type="range" min={0} max={1} step={0.05} value={anchored.amount}
            onChange={(event) => setStrength(Number(event.target.value))}
            onPointerUp={commit} onKeyUp={commit} onBlur={commit}
            className="block h-6 w-full accent-port-accent" />
        </div>
      )}
      {saved && <SavedLooks look={look} saved={saved} matched={matched} onApply={(value) => applyLook(normalizeFilmLook({ ...value, preset: 'custom' }))} />}

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
            {open && group.hint && <p className="px-2 pb-1 text-port-text-muted">{group.hint}</p>}
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
