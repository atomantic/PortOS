import { useEffect, useState } from 'react';
import { Clapperboard, Play } from 'lucide-react';
import { getMusicVideoPublishPlatforms } from '../../services/apiMusicVideo.js';
import {
  TITLE_CARD_FONT_FACES, TITLE_CARD_LIMITS, TITLE_CARD_MTV_COLORS, normalizeTitleCard, titleCardOutroWindow, titleCardPrefill,
} from '../../../../server/lib/musicVideoTitleCard.js';

const POSITIONS = [['lower-left', 'Bottom left'], ['lower-right', 'Bottom right'], ['upper-left', 'Top left'], ['upper-right', 'Top right'], ['lower-center', 'Bottom centre'], ['center', 'Centre']];

// Each choice: [id, label, the face the card draws it in, its file under /fonts/title-card/ for the picker swatch, weight].
// The files are copies of the server's (titleCardFonts/, documentTemplates/shared/fonts/); a server test keeps them identical.
const FONTS = [
  ['display', 'Lyric type', '"MV Archivo", "Arial Black", sans-serif', 'archivo-variable.woff2', 800],
  ['sans', 'Helvetica', '"Helvetica Neue", Helvetica, Arial, sans-serif', null, 700],
  ['serif', 'Serif', 'Georgia, "Times New Roman", serif', null, 700],
  ['mono', 'Mono', '"MV Mono", Menlo, monospace', 'ibm-plex-mono-500.woff2', 500],
  ['oswald', 'Oswald', `"${TITLE_CARD_FONT_FACES.oswald.family}", "Arial Narrow", sans-serif`, 'oswald-700.woff2', 700],
  ['audiowide', 'Audiowide', `"${TITLE_CARD_FONT_FACES.audiowide.family}", sans-serif`, 'audiowide-400.woff2', 400],
  ['orbitron', 'Orbitron', `"${TITLE_CARD_FONT_FACES.orbitron.family}", sans-serif`, 'orbitron-700.woff2', 700],
  ['righteous', 'Righteous', `"${TITLE_CARD_FONT_FACES.righteous.family}", sans-serif`, 'righteous-400.woff2', 400],
  ['pacifico', 'Pacifico', `"${TITLE_CARD_FONT_FACES.pacifico.family}", cursive`, 'pacifico-400.woff2', 400],
  ['playfair', 'Playfair', `"${TITLE_CARD_FONT_FACES.playfair.family}", Georgia, serif`, 'playfair-display-700.woff2', 700],
];
let swatchFacesAdded = false;
// The picker shows each choice in its own face: register the bundled files once per page.
function addSwatchFaces() {
  if (swatchFacesAdded || typeof FontFace !== 'function' || !document.fonts?.add) return;
  swatchFacesAdded = true;
  for (const [, , stack, file] of FONTS) {
    if (file) document.fonts.add(new FontFace(stack.match(/^"([^"]+)"/)[1], `url(/fonts/title-card/${file})`, { weight: '100 900' }));
  }
}
const LOOKS = [['outline', 'Outlined, like the lyrics'], ['mtv', 'Classic MTV lower third']];
// Render styles that draw the card: the composition document and a composed cut's typography layer.
const DRAWN_BY = ['document', 'composed'];
const inputCls = 'w-full rounded border border-port-border bg-port-bg px-2 py-1 text-sm min-h-[44px] sm:min-h-0';
const labelCls = 'mb-0.5 block text-xs text-port-text-muted';
const clock = (sec) => {
  const rest = sec % 60;
  return `${Math.floor(sec / 60)}:${Number.isInteger(Math.round(rest * 10) / 10) ? String(Math.round(rest)).padStart(2, '0') : rest.toFixed(1).padStart(4, '0')}`;
};
const toNumber = (value) => (value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));

/** The first timed lyric line that shares the screen with the card's window, if any. */
function lyricDuringCard(project, card) {
  return (project.lyricCues || [])
    .filter((cue) => typeof cue?.startSec === 'number' && cue.startSec < card.endSec && (typeof cue.endSec === 'number' ? cue.endSec : cue.startSec + 1) > card.startSec)
    .sort((a, b) => a.startSec - b.startSec)[0] || null;
}

/**
 * The MTV-style opening title card (lib/musicVideoTitleCard.js): song title,
 * artist and year in a corner, fading in and out over the opener, outlined like
 * the lyrics or as a classic lower third. Drawn in the docked live preview, the
 * storyboard animatic and the final render (composed or document styles).
 * Turning it on fills the song title, the artist named for DistroKid under
 * Where you post, this year and a window that ends before the first sung line.
 * Edits reach the preview at once (`onEditLocal`); leaving a field saves.
 * Optionally it shows again at the end (`outro`), timed from the song's length.
 * Edited on the Look step, under the docked preview (a card of its own there).
 */
export default function TitleCardPanel({ project, onEditLocal, onSave, onPreview }) {
  const [starting, setStarting] = useState(false);
  useEffect(addSwatchFaces, []);
  const drawn = DRAWN_BY.includes(project.composition?.mode);
  const raw = project.titleCard || null;
  const card = normalizeTitleCard(raw);
  const on = !!card?.enabled;

  const edit = (patch) => onEditLocal({ titleCard: { ...(raw || {}), ...patch } });
  const commit = (patch = {}) => {
    const next = normalizeTitleCard({ ...(raw || {}), ...patch });
    onEditLocal({ titleCard: next });
    return onSave({ titleCard: next });
  };

  const turnOn = () => {
    if (card) return commit({ enabled: true });
    setStarting(true);
    const firstLyricSec = (project.lyricCues || []).map((cue) => cue?.startSec).filter((s) => typeof s === 'number').sort((a, b) => a - b)[0] ?? null;
    return getMusicVideoPublishPlatforms({ silent: true }).catch(() => null)
      .then((platforms) => {
        const distrokid = platforms?.distrokid;
        const next = titleCardPrefill(project, { artist: distrokid?.account || distrokid?.defaults?.artistName || '', firstLyricSec });
        onEditLocal({ titleCard: next });
        return onSave({ titleCard: next });
      })
      // The board's save already reports a failure; it must not leave the switch disabled.
      .catch(() => null)
      .finally(() => setStarting(false));
  };

  const overlap = on ? lyricDuringCard(project, card) : null;
  const endBefore = overlap ? Math.round((overlap.startSec - 0.5) * 10) / 10 : null;
  const field = (key) => (raw?.[key] ?? card?.[key] ?? '');
  const songSec = project.audioAnalysis?.durationSec;
  // Turning the end showing on times it from the song's length the first time.
  const setOutro = (outro) => commit(outro && card?.outroStartSec == null ? { outro, ...titleCardOutroWindow(card, songSec) } : { outro });
  const canOutro = card?.outro || card?.outroStartSec != null || !!titleCardOutroWindow(card, songSec);

  return (
    <section aria-label="Opening title card" className="space-y-2 rounded-lg border border-port-border bg-port-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium"><Clapperboard size={14} className="text-port-accent" aria-hidden="true" /> Opening title card</h3>
        <label htmlFor="mv-title-card-on" className="inline-flex min-h-[44px] items-center gap-2 text-xs text-port-text-muted sm:min-h-0">
          {on ? `Live in the preview · ${clock(card.startSec)}–${clock(card.endSec)}` : 'Off'}
          <input id="mv-title-card-on" type="checkbox" checked={on} disabled={starting}
            onChange={(e) => (e.target.checked ? turnOn() : commit({ enabled: false }))} className="h-4 w-4" />
        </label>
      </div>
      {!drawn && on && (
        <p className="text-xs text-port-text-muted" role="status">This project's render style does not draw the title card; the composed and composition-document styles do.</p>
      )}
      {on && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="mv-title-card-title" className={labelCls}>Song title</label>
              <input id="mv-title-card-title" value={field('title')} maxLength={TITLE_CARD_LIMITS.textMax}
                onChange={(e) => edit({ title: e.target.value })} onBlur={() => commit()} className={inputCls} />
            </div>
            <div>
              <label htmlFor="mv-title-card-artist" className={labelCls}>Artist</label>
              <input id="mv-title-card-artist" value={field('artist')} maxLength={TITLE_CARD_LIMITS.textMax}
                onChange={(e) => edit({ artist: e.target.value })} onBlur={() => commit()} className={inputCls} />
            </div>
            <div>
              <label htmlFor="mv-title-card-year" className={labelCls}>Year</label>
              <input id="mv-title-card-year" value={field('year')} maxLength={TITLE_CARD_LIMITS.yearMax} inputMode="numeric"
                onChange={(e) => edit({ year: e.target.value })} onBlur={() => commit()} className={inputCls} />
            </div>
            <div>
              <label htmlFor="mv-title-card-extra" className={labelCls}>Extra line</label>
              <input id="mv-title-card-extra" value={field('extra')} maxLength={TITLE_CARD_LIMITS.textMax} placeholder="Album or director"
                onChange={(e) => edit({ extra: e.target.value })} onBlur={() => commit()} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor="mv-title-card-start" className={labelCls}>In (s)</label>
              <input id="mv-title-card-start" type="number" min={0} max={TITLE_CARD_LIMITS.startMax} step={0.1} value={field('startSec')}
                onChange={(e) => edit({ startSec: toNumber(e.target.value) })} onBlur={() => commit()} className={inputCls} />
            </div>
            <div>
              <label htmlFor="mv-title-card-end" className={labelCls}>Out (s)</label>
              <input id="mv-title-card-end" type="number" min={0} step={0.1} value={field('endSec')}
                onChange={(e) => edit({ endSec: toNumber(e.target.value) })} onBlur={() => commit()} className={inputCls} />
            </div>
            <div>
              <label htmlFor="mv-title-card-fade" className={labelCls}>Fade (s)</label>
              <input id="mv-title-card-fade" type="number" min={0} max={TITLE_CARD_LIMITS.fadeMax} step={0.1} value={field('fadeSec')}
                onChange={(e) => edit({ fadeSec: toNumber(e.target.value) })} onBlur={() => commit()} className={inputCls} />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="mv-title-card-outro" className="inline-flex min-h-[44px] items-center gap-2 text-xs text-port-text-muted sm:min-h-0">
              <input id="mv-title-card-outro" type="checkbox" checked={card.outro} disabled={!canOutro}
                onChange={(e) => setOutro(e.target.checked)} className="h-4 w-4" />
              Also at the end · Optional
            </label>
            {!canOutro && <p className="text-xs text-port-text-muted">Needs the song's length; analyze the song first.</p>}
            {card.outro && (
              <div className="grid grid-cols-3 items-end gap-2">
                <div>
                  <label htmlFor="mv-title-card-outro-start" className={labelCls}>End in (s)</label>
                  <input id="mv-title-card-outro-start" type="number" min={0} max={TITLE_CARD_LIMITS.outroMax} step={0.1} value={field('outroStartSec')}
                    onChange={(e) => edit({ outroStartSec: toNumber(e.target.value) ?? null })} onBlur={() => commit()} className={inputCls} />
                </div>
                <div>
                  <label htmlFor="mv-title-card-outro-end" className={labelCls}>End out (s)</label>
                  <input id="mv-title-card-outro-end" type="number" min={0} step={0.1} value={field('outroEndSec')}
                    onChange={(e) => edit({ outroEndSec: toNumber(e.target.value) ?? null })} onBlur={() => commit()} className={inputCls} />
                </div>
                {onPreview && typeof card.outroStartSec === 'number' && (
                  <button type="button" onClick={() => onPreview(Math.max(0, card.outroStartSec - 0.5))}
                    className="inline-flex min-h-[44px] items-center gap-1 text-xs text-port-accent sm:min-h-0">
                    <Play size={13} aria-hidden="true" /> Play from {clock(Math.max(0, card.outroStartSec - 0.5))}
                  </button>
                )}
              </div>
            )}
          </div>
          <div>
            <label htmlFor="mv-title-card-look" className={labelCls}>Look</label>
            <select id="mv-title-card-look" value={card.style} onChange={(e) => commit({ style: e.target.value })} className={inputCls}>
              {LOOKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mv-title-card-position" className={labelCls}>Position</label>
            <select id="mv-title-card-position" value={card.position} onChange={(e) => commit({ position: e.target.value })} className={inputCls}>
              {POSITIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div role="radiogroup" aria-labelledby="mv-title-card-font-label">
            <span id="mv-title-card-font-label" className={labelCls}>Font</span>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
              {FONTS.map(([value, label, stack, , weight]) => (
                <button key={value} type="button" role="radio" aria-checked={card.font === value} onClick={() => commit({ font: value })}
                  style={{ fontFamily: stack, fontWeight: weight }}
                  className={`min-h-[44px] truncate rounded border px-2 py-1 text-sm sm:min-h-0 ${card.font === value ? 'border-port-accent bg-port-accent/15 text-white' : 'border-port-border bg-port-bg text-port-text-muted'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="min-w-[10rem] flex-1">
              <label htmlFor="mv-title-card-size" className={labelCls}>Size {field('size')}%</label>
              <input id="mv-title-card-size" type="range" min={TITLE_CARD_LIMITS.sizeMin} max={TITLE_CARD_LIMITS.sizeMax} step={5} value={field('size')}
                onChange={(e) => edit({ size: Number(e.target.value) })} onPointerUp={() => commit()} onKeyUp={() => commit()} onBlur={() => commit()}
                className="h-11 w-full sm:h-auto" />
            </div>
            <div>
              <label htmlFor="mv-title-card-color" className={labelCls}>Text</label>
              <input id="mv-title-card-color" type="color" value={card.color}
                onChange={(e) => edit({ color: e.target.value })} onBlur={() => commit()} className="h-11 w-14 rounded border border-port-border bg-port-bg sm:h-8" />
            </div>
            <div>
              <label htmlFor="mv-title-card-title-color" className={labelCls}>Title</label>
              <input id="mv-title-card-title-color" type="color" value={card.titleColor || (card.style === 'mtv' ? TITLE_CARD_MTV_COLORS.title : card.color)}
                onChange={(e) => edit({ titleColor: e.target.value })} onBlur={() => commit()} className="h-11 w-14 rounded border border-port-border bg-port-bg sm:h-8" />
            </div>
            {card.style === 'mtv' && (
              <div>
                <label htmlFor="mv-title-card-accent" className={labelCls}>Bar</label>
                <input id="mv-title-card-accent" type="color" value={card.accentColor || TITLE_CARD_MTV_COLORS.accent}
                  onChange={(e) => edit({ accentColor: e.target.value })} onBlur={() => commit()} className="h-11 w-14 rounded border border-port-border bg-port-bg sm:h-8" />
              </div>
            )}
            <label htmlFor="mv-title-card-quote" className="inline-flex min-h-[44px] items-center gap-2 text-xs text-port-text-muted sm:min-h-0">
              <input id="mv-title-card-quote" type="checkbox" checked={card.quoteTitle} onChange={(e) => commit({ quoteTitle: e.target.checked })} className="h-4 w-4" />
              Quote the title
            </label>
            {onPreview && (
              <button type="button" onClick={() => onPreview(Math.max(0, card.startSec - 0.5))}
                className="inline-flex min-h-[44px] items-center gap-1 text-xs text-port-accent sm:min-h-0">
                <Play size={13} aria-hidden="true" /> Play from {clock(Math.max(0, card.startSec - 0.5))}
              </button>
            )}
          </div>
          {overlap && (
            <p className="text-xs text-port-warning" role="status">
              A sung line starts at {clock(overlap.startSec)} while the card is up. Check the corner in the preview
              {endBefore > card.startSec + TITLE_CARD_LIMITS.windowMin && (
                <>, or{' '}
                  <button type="button" onClick={() => commit({ endSec: endBefore })} className="min-h-[44px] px-1 text-port-accent sm:min-h-0">
                    end it at {clock(endBefore)}
                  </button>
                </>
              )}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
