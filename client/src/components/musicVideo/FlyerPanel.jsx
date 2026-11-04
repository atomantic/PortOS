import { useRef, useState } from 'react';
import { Printer, QrCode } from 'lucide-react';
import PublishCard from './PublishCard.jsx';
import useContainerWidth from '../../hooks/useContainerWidth.js';
import { FLYER_IMAGE_CHOICES, FLYER_STYLES, FLYER_TEXT_LIMITS, buildFlyerHtml, flyerImagePath, resolveFlyer } from '../../lib/musicVideoFlyer.js';
import { releaseLinkUrl } from '../../../../server/lib/musicVideoCrossLinks.js';

const PAGE_W = 816; // 8.5in at 96 CSS px per inch
const PAGE_H = 1056;
const inputClass = 'w-full rounded border border-port-border bg-port-bg p-2 text-sm';

const TEXT_FIELDS = [
  { key: 'kicker', label: 'Top line' },
  { key: 'title', label: 'Title' },
  { key: 'byline', label: 'Artist' },
  { key: 'tagline', label: 'Tagline', multiline: true },
  { key: 'scanLine', label: 'Beside the QR code' },
  { key: 'details', label: 'Small print (cast, credits, thanks)', multiline: true },
];

const QR_NOTE = {
  custom: 'The QR code opens your link.',
  youtube: 'The QR code opens the YouTube video.',
  none: 'The QR code is a dashed placeholder until the YouTube link is in. Post to YouTube here, or paste the link under Release assets, and it fills in.',
};

const isHttp = (v) => /^https?:\/\//i.test(v);

/**
 * A printable 8.5×11 black-and-white flyer with a QR code to the video. Its
 * text saves with the publish kit as edited; the QR follows the YouTube link
 * once one is recorded, unless the director gives a link of their own.
 */
export default function FlyerPanel({ project, publishKit }) {
  const kit = project?.publishKit || {};
  const youtubeUrl = releaseLinkUrl(kit, 'youtube');
  const saved = resolveFlyer(project, { youtubeUrl });
  // Only what the director typed or picked here: untouched fields keep following
  // the project (a cover built after this card mounted becomes the default image).
  const [edits, setEdits] = useState({});
  const draft = { ...saved, ...edits };
  const [saveState, setSaveState] = useState(null);
  const saveSeq = useRef(0);
  const [frameRef, frameWidth] = useContainerWidth();
  if (!project?.id || !publishKit?.saveCopy) return null;

  const urlTyped = draft.url.trim();
  const badUrl = !!urlTyped && !isHttp(urlTyped);
  // The preview shows what is typed; a half-typed link previews as no override.
  const live = { ...(kit.flyer || {}), ...edits, ...('url' in edits ? { url: badUrl ? '' : urlTyped } : {}) };
  const flyer = resolveFlyer({ ...project, publishKit: { ...kit, flyer: live } }, { youtubeUrl });
  const html = buildFlyerHtml(flyer, { origin: window.location.origin });
  const save = (patch) => {
    const seq = ++saveSeq.current;
    setSaveState('saving');
    return publishKit.saveCopy({ flyer: patch }).then((ok) => { if (seq === saveSeq.current) setSaveState(ok ? 'saved' : 'failed'); });
  };
  const edit = (key, value) => setEdits((e) => ({ ...e, [key]: value }));
  const commit = (key, value) => { if (value !== saved[key]) save({ [key]: value }); };
  const commitUrl = () => { if (!badUrl && urlTyped !== saved.url) save({ url: urlTyped }); };
  const print = () => {
    const blob = new Blob([buildFlyerHtml(flyer, { origin: window.location.origin, autoPrint: true })], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const imageChoices = FLYER_IMAGE_CHOICES.filter((c) => c.id === 'none' || c.id === draft.image || flyerImagePath(kit, c.id));
  const scale = frameWidth ? frameWidth / PAGE_W : 0;
  const idFor = (k) => `mv-flyer-${project.id}-${k}`;

  return (
    <PublishCard projectId={project.id} cardId="flyer" label="Printable flyer" icon={QrCode}
      summary={flyer.qrSource === 'none' ? 'QR waiting for the YouTube link' : 'QR ready'} defaultOpen={false}
      actions={(
        <button type="button" onClick={print}
          className="flex items-center gap-1 rounded bg-port-accent/20 text-port-accent px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
          <Printer size={13} /> Print
        </button>
      )}>
      <p className="text-port-text-muted">8.5×11, black and white. Print opens the flyer in a new tab with the print dialog; choose Save as PDF there for a file.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div ref={frameRef} className="min-w-0 md:order-last">
          <div className="relative overflow-hidden rounded border border-port-border bg-white"
            style={scale ? { height: PAGE_H * scale } : { aspectRatio: '8.5 / 11' }}>
            {scale > 0 && (
              <iframe title="Flyer preview" srcDoc={html} sandbox="allow-same-origin" tabIndex={-1}
                className="absolute left-0 top-0 border-0 pointer-events-none origin-top-left"
                style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${scale})` }} />
            )}
          </div>
        </div>
        <div className="space-y-2 min-w-0">
          <p role="status" className={flyer.qrSource === 'none' ? 'text-port-warning' : 'text-port-text-muted'}>{QR_NOTE[flyer.qrSource]}</p>
          <div className="space-y-1">
            <label htmlFor={idFor('url')} className="block font-medium">QR link (optional)</label>
            <input id={idFor('url')} type="url" inputMode="url" value={draft.url} placeholder={youtubeUrl || 'Uses the YouTube link once it is in'}
              onChange={(e) => edit('url', e.target.value)} onBlur={commitUrl} className={inputClass} />
            {badUrl && <p role="alert" className="text-port-error">Start the link with https://</p>}
          </div>
          <fieldset className="space-y-1">
            <legend className="font-medium">Look</legend>
            <div className="flex flex-wrap gap-1.5">
              {FLYER_STYLES.map((c) => (
                <button key={c.id} type="button" aria-pressed={draft.style === c.id}
                  onClick={() => { if (draft.style !== c.id) { edit('style', c.id); save({ style: c.id }); } }}
                  className={`rounded border px-3 py-2 text-sm min-h-[44px] sm:min-h-0 ${draft.style === c.id ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-port-border'}`}>
                  {c.label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1">
            <label htmlFor={idFor('image')} className="block font-medium">Image</label>
            <select id={idFor('image')} value={draft.image} onChange={(e) => { edit('image', e.target.value); save({ image: e.target.value }); }} className={inputClass}>
              {imageChoices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          {TEXT_FIELDS.map(({ key, label, multiline }) => {
            const Field = multiline ? 'textarea' : 'input';
            return (
              <div key={key} className="space-y-1">
                <label htmlFor={idFor(key)} className="block font-medium">{label}</label>
                <Field id={idFor(key)} value={draft[key]} maxLength={FLYER_TEXT_LIMITS[key]} rows={multiline ? 3 : undefined}
                  onChange={(e) => edit(key, e.target.value)} onBlur={(e) => commit(key, e.target.value)} className={inputClass} />
              </div>
            );
          })}
          {saveState && (
            <p role="status" className={`text-[11px] ${saveState === 'failed' ? 'text-port-error' : 'text-port-text-muted'}`}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'All changes saved' : 'Last change did not save. Edit the field again to retry.'}
            </p>
          )}
        </div>
      </div>
    </PublishCard>
  );
}
