import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save, Trash2, Type, Upload } from 'lucide-react';
import {
  COVER_ART_SIZE,
  COVER_DESIGN_OPTIONS,
  canvasCoverWidths,
  coverOverlaySvg,
  coverTypefaceChoices,
  normalizeCoverDesign,
} from '../../lib/musicVideoCoverOverlay.js';
import { musicVideoCoverFontUrl } from '../../services/apiMusicVideo.js';

const FIELDS = [
  ['layout', 'Position'],
  ['typeface', 'Typeface'],
  ['weight', 'Weight'],
  ['letterCase', 'Case'],
  ['scale', 'Size'],
  ['titleStyle', 'Title treatment'],
  ['backdrop', 'Behind the title'],
  ['tagStyle', 'Artist name style'],
  ['tagLayout', 'Artist name placement'],
];
const humanize = (value) => {
  const text = String(value).replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const control = 'w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';
const button = 'flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0';

// A face is registered with the page once per upload (a re-upload changes `addedAt`), so the preview sets the title in the file the server will.
const faceLoads = new Map();
function loadFace(font) {
  const key = `${font.id}:${font.addedAt}`;
  if (!faceLoads.has(key)) {
    faceLoads.set(key, new FontFace(font.family, `url(${musicVideoCoverFontUrl(font.id)})`).load()
      .then((face) => { document.fonts.add(face); })
      .catch(() => { faceLoads.delete(key); }));
  }
  return faceLoads.get(key);
}
// Re-renders once the uploaded faces are usable, so the preview's text widths are measured in them rather than in a fallback.
function usePreviewFonts(fonts) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!fonts?.length || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return undefined;
    let active = true;
    Promise.all(fonts.map(loadFace)).then(() => { if (active) setTick((t) => t + 1); });
    return () => { active = false; };
  }, [fonts]);
  return tick;
}

/**
 * Lettering for the cover (#10345): a control for every field of the song's
 * design, beside a live preview that lays the title and artist out with the
 * same code the server renders with (lib/musicVideoCoverOverlay.js), so a tweak
 * is seen at once with no AI call. "Set the lettering" saves the design and the
 * server re-sets the cover in it. The design can be kept as the artist's style,
 * and an uploaded typeface joins the Typeface choices.
 *
 * Remounted (keyed by the saved design) whenever the server's design changes,
 * which drops any unsaved edits that the new design replaces.
 */
export default function CoverLetteringPanel({ project, art, source, title, tag, focusX, publishKit, lettering, busy, open, onToggle }) {
  const idFor = (s) => `mv-lettering-${project?.id}-${s}`;
  const fonts = lettering.fonts || [];
  const styles = lettering.styles || [];
  const fontTick = usePreviewFonts(lettering.fonts);
  const saved = useMemo(() => normalizeCoverDesign(art.design, { fonts }), [art.design, lettering.fonts]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edits, setEdits] = useState({});
  const design = normalizeCoverDesign({ ...saved, ...edits }, { fonts });
  const dirty = JSON.stringify(design) !== JSON.stringify(saved);
  const set = (key, value) => setEdits((prev) => ({ ...prev, [key]: value }));

  const artist = (tag || '').trim();
  const [pickedStyle, setPickedStyle] = useState('');
  const chosenStyle = styles.find((s) => s.key === pickedStyle) || styles.find((s) => s.key === artist.toLowerCase().replace(/\s+/g, ' ')) || null;

  const designKey = JSON.stringify(design);
  const svg = useMemo(() => {
    const widths = canvasCoverWidths(design, { title, tag, size: COVER_ART_SIZE }, fonts);
    return coverOverlaySvg({ title, tag, design, widths, fonts });
  }, [designKey, title, tag, lettering.fonts, fontTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const choices = (key) => (key === 'typeface' ? coverTypefaceChoices(fonts) : COVER_DESIGN_OPTIONS[key]);
  const choiceLabel = (key, value) => (key === 'typeface' ? (fonts.find((f) => `font:${f.id}` === value)?.family || humanize(value)) : humanize(value));
  const onFontFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) lettering.uploadFont(file);
  };

  return (
    <details open={open} onToggle={(e) => onToggle(e.currentTarget.open)} className="rounded border border-port-border p-2 text-xs">
      <summary className="cursor-pointer text-sm font-medium flex items-center gap-1.5 min-h-[44px] sm:min-h-0"><Type size={14} /> Lettering</summary>
      <div className="mt-2 flex flex-col sm:flex-row gap-3">
        <div className="w-full sm:w-56 shrink-0 space-y-1">
          <div className="relative w-full aspect-square overflow-hidden rounded border border-port-border bg-port-bg">
            {source && <img src={source.src} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: `${focusX * 100}% 50%` }} />}
            <div role="img" aria-label={`Lettering preview for ${title || 'the cover'}`} className="absolute inset-0 [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
          <p className="text-port-text-muted">Preview. The cover is set in this when you save.</p>
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {FIELDS.map(([key, label]) => (
              <div key={key}>
                <label htmlFor={idFor(key)} className="block text-[11px] text-port-text-muted">{label}</label>
                <select id={idFor(key)} value={design[key]} onChange={(e) => set(key, e.target.value)} className={control}>
                  {choices(key).map((value) => <option key={value} value={value}>{choiceLabel(key, value)}</option>)}
                </select>
              </div>
            ))}
            <div>
              <label htmlFor={idFor('titleColor')} className="block text-[11px] text-port-text-muted">Title color</label>
              <input id={idFor('titleColor')} type="color" value={design.titleColor} onChange={(e) => set('titleColor', e.target.value)} className={`${control} p-0.5`} />
            </div>
            <div>
              <label htmlFor={idFor('accentColor')} className="block text-[11px] text-port-text-muted">Accent color (artist, rule, band)</label>
              <input id={idFor('accentColor')} type="color" value={design.accentColor} onChange={(e) => set('accentColor', e.target.value)} className={`${control} p-0.5`} />
            </div>
            <div>
              <label htmlFor={idFor('tracking')} className="block text-[11px] text-port-text-muted">Letter spacing</label>
              <input id={idFor('tracking')} type="range" min={-0.05} max={0.3} step={0.01} value={design.tracking} onChange={(e) => set('tracking', Number(e.target.value))} className="w-full min-h-[44px] sm:min-h-0" />
            </div>
            <label htmlFor={idFor('rule')} className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 self-end">
              <input id={idFor('rule')} type="checkbox" checked={design.rule} onChange={(e) => set('rule', e.target.checked)} />
              A thin line by the title
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => publishKit.saveCoverDesign(design)} disabled={busy || !dirty} className={button}>
              <Save size={13} /> {publishKit.savingLettering ? 'Setting the lettering…' : 'Set the lettering'}
            </button>
            {dirty && (
              <button type="button" onClick={() => setEdits({})} disabled={busy} className={button}>
                <RotateCcw size={13} /> Undo changes
              </button>
            )}
          </div>

          <div className="space-y-1 rounded border border-port-border p-2">
            <span className="text-port-text-muted">Artist style: keep one look across a set of singles</span>
            <div className="flex flex-wrap items-end gap-2">
              <button type="button" onClick={() => lettering.saveStyle({ name: artist, design })} disabled={!artist}
                className={button} title={artist ? `Save this lettering as ${artist}'s style` : 'Give the cover an artist name first'}>
                <Save size={13} /> Save as artist style
              </button>
              {styles.length > 0 && (
                <>
                  <div>
                    <label htmlFor={idFor('style')} className="block text-[11px] text-port-text-muted">Saved styles</label>
                    <select id={idFor('style')} value={chosenStyle?.key || ''} onChange={(e) => setPickedStyle(e.target.value)} className={control}>
                      <option value="" disabled>Choose an artist</option>
                      {styles.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                    </select>
                  </div>
                  <button type="button" onClick={() => publishKit.saveCoverDesign(chosenStyle.design)} disabled={busy || !chosenStyle} className={button}>
                    Apply artist style
                  </button>
                  <button type="button" onClick={() => lettering.removeStyle(chosenStyle.name)} disabled={!chosenStyle} aria-label={chosenStyle ? `Delete the style for ${chosenStyle.name}` : 'Delete the saved style'}
                    className="flex items-center text-port-text-muted hover:text-port-error disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-1 rounded border border-port-border p-2">
            <span className="text-port-text-muted">Your own typefaces (.ttf, .otf, .woff2)</span>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={idFor('font-file')} className={`${button} cursor-pointer ${lettering.uploading ? 'opacity-50' : ''}`}>
                <Upload size={13} /> {lettering.uploading ? 'Adding the font…' : 'Upload a font'}
              </label>
              <input id={idFor('font-file')} type="file" accept=".ttf,.otf,.woff2" disabled={lettering.uploading} onChange={onFontFile} className="sr-only" />
              {fonts.map((f) => (
                <span key={f.id} className="flex items-center gap-1 rounded bg-port-bg border border-port-border px-1.5 py-1">
                  {f.family}
                  <button type="button" onClick={() => lettering.removeFont(f.id)} aria-label={`Remove the font ${f.family}`} className="text-port-text-muted hover:text-port-error min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center">
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}
