import { useEffect, useState } from 'react';
import { Clapperboard, Plus, RotateCcw, X } from 'lucide-react';
import { getMusicVideoCreditsPrefill } from '../../services/apiMusicVideo.js';
import {
  CREDITS_OUTRO_DEFAULTS, CREDITS_OUTRO_LIMITS, CREDITS_OUTRO_ROLES, normalizeCreditsOutro,
} from '../../../../server/lib/musicVideoCreditsOutro.js';

// Lengths offered for the credits, in seconds (inside CREDITS_OUTRO_LIMITS).
const LENGTHS = [6, 8, 10, 12, 15, 20, 25, 30];

// The layouts offered, in CREDITS_OUTRO_LAYOUTS order.
const LAYOUT_LABELS = { roll: 'Roll', grid: 'Grid (one screen)' };

const FIELD = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-sm sm:min-h-0';

/** One text field: edited in place, saved when it loses focus. */
function TextField({ id, label, value, placeholder = '', list, onCommit, hideLabel = false }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'mb-0.5 block text-xs text-port-text-muted'}>{label}</label>
      <input id={id} type="text" value={draft} maxLength={CREDITS_OUTRO_LIMITS.textMax} placeholder={placeholder} list={list}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() !== value) onCommit(draft.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className={`${FIELD} w-full`} />
    </div>
  );
}

/**
 * The film credits ending (lib/musicVideoCreditsOutro.js): an optional credits
 * page after the song (after the cutting room floor when that is on too).
 * Turning it on the first time fills the song title, the artist from
 * Create › Music › Artists and Directed / Music / Produced by lines; every
 * line stays editable, and Refill fills them again from the song and artist.
 */
export default function CreditsOutroPanel({ project, onEditLocal, onSave }) {
  const [filling, setFilling] = useState(false);
  const credits = normalizeCreditsOutro(project.creditsOutro);
  const on = !!credits?.enabled;
  const save = (next) => {
    onEditLocal({ creditsOutro: next });
    return onSave({ creditsOutro: next });
  };
  const commit = (patch) => save(normalizeCreditsOutro({ ...(credits || CREDITS_OUTRO_DEFAULTS), ...patch }));
  const fill = (keep = {}) => {
    setFilling(true);
    return getMusicVideoCreditsPrefill(project.id, { silent: true })
      .then((res) => save(normalizeCreditsOutro({ ...(res?.credits || CREDITS_OUTRO_DEFAULTS), ...keep, enabled: true })))
      // The board's save already reports a failure; it must not leave the switch disabled.
      .catch(() => null)
      .finally(() => setFilling(false));
  };
  const toggle = (enabled) => (enabled && !credits ? fill() : commit({ enabled }));
  const lines = credits?.lines || [];
  const setLine = (index, patch) => commit({ lines: lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });
  const removeLine = (index) => commit({ lines: lines.filter((_, i) => i !== index) });
  // A new line needs a role to be kept (an empty pair is dropped), so it starts on the first role not yet used.
  const addLine = () => commit({ lines: [...lines, { role: CREDITS_OUTRO_ROLES.find((role) => !lines.some((line) => line.role === role)) || 'Special thanks', name: '' }] });
  const lengths = !credits || LENGTHS.includes(credits.durationSec) ? LENGTHS : [...LENGTHS, credits.durationSec].sort((a, b) => a - b);
  const id = (key) => `mv-credits-${key}`;
  return (
    <section aria-label="Credits ending" className="space-y-2 rounded-lg border border-port-border bg-port-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Clapperboard size={14} className="text-port-accent" aria-hidden="true" /> Credits ending
          <span className="text-xs font-normal text-port-text-muted">Optional</span>
        </h3>
        <label htmlFor={id('on')} className="inline-flex min-h-[44px] items-center gap-2 text-xs text-port-text-muted sm:min-h-0">
          {filling ? 'Filling…' : on ? `On · ${credits.durationSec}s` : 'Off'}
          <input id={id('on')} type="checkbox" checked={on} disabled={filling} onChange={(e) => toggle(e.target.checked)} className="h-4 w-4" />
        </label>
      </div>
      {on && (
        <div className="space-y-2">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
            <TextField id={id('title')} label="Song title" value={credits.title} onCommit={(title) => commit({ title })} />
            <TextField id={id('artist')} label="Performed by" value={credits.artist} onCommit={(artist) => commit({ artist })} />
            <div>
              <label htmlFor={id('length')} className="mb-0.5 block text-xs text-port-text-muted">Length</label>
              <select id={id('length')} value={credits.durationSec} onChange={(e) => commit({ durationSec: Number(e.target.value) })} className={FIELD}>
                {lengths.map((sec) => <option key={sec} value={sec}>{sec}s</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={id('layout')} className="mb-0.5 block text-xs text-port-text-muted">Layout</label>
              <select id={id('layout')} value={credits.layout} onChange={(e) => commit({ layout: e.target.value })} className={FIELD}>
                {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
          <fieldset className="min-w-0 space-y-1">
            <legend className="mb-0.5 text-xs text-port-text-muted">Credits</legend>
            <datalist id={id('roles')}>
              {CREDITS_OUTRO_ROLES.map((role) => <option key={role} value={role} />)}
            </datalist>
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
                <TextField id={id(`role-${i}`)} label={`Credit ${i + 1} role`} hideLabel value={line.role} placeholder="Role" list={id('roles')}
                  onCommit={(role) => setLine(i, { role })} />
                <TextField id={id(`name-${i}`)} label={`Credit ${i + 1} name`} hideLabel value={line.name} placeholder="Name"
                  onCommit={(name) => setLine(i, { name })} />
                <button type="button" onClick={() => removeLine(i)} aria-label={`Remove ${line.role || 'credit'} ${line.name}`.trim()}
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted sm:min-h-0 sm:min-w-0 sm:p-1">
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              {lines.length < CREDITS_OUTRO_LIMITS.linesMax && (
                <button type="button" onClick={addLine}
                  className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs sm:min-h-0 sm:py-1">
                  <Plus size={14} aria-hidden="true" /> Add credit
                </button>
              )}
              <button type="button" onClick={() => fill({ durationSec: credits.durationSec, layout: credits.layout })} disabled={filling}
                className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs text-port-text-muted sm:min-h-0 sm:py-1">
                <RotateCcw size={14} aria-hidden="true" /> Refill from song &amp; artist
              </button>
            </div>
          </fieldset>
          <TextField id={id('footer')} label="Closing line" value={credits.footer} placeholder="Optional" onCommit={(footer) => commit({ footer })} />
          <p className="text-xs text-port-text-muted">Plays after the song{project.statsOutro?.enabled ? ' and the cutting room floor' : ''}. {credits.layout === 'grid' ? 'Every credit shows on one screen.' : 'Rolls up when it is taller than the frame.'}</p>
        </div>
      )}
    </section>
  );
}
