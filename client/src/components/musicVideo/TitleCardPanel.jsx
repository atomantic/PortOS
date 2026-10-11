import { useState } from 'react';
import { Clapperboard, Play } from 'lucide-react';
import { getMusicVideoPublishPlatforms } from '../../services/apiMusicVideo.js';
import {
  TITLE_CARD_LIMITS, normalizeTitleCard, titleCardPrefill,
} from '../../../../server/lib/musicVideoTitleCard.js';

const POSITIONS = [['lower-left', 'Bottom left'], ['lower-right', 'Bottom right'], ['upper-left', 'Top left'], ['upper-right', 'Top right'], ['lower-center', 'Bottom centre'], ['center', 'Centre']];
const FONTS = [['display', 'Lyric type'], ['sans', 'Helvetica'], ['serif', 'Serif'], ['mono', 'Mono']];
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
 * artist and year in a corner, fading in and out over the opener. Drawn over
 * the composition document in the docked live preview and the final render.
 * Turning it on fills the song title, the artist named for DistroKid under
 * Where you post, this year and a window that ends before the first sung line.
 * Edits reach the preview at once (`onEditLocal`); leaving a field saves.
 */
export default function TitleCardPanel({ project, onEditLocal, onSave, onPreview }) {
  const [starting, setStarting] = useState(false);
  const documentMode = project.composition?.mode === 'document';
  const raw = project.titleCard || null;
  const card = normalizeTitleCard(raw);
  const on = !!card?.enabled;

  const edit = (patch) => onEditLocal({ titleCard: { ...(raw || {}), ...patch } });
  const commit = (patch = {}) => {
    const next = normalizeTitleCard({ ...(raw || {}), ...patch });
    onEditLocal({ titleCard: next });
    return onSave({ titleCard: next });
  };

  const turnOn = async () => {
    if (card) return commit({ enabled: true });
    setStarting(true);
    const platforms = await getMusicVideoPublishPlatforms({ silent: true }).catch(() => null);
    const distrokid = platforms?.distrokid;
    const artist = distrokid?.account || distrokid?.defaults?.artistName || '';
    const firstLyricSec = (project.lyricCues || []).map((cue) => cue?.startSec).filter((s) => typeof s === 'number').sort((a, b) => a - b)[0] ?? null;
    const next = titleCardPrefill(project, { artist, firstLyricSec });
    onEditLocal({ titleCard: next });
    await onSave({ titleCard: next });
    setStarting(false);
  };

  const overlap = on ? lyricDuringCard(project, card) : null;
  const endBefore = overlap ? Math.round((overlap.startSec - 0.5) * 10) / 10 : null;
  const field = (key) => (raw?.[key] ?? card?.[key] ?? '');

  return (
    <section aria-label="Opening title card" className="space-y-2 border-t border-port-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium"><Clapperboard size={14} className="text-port-accent" aria-hidden="true" /> Opening title card</h3>
        <label htmlFor="mv-title-card-on" className="inline-flex min-h-[44px] items-center gap-2 text-xs text-port-text-muted sm:min-h-0">
          {on ? `Live in the preview · ${clock(card.startSec)}–${clock(card.endSec)}` : 'Off'}
          <input id="mv-title-card-on" type="checkbox" checked={on} disabled={starting}
            onChange={(e) => (e.target.checked ? turnOn() : commit({ enabled: false }))} className="h-4 w-4" />
        </label>
      </div>
      {!documentMode && on && (
        <p className="text-xs text-port-text-muted" role="status">The title card is drawn by the composition-document render style; this project's render style ignores it.</p>
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
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="mv-title-card-position" className={labelCls}>Position</label>
              <select id="mv-title-card-position" value={card.position} onChange={(e) => commit({ position: e.target.value })} className={inputCls}>
                {POSITIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="mv-title-card-font" className={labelCls}>Font</label>
              <select id="mv-title-card-font" value={card.font} onChange={(e) => commit({ font: e.target.value })} className={inputCls}>
                {FONTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
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
              <label htmlFor="mv-title-card-color" className={labelCls}>Color</label>
              <input id="mv-title-card-color" type="color" value={card.color}
                onChange={(e) => edit({ color: e.target.value })} onBlur={() => commit()} className="h-11 w-14 rounded border border-port-border bg-port-bg sm:h-8" />
            </div>
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
