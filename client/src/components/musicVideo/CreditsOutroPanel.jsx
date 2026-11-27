import { useEffect, useState } from 'react';
import { Clapperboard, Plus, RotateCcw, X } from 'lucide-react';
import useMounted from '../../hooks/useMounted.js';
import { getMusicVideoCreditsPrefill } from '../../services/apiMusicVideo.js';
import CreditsOutroCanvas from './CreditsOutroCanvas.jsx';
import {
  CREDITS_OUTRO_COLORS, CREDITS_OUTRO_DEFAULTS, CREDITS_OUTRO_LIMITS, CREDITS_OUTRO_ROLES,
  CREDITS_OUTRO_SOCIAL_PLATFORMS, CREDITS_OUTRO_STYLES, normalizeCreditsOutro,
} from '../../../../server/lib/musicVideo/musicVideoCreditsOutro.js';

// Lengths offered for the credits, in seconds (inside CREDITS_OUTRO_LIMITS).
const LENGTHS = [6, 8, 10, 12, 15, 20, 25, 30];

// The layouts, styles, fonts and social platforms offered.
const LAYOUT_LABELS = { roll: 'Roll', grid: 'Grid (one screen)' };
const STYLE_LABELS = {
  classic: 'Classic black',
  'analog-16mm': '16mm film print',
  'mtv-broadcast': 'MTV / 1986 broadcast',
  'snapshot-print': 'Snapshot print',
  'festival-poster': 'Festival title card',
};
const SOCIAL_LABELS = {
  youtube: 'YouTube',
  x: 'X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  suno: 'Suno',
  web: 'Website',
};
const FONT_LABELS = { title: 'Playfair Display · Serif', body: 'Archivo · Sans serif', condensed: 'Oswald · Condensed', mono: 'IBM Plex Mono' };
const COLOR_LABELS = {
  textColor: 'Main text color',
  labelColor: 'Label and closing line color',
  backgroundColor: 'Background color',
  accentColor: 'Accent color',
};

const FIELD = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-sm pointer-fine:sm:min-h-0';

/** One text field: edited in place, saved when it loses focus. */
function TextField({ id, label, value, placeholder = '', list, onCommit, multiline = false, maxLength = CREDITS_OUTRO_LIMITS.textMax }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const props = { value: draft, placeholder, onChange: (e) => setDraft(e.target.value),
    onBlur: () => { if (draft.trim() !== value) onCommit(draft.trim()); }, className: `${FIELD} w-full` };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-0.5 block text-xs text-port-text-muted">{label}</label>
      {multiline ? <textarea id={id} {...props} rows={2} maxLength={CREDITS_OUTRO_LIMITS.blockTextMax} />
        : <input id={id} {...props} type="text" maxLength={maxLength} list={list}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />}
    </div>
  );
}

function CreditsAppearance({ project, credits, id, commit }) {
  const shotStills = (project?.scenes || [])
    .filter((s) => s?.referenceImageId && /\.(?:png|jpe?g|webp)$/i.test(s.referenceImageId))
    .map((s, idx) => ({ id: s.referenceImageId, label: `Shot ${(s.order ?? idx) + 1}${s.label ? ` · ${s.label}` : ''}` }));
  return (
    <fieldset className="min-w-0 space-y-2 border-t border-port-border pt-2">
      <legend className="text-xs text-port-text-muted">Appearance</legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
        <div className="min-w-0">
          <label htmlFor={id('style')} className="mb-0.5 block text-xs text-port-text-muted">Card style</label>
          <select id={id('style')} value={credits.style || 'classic'} onChange={(e) => commit({ style: e.target.value })} className={`${FIELD} w-full`}>
            {CREDITS_OUTRO_STYLES.map((value) => <option key={value} value={value}>{STYLE_LABELS[value]}</option>)}
          </select>
        </div>
        {shotStills.length > 0 && (
          <div className="min-w-0">
            <label htmlFor={id('bg-image')} className="mb-0.5 block text-xs text-port-text-muted">Background still</label>
            <select id={id('bg-image')} value={credits.backgroundImageId || ''} onChange={(e) => commit({ backgroundImageId: e.target.value || null })} className={`${FIELD} w-full`}>
              <option value="">None (solid / styled backdrop)</option>
              {shotStills.map((shot) => <option key={`${shot.label}-${shot.id}`} value={shot.id}>{shot.label}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <label htmlFor={id('quote')} className="inline-flex min-h-11 items-center gap-2 text-sm">
          <input id={id('quote')} type="checkbox" checked={credits.quoteTitle !== false} onChange={(e) => commit({ quoteTitle: e.target.checked })} />
          Quote song title
        </label>
        <label htmlFor={id('show-performer')} className="inline-flex min-h-11 items-center gap-2 text-sm">
          <input id={id('show-performer')} type="checkbox" checked={credits.showPerformer !== false} onChange={(e) => commit({ showPerformer: e.target.checked })} />
          Show “Performed by”
        </label>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
        {[['titleFont', 'Title font', 'title'], ['bodyFont', 'Credits font', 'body']].map(([key, label, fallback]) => (
          <div key={key} className="min-w-0">
            <label htmlFor={id(key)} className="mb-0.5 block text-xs text-port-text-muted">{label}</label>
            <select id={id(key)} value={credits[key] || fallback} onChange={(e) => commit({ [key]: e.target.value })} className={`${FIELD} w-full`}>
              {Object.entries(FONT_LABELS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select>
          </div>
        ))}
        {Object.entries(COLOR_LABELS).map(([key, label]) => (
          <div key={key}>
            <label htmlFor={id(key)} className="mb-0.5 block text-xs text-port-text-muted">{label}</label>
            <input id={id(key)} type="color" value={credits[key] || CREDITS_OUTRO_COLORS[key]}
              onChange={(e) => commit({ [key]: e.target.value })} className="h-11 w-16 rounded border border-port-border bg-port-bg p-1" />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function CreditsSocials({ socials, id, onChange }) {
  const setSocial = (index, patch) => onChange(socials.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  const removeSocial = (index) => onChange(socials.filter((_, i) => i !== index));
  const addSocial = () => {
    const used = new Set(socials.map((s) => s.platform));
    const nextPlatform = CREDITS_OUTRO_SOCIAL_PLATFORMS.find((p) => !used.has(p)) || 'youtube';
    onChange([...socials, { platform: nextPlatform, handle: '@' }]);
  };
  return (
    <fieldset className="min-w-0 space-y-1.5 border-t border-port-border pt-2">
      <legend className="text-xs text-port-text-muted">Social handles (with icons)</legend>
      {socials.map((entry, i) => (
        <div key={i} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1.5">
          <div>
            <label htmlFor={id(`social-platform-${i}`)} className="mb-0.5 block text-xs text-port-text-muted">Platform</label>
            <select id={id(`social-platform-${i}`)} value={entry.platform}
              onChange={(e) => setSocial(i, { platform: e.target.value })} className={FIELD}>
              {CREDITS_OUTRO_SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{SOCIAL_LABELS[p]}</option>)}
            </select>
          </div>
          <TextField id={id(`social-handle-${i}`)} label="Handle" value={entry.handle} placeholder="@handle"
            maxLength={CREDITS_OUTRO_LIMITS.handleMax} onCommit={(handle) => setSocial(i, { handle })} />
          <button type="button" onClick={() => removeSocial(i)} aria-label={`Remove social handle ${i + 1}`}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text-muted hover:border-port-accent">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {socials.length < CREDITS_OUTRO_LIMITS.socialsMax && (
        <button type="button" onClick={addSocial}
          className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs pointer-fine:sm:min-h-0 sm:py-1">
          <Plus size={14} aria-hidden="true" /> Add social handle
        </button>
      )}
    </fieldset>
  );
}

/**
 * The film credits ending (lib/musicVideo/musicVideoCreditsOutro.js): an optional credits
 * page after the song (after the cutting room floor when that is on too).
 * Turning it on the first time fills the song title, the artist from
 * Create › Music › Artists and Directed / Music / Produced by lines; every
 * line stays editable, and Refill fills them again from the song and artist.
 */
export default function CreditsOutroPanel({ project, onEditLocal, onSave, showPreview = false }) {
  const [filling, setFilling] = useState(false);
  // A refill still in flight when this editor closes is dropped: a reopened
  // editor is not locked by it, so its answer must not overwrite later edits.
  const mounted = useMounted();
  const credits = normalizeCreditsOutro(project.creditsOutro);
  const on = !!credits?.enabled;
  const save = (next) => {
    onEditLocal({ creditsOutro: next });
    return onSave({ creditsOutro: next });
  };
  const commit = (patch) => save(normalizeCreditsOutro({ ...(credits || CREDITS_OUTRO_DEFAULTS), ...patch }));
  const fill = (keep = {}) => {
    setFilling(true);
    // A failed lookup is reported (not silent) and changes nothing.
    return getMusicVideoCreditsPrefill(project.id)
      .then((res) => (mounted.current ? save(normalizeCreditsOutro({ ...res.credits, ...keep, enabled: true })) : null))
      // The request and the board's save report their own failures; neither may leave the controls disabled.
      .catch(() => null)
      .finally(() => { if (mounted.current) setFilling(false); });
  };
  const toggle = (enabled) => (enabled && !credits ? fill() : commit({ enabled }));
  const lines = credits?.lines || [];
  const socials = credits?.socials || [];
  const setLine = (index, patch) => commit({ lines: lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });
  const removeLine = (index) => commit({ lines: lines.filter((_, i) => i !== index) });
  const addLine = () => commit({ lines: [...lines, { role: 'New credit', name: '' }] });
  const refill = () => {
    const { title: _title, artist: _artist, lines: _lines, footer: _footer, ...settings } = credits;
    return fill({ ...settings, quoteTitle: credits.quoteTitle !== false });
  };
  const lengths = !credits || LENGTHS.includes(credits.durationSec) ? LENGTHS : [...LENGTHS, credits.durationSec].sort((a, b) => a - b);
  const id = (key) => `mv-credits-${key}`;
  return (
    <section aria-label="Credits ending" className="space-y-2 rounded-lg border border-port-border bg-port-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Clapperboard size={14} className="text-port-accent" aria-hidden="true" /> Credits ending
          <span className="text-xs font-normal text-port-text-muted">Optional</span>
        </h3>
        <label htmlFor={id('on')} className="inline-flex min-h-[44px] items-center gap-2 text-xs text-port-text-muted pointer-fine:sm:min-h-0">
          {filling ? 'Filling…' : on ? `On · ${credits.durationSec}s` : 'Off'}
          <input id={id('on')} type="checkbox" checked={on} disabled={filling} onChange={(e) => toggle(e.target.checked)} className="h-4 w-4" />
        </label>
      </div>
      {/* Locked while a refill is in flight, so no edit is lost when its lines land. */}
      {on && (
        <fieldset disabled={filling} className="min-w-0 space-y-2">
          {showPreview && (
            <figure className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black">
              <CreditsOutroCanvas credits={credits} t={credits.durationSec / 2} durationSec={credits.durationSec} />
            </figure>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
            <TextField id={id('title')} label="Song title" value={credits.title} onCommit={(title) => commit({ title })} />
            {credits.showPerformer !== false && <TextField id={id('artist')} label="Performed by" value={credits.artist} onCommit={(artist) => commit({ artist })} />}
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
          <CreditsAppearance project={project} credits={credits} commit={commit} id={id} />
          <fieldset className="min-w-0 space-y-1">
            <legend className="mb-0.5 text-xs text-port-text-muted">Credit blocks</legend>
            <p className="text-xs text-port-text-muted">Give each block an optional heading and your own text. In Grid, each block gets its own cell.</p>
            <datalist id={id('roles')}>
              {CREDITS_OUTRO_ROLES.map((role) => <option key={role} value={role} />)}
            </datalist>
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1.5 rounded border border-port-border p-2">
                <TextField id={id(`role-${i}`)} label={`Block ${i + 1} heading`} value={line.role} placeholder="Optional" list={id('roles')}
                  onCommit={(role) => setLine(i, { role })} />
                <button type="button" onClick={() => removeLine(i)} aria-label={`Remove credit block ${i + 1}`}
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text-muted hover:border-port-accent">
                  <X size={14} aria-hidden="true" />
                </button>
                <div className="col-span-2">
                  <TextField id={id(`name-${i}`)} label={`Block ${i + 1} text`} value={line.name} placeholder="Names or other text" multiline
                    onCommit={(name) => setLine(i, { name })} />
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              {lines.length < CREDITS_OUTRO_LIMITS.linesMax && (
                <button type="button" onClick={addLine}
                  className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs pointer-fine:sm:min-h-0 sm:py-1">
                  <Plus size={14} aria-hidden="true" /> Add credit block
                </button>
              )}
              <button type="button" onClick={refill} disabled={filling}
                className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs text-port-text-muted pointer-fine:sm:min-h-0 sm:py-1">
                <RotateCcw size={14} aria-hidden="true" /> Refill from song &amp; artist
              </button>
            </div>
          </fieldset>
          <CreditsSocials socials={socials} id={id} onChange={(next) => commit({ socials: next })} />
          <TextField id={id('footer')} label="Closing line" value={credits.footer} placeholder="Optional" onCommit={(footer) => commit({ footer })} />
          <p className="text-xs text-port-text-muted">Plays after the song{project.statsOutro?.enabled ? ' and the cutting room floor' : ''}. {credits.layout === 'grid' ? 'Every credit shows on one screen.' : 'Rolls up when it is taller than the frame.'}</p>
        </fieldset>
      )}
    </section>
  );
}
