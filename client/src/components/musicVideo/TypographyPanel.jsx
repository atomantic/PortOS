import { Copy, Plus, Trash2 } from 'lucide-react';
import { compositionDraft, renderStyleLabel } from './compositionDraft.js';

// Client-minted ids keep a freshly added row addressable across saves (see LyricsPanel).
const mintId = () => `mtc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const toSec = (value) => (value === '' ? null : Number(value));
const inputCls = 'bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';

// Mirrors the server's composition enums (server/lib/musicVideoValidation.js).
const TEMPLATES = [['fade', 'Fade'], ['rise', 'Rise'], ['typewriter', 'Typewriter'], ['pop', 'Pop'], ['build', 'Word build']];
const PLACEMENTS = [['lower', 'Lower'], ['center', 'Center'], ['upper', 'Upper']];
const EMPHASES = [['subtitle', 'Subtitle'], ['hero', 'Hero']];
const FONTS = [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']];
// #9290: one cut per planned shot, or intercut on energy and sung words.
const CUTTING = [['scene', 'One cut per shot'], ['intercut', 'Intercut on the song']];

/**
 * Composition manifest editor (#8984): switch the final render between plain
 * cuts and a composed render that lays these timed text cues over the footage
 * (the song stays the only audio). Cues are the director's own lines — "Copy
 * timed lyrics" seeds them from the lyric cues, after which they are edited
 * independently. Edits apply locally at once and persist on blur, replacing
 * the whole manifest (like the lyric lists).
 */
export default function TypographyPanel({ project, onEditLocal, onSave }) {
  const composition = compositionDraft(project);
  const cues = composition.textCues || [];
  const composed = composition.mode === 'composed';
  const codeMode = composition.mode === 'code';
  const footage = composition.mode === 'concat';
  const timedLyrics = (project.lyricCues || []).filter((c) => typeof c.startSec === 'number' && typeof c.endSec === 'number');

  const edit = (patch) => onEditLocal({ composition: { ...composition, ...patch } });
  const save = (patch = {}) => onSave({ composition: { ...composition, ...patch } });
  const replace = (patch) => { edit(patch); save(patch); };
  const editCue = (id, patch) => edit({ textCues: cues.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const replaceCue = (id, patch) => replace({ textCues: cues.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const lastEnd = cues.reduce((max, c) => Math.max(max, c.endSec ?? 0), 0);

  const copyLyrics = () => replace({
    textCues: timedLyrics.map((c) => ({ id: mintId(), text: c.text, startSec: c.startSec, endSec: c.endSec, template: 'fade', placement: 'lower', emphasis: 'subtitle' })),
  });

  return (
    <details className="mt-2 bg-port-bg border border-port-border rounded-lg p-2 text-xs">
      <summary className="cursor-pointer select-none text-port-text-muted min-h-[44px] sm:min-h-0 flex flex-wrap items-center gap-x-1">
        Typography — {renderStyleLabel(composition.mode)} · {cues.length} text cue{cues.length === 1 ? '' : 's'}
        <span className="block sm:inline sm:ml-1">— timed text laid over the footage, kept inside the title-safe area.</span>
      </summary>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="mv-typo-cutting" className="block text-port-text-muted mb-0.5" title="Intercut re-cuts each shot on the song's energy and sung words, reusing cutaway footage — no extra generation.">Cutting</label>
          <select id="mv-typo-cutting" value={composition.cutting || 'scene'} onChange={(e) => replace({ cutting: e.target.value })} className={inputCls}>
            {CUTTING.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="mv-typo-font" className="block text-port-text-muted mb-0.5">Font</label>
          <select id="mv-typo-font" value={composition.style.font} onChange={(e) => replace({ style: { ...composition.style, font: e.target.value } })} className={inputCls}>
            {FONTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="mv-typo-color" className="block text-port-text-muted mb-0.5">Text color</label>
          <input id="mv-typo-color" type="color" value={composition.style.color}
            onChange={(e) => edit({ style: { ...composition.style, color: e.target.value } })}
            onBlur={() => save()} className="h-8 w-12 bg-port-bg border border-port-border rounded" />
        </div>
        <div>
          <label htmlFor="mv-typo-poster" className="block text-port-text-muted mb-0.5" title="Frame used as the rendered video's poster. Empty picks the loudest section.">Poster frame (s)</label>
          <input id="mv-typo-poster" type="number" min={0} step={0.1} placeholder="auto"
            value={composition.posterSec ?? ''} onChange={(e) => edit({ posterSec: toSec(e.target.value) })}
            onBlur={() => save()} className={`${inputCls} w-20`} />
        </div>
        <button type="button" onClick={copyLyrics} disabled={timedLyrics.length === 0}
          title={timedLyrics.length === 0 ? 'Time some lyric lines first' : 'Replace the text cues with the timed lyric lines'}
          className="flex items-center gap-1 text-port-accent min-h-[44px] sm:min-h-0 disabled:opacity-50">
          <Copy size={13} /> Copy timed lyrics ({timedLyrics.length})
        </button>
        <button type="button"
          onClick={() => replace({ textCues: [...cues, { id: mintId(), text: 'New text', startSec: lastEnd, endSec: lastEnd + 2, template: 'fade', placement: 'lower', emphasis: 'subtitle' }] })}
          className="flex items-center gap-1 text-port-accent min-h-[44px] sm:min-h-0"><Plus size={13} /> Text cue</button>
      </div>

      {composed && cues.length === 0 && <p className="mt-2 text-port-text-muted">No text cues yet — a composed render with none renders as plain cuts.</p>}
      {footage && cues.length > 0 && <p className="mt-2 text-port-warning" role="status">Footage renders plain cuts, so these text cues will not appear. Choose Composed in Setup to lay them over the footage.</p>}
      {codeMode && <p className="mt-2 text-port-text-muted">Code-rendered draws the song in code. Text cues stay stored and come back if you switch to Composed.</p>}
      {composition.mode === 'document' && <p className="mt-2 text-port-text-muted">The composition document reads these cues from <code>PORTOS_MV.textCues</code>: the layered template draws Hero cues as kinetic words on their sung times and uses Subtitle cues (or, with none, the timed lyrics) as subtitles.</p>}
      <div className="mt-2 max-h-72 overflow-y-auto space-y-1 pr-1">
        {cues.map((cue, i) => (
          <div key={cue.id} className="flex flex-wrap items-center gap-1">
            <input type="number" min={0} step={0.01} aria-label={`Text cue ${i + 1} start (s)`} placeholder="start"
              value={cue.startSec ?? ''} onChange={(e) => editCue(cue.id, { startSec: toSec(e.target.value) })}
              onBlur={() => save()} className={`${inputCls} w-16`} />
            <input type="number" min={0} step={0.01} aria-label={`Text cue ${i + 1} end (s)`} placeholder="end"
              value={cue.endSec ?? ''} onChange={(e) => editCue(cue.id, { endSec: toSec(e.target.value) })}
              onBlur={() => save()} className={`${inputCls} w-16`} />
            <input type="text" maxLength={500} aria-label={`Text cue ${i + 1} text`}
              value={cue.text} onChange={(e) => editCue(cue.id, { text: e.target.value })}
              onBlur={() => save()} className={`${inputCls} min-w-0 flex-1 basis-40`} />
            {[['template', TEMPLATES, 'motion'], ['placement', PLACEMENTS, 'placement'], ['emphasis', EMPHASES, 'size']].map(([field, options, name]) => (
              <select key={field} aria-label={`Text cue ${i + 1} ${name}`} value={cue[field] || options[0][0]}
                onChange={(e) => replaceCue(cue.id, { [field]: e.target.value })} className={inputCls}>
                {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            ))}
            <button type="button" onClick={() => replace({ textCues: cues.filter((c) => c.id !== cue.id) })}
              aria-label={`Delete text cue ${i + 1}`} className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1 text-port-error"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
    </details>
  );
}
