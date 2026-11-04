import { useEffect, useMemo, useState } from 'react';
import { Brush, Download, FlaskConical, Images, MonitorPlay, RotateCcw, X } from 'lucide-react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import SentPromptPanel from '../media/SentPromptPanel';
import { previewMusicVideoThumbnailPaint } from '../../services/apiMusicVideo.js';
import useMusicVideoCoverLettering from '../../hooks/useMusicVideoCoverLettering.js';
import { YOUTUBE_THUMBNAIL_SIZE, canvasCoverWidths, coverOverlaySvg, normalizeCoverDesign } from '../../lib/musicVideoCoverOverlay.js';
import { usePreviewFonts } from './CoverLetteringPanel.jsx';
import PublishCard from './PublishCard.jsx';
import ListLoadError from '../ui/ListLoadError';

const MAX_SOURCES = 24;
// YouTube's Test & Compare runs up to three thumbnails on a published video.
const MAX_TESTS = 3;
const button = 'flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0';
const srcFor = (kind, filename) => (kind === 'thumbnail' ? `/data/video-thumbnails/${encodeURIComponent(filename)}` : `/data/images/${encodeURIComponent(filename)}`);

/**
 * Images a thumbnail can be made from: the video's best frames (the kit keeps
 * the sharpest frame of each shot, best first), then each shot's still (clean,
 * full resolution, no lyrics drawn on it), then the cover's images and the
 * Cast & Sets renders.
 */
export function thumbnailSources(project) {
  const kit = project?.publishKit || {};
  const seen = new Set();
  const out = [];
  const add = (kind, filename, label) => {
    if (!filename || seen.has(`${kind}:${filename}`)) return;
    seen.add(`${kind}:${filename}`);
    out.push({ kind, filename, label, src: srcFor(kind, filename) });
  };
  // An image picked from history or uploaded is in none of the lists below.
  const current = kit.youtubeThumbnail?.source;
  (kit.youtubeThumbnail?.generated || []).forEach((f, i) => add('image', f, `Painted ${i + 1}`));
  if (current?.kind === 'image') add('image', current.filename, 'Current thumbnail image');
  (kit.thumbnails || []).forEach((f, i) => add('thumbnail', f, i === 0 ? 'Video frame 1 (best)' : `Video frame ${i + 1}`));
  (project?.scenes || []).forEach((scene, i) => add('image', scene?.referenceImageId, `Shot ${i + 1}${scene?.sectionLabel ? ` (${scene.sectionLabel})` : ''}`));
  if (kit.coverArt?.source?.kind === 'image') add('image', kit.coverArt.source.filename, 'Cover image');
  for (const f of kit.coverArt?.generated || []) add('image', f, 'Cover image');
  for (const [key, img] of Object.entries(project?.castAndSets?.images || {})) add('image', img?.imageId, `Cast & Sets: ${key}`);
  return out.slice(0, MAX_SOURCES);
}

/**
 * The YouTube thumbnail: any image the project has (the video's best frames,
 * a shot's still, a cover image) or one from history, cropped 16:9 with the
 * song title set large in the cover's lettering, clear of the corner where
 * YouTube shows the length. The preview lays the title out with the code the
 * server renders with (lib/musicVideoCoverOverlay.js). Tapping an image makes
 * the thumbnail from it at once; the YouTube post uploads it. "Paint the title"
 * has the image model redraw the picked image with the title painted in as
 * display lettering, for livelier type than code can set; the brief PortOS
 * adds shows as a chip with the full prompt before the send.
 */
export default function YoutubeThumbnailPanel({ project, publishKit }) {
  const kit = project?.publishKit || {};
  const thumb = kit.youtubeThumbnail || {};
  const art = kit.coverArt || {};
  const sources = thumbnailSources(project);
  const idFor = (s) => `mv-ytthumb-${project?.id}-${s}`;
  const savedTitle = thumb.title ?? art.title ?? project?.name ?? '';
  const [title, setTitle] = useState(savedTitle);
  const [focusX, setFocusX] = useState(Number.isFinite(thumb.focusX) ? thumb.focusX : 0.5);
  const [focusY, setFocusY] = useState(Number.isFinite(thumb.focusY) ? thumb.focusY : 0.5);
  const [lettering, setLettering] = useState(thumb.lettering !== false);
  const [picked, setPicked] = useState(null);
  // Follow each thumbnail the server makes (a painted one lands bare, with its own crop).
  useEffect(() => {
    if (!thumb.filename) return;
    setLettering(thumb.lettering !== false);
    setFocusX(Number.isFinite(thumb.focusX) ? thumb.focusX : 0.5);
    setFocusY(Number.isFinite(thumb.focusY) ? thumb.focusY : 0.5);
    setPicked(null);
  }, [thumb.filename]); // Dependency list is intentionally partial.
  // Which way the picked image overflows 16:9, so the one crop slider moves it the way it can go.
  const [wide, setWide] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paintNotes, setPaintNotes] = useState('');
  const [sentNotes, setSentNotes] = useState('');
  const [paintPreview, setPaintPreview] = useState(null);
  const [paintOpen, setPaintOpen] = useState(false);
  // The uploaded fonts matter only when the cover's design is set in one.
  const needsCoverFonts = lettering && String(art.design?.typeface || '').startsWith('font:');
  const letterAssets = useMusicVideoCoverLettering({ enabled: needsCoverFonts });
  const fonts = letterAssets.fonts || [];
  const fontTick = usePreviewFonts(letterAssets.fonts);
  const busy = Boolean(publishKit.composingThumbnail);

  const source = picked || (thumb.source ? { ...thumb.source, src: srcFor(thumb.source.kind, thumb.source.filename) } : null);
  const chosen = source ? `${source.kind}:${source.filename}` : null;
  const needsTitle = lettering && !title.trim();
  const look = () => ({ title: title.trim(), focusX, focusY, lettering });
  const dirty = Boolean(thumb.filename) && (title.trim() !== savedTitle || focusX !== (thumb.focusX ?? 0.5) || focusY !== (thumb.focusY ?? 0.5) || lettering !== (thumb.lettering !== false));
  const make = (s) => {
    setPicked(s);
    return publishKit.composeThumbnail({ source: { kind: s.kind, filename: s.filename }, ...look() });
  };

  const svg = useMemo(() => {
    if (!lettering || !title.trim() || (needsCoverFonts && letterAssets.fontState !== 'ready')) return '';
    const design = normalizeCoverDesign(art.design, { fonts });
    const widths = canvasCoverWidths(design, { title, tag: '', size: YOUTUBE_THUMBNAIL_SIZE, frame: 'thumbnail' }, fonts);
    return coverOverlaySvg({ title, design, size: YOUTUBE_THUMBNAIL_SIZE, frame: 'thumbnail', widths, fonts });
  }, [JSON.stringify(art.design ?? null), title, lettering, needsCoverFonts, letterAssets.fonts, letterAssets.fontState, fontTick]); // Dependency list is intentionally partial.

  const tests = Array.isArray(kit.youtubeThumbnailTests) ? kit.youtubeThumbnailTests.filter((t) => t?.filename) : [];
  const inTest = Boolean(thumb.filename) && tests.some((t) => t.filename === thumb.filename);
  const crop = wide ? focusX : focusY;
  // `pending` survives a read only while the paint is live. A restart clears a
  // dead one and sets lastError, which leaves Paint enabled. The click itself
  // stays disabled until that request returns.
  const painting = Boolean(publishKit.paintingThumbnail || thumb.pending);
  const paintTitle = title.trim();
  // The exact prompt the paint would send, from the server's own builder, refreshed as the title or the committed notes change.
  useEffect(() => {
    if (!paintOpen || !project?.id || !paintTitle) { setPaintPreview(null); return undefined; }
    let active = true;
    previewMusicVideoThumbnailPaint(project.id, { title: paintTitle, ...(sentNotes ? { notes: sentNotes } : {}) }, { silent: true })
      .then((res) => { if (active) setPaintPreview(res || null); })
      .catch(() => { if (active) setPaintPreview(null); });
    return () => { active = false; };
  }, [paintOpen, project?.id, paintTitle, sentNotes]);
  const paint = () => publishKit.paintThumbnail({ source: { kind: source.kind, filename: source.filename }, title: paintTitle, ...(paintNotes.trim() ? { notes: paintNotes.trim() } : {}) });
  const setCrop = (v) => (wide ? setFocusX(v) : setFocusY(v));

  return (
    <PublishCard projectId={project?.id} cardId="youtube-thumbnail" label="YouTube thumbnail" icon={MonitorPlay}
      summary={thumb.filename ? 'Made' : (kit.thumbnail ? 'Best video frame' : 'Not set yet')} defaultOpen={!thumb.filename}>
      <p className="text-port-text-muted">Tap an image to make the thumbnail. The title is set large in the cover's lettering, away from the corner where YouTube shows the length.</p>
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="w-full sm:w-80 shrink-0 space-y-1">
          <div className="relative w-full aspect-video overflow-hidden rounded border border-port-border bg-port-bg">
            {source ? (
              <>
                <img src={source.src} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: `${focusX * 100}% ${focusY * 100}%` }}
                  onLoad={(e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; if (w && h) setWide(w / h >= 16 / 9); }} />
                {svg && <div role="img" aria-label={`Thumbnail preview for ${title}`} className="absolute inset-0 [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: svg }} />}
              </>
            ) : kit.thumbnail ? (
              <img src={srcFor('thumbnail', kit.thumbnail)} alt="The best video frame" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-port-text-muted p-2 text-center">Build the publishing kit for video frames, or pick an image</div>
            )}
          </div>
          {needsCoverFonts && letterAssets.fontState === 'error' && <ListLoadError what="cover fonts for the preview" error={letterAssets.fontError} onRetry={letterAssets.retryFonts} />}
          {needsCoverFonts && letterAssets.fontState === 'loading' && <p role="status" className="text-port-text-muted">Loading cover fonts for the preview…</p>}
          {thumb.filename ? (
            <div className="flex flex-wrap items-center gap-3">
              <a href={`/data/video-thumbnails/${encodeURIComponent(thumb.filename)}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] sm:min-h-0"><Download size={12} /> Download</a>
              <button type="button" onClick={publishKit.clearThumbnail} disabled={busy} className="text-port-text-muted flex items-center gap-1 disabled:opacity-50 min-h-[44px] sm:min-h-0">
                <RotateCcw size={12} /> Use the best video frame instead
              </button>
            </div>
          ) : kit.thumbnail && !source && <p className="text-port-text-muted">YouTube gets this frame, bare, until you make a thumbnail.</p>}
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <label htmlFor={idFor('lettering')} className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0">
            <input id={idFor('lettering')} type="checkbox" checked={lettering} onChange={(e) => setLettering(e.target.checked)} />
            Set the title on the image
          </label>
          {lettering && (
            <div>
              <label htmlFor={idFor('title')} className="block text-[11px] text-port-text-muted">Title on the thumbnail (short reads best)</label>
              <input id={idFor('title')} value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
            </div>
          )}
          {source && (
            <div>
              <label htmlFor={idFor('crop')} className="block text-[11px] text-port-text-muted">{wide ? 'Crop position (left to right)' : 'Crop position (top to bottom)'}</label>
              <input id={idFor('crop')} type="range" min={0} max={1} step={0.05} value={crop} onChange={(e) => setCrop(Number(e.target.value))}
                className="w-full min-h-[44px] sm:min-h-0" />
            </div>
          )}
          {source && (
            <button type="button" onClick={() => make(source)} disabled={busy || needsTitle || (Boolean(thumb.filename) && !dirty)} className={button}>
              {busy ? 'Making the thumbnail…' : thumb.filename ? 'Apply to the thumbnail' : 'Make the thumbnail'}
            </button>
          )}
          {lettering && !art.design && <p className="text-port-text-muted">Set in the plain look until the cover has a design (Cover art › Lettering).</p>}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-port-text-muted">Pick an image</span>
          <button type="button" onClick={() => setPickerOpen(true)} disabled={busy || needsTitle}
            className="flex items-center gap-1 text-port-accent disabled:opacity-50 min-h-[44px] sm:min-h-0">
            <Images size={13} /> Choose from image history or upload
          </button>
        </div>
        {sources.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {sources.map((s) => (
              <button key={`${s.kind}:${s.filename}`} type="button" onClick={() => make(s)} disabled={busy || needsTitle}
                aria-pressed={chosen === `${s.kind}:${s.filename}`} aria-label={`Make the thumbnail from ${s.label}`} title={s.label}
                className={`rounded overflow-hidden border-2 disabled:opacity-60 ${chosen === `${s.kind}:${s.filename}` ? 'border-port-accent' : 'border-transparent'}`}>
                <img src={s.src} alt="" loading="lazy" className="w-full aspect-video object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
      <details open={paintOpen} onToggle={(e) => setPaintOpen(e.currentTarget.open)} className="space-y-1 rounded border border-port-border p-2">
        <summary className="cursor-pointer flex items-center gap-1 min-h-[44px] sm:min-h-0"><Brush size={13} /> Paint the title with the image model</summary>
        <p className="text-port-text-muted">Redraws the picked image with the title painted in as bold lettering. The result becomes the thumbnail when it lands.</p>
        <label htmlFor={idFor('paint-notes')} className="block text-[11px] text-port-text-muted">Lettering direction (optional)</label>
        <textarea id={idFor('paint-notes')} value={paintNotes} maxLength={1500} rows={2} onChange={(e) => setPaintNotes(e.target.value)}
          onBlur={() => setSentNotes(paintNotes.trim())} placeholder="Chrome 80s movie-poster letters with a hot pink glow"
          className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
        {paintPreview && <SentPromptPanel prompt={sentNotes} sentPrompt={paintPreview.prompt} additions={paintPreview.promptAdditions || []} />}
        <button type="button" onClick={paint} disabled={!source || busy || painting || !paintTitle} className={button}>
          <Brush size={13} /> {publishKit.paintingThumbnail ? 'Queuing…' : thumb.pending ? 'Painting…' : 'Paint the title into this image'}
        </button>
        {!source && <p className="text-port-text-muted">Pick an image above first.</p>}
        {thumb.pending && <p role="status" className="text-port-text-muted">Painting on {thumb.pending.mode || 'the image backend'}. The thumbnail updates when it lands.</p>}
        {thumb.lastError && !thumb.pending && <p role="alert" className="text-port-warning">{thumb.lastError}</p>}
      </details>

      <div className="space-y-1 rounded border border-port-border p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1"><FlaskConical size={13} /> A/B test ({tests.length} of {MAX_TESTS})</span>
          <button type="button" onClick={publishKit.addThumbnailTest} disabled={busy || !thumb.filename || dirty || inTest || tests.length >= MAX_TESTS} className={button}>
            {inTest ? 'This one is in the test' : 'Add this one to the test'}
          </button>
        </div>
        <p className="text-port-text-muted">Make a thumbnail, add it, then make the next. Upload the set in YouTube Studio under Test &amp; Compare.</p>
        {tests.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {tests.map((t, i) => (
              <div key={t.filename} className="space-y-1">
                <img src={srcFor('thumbnail', t.filename)} alt={`Test thumbnail ${i + 1}`} className="w-full aspect-video object-cover rounded border border-port-border" />
                <div className="flex items-center justify-between gap-2">
                  <a href={srcFor('thumbnail', t.filename)} download className="text-port-accent flex items-center gap-1 min-h-[44px] sm:min-h-0"><Download size={12} /> {String.fromCharCode(65 + i)}</a>
                  <button type="button" onClick={() => publishKit.removeThumbnailTest(t.filename)} aria-label={`Remove test thumbnail ${i + 1}`}
                    className="text-port-text-muted flex items-center gap-1 min-h-[44px] sm:min-h-0"><X size={12} /> Remove</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <GalleryImagePicker open={pickerOpen} onClose={() => setPickerOpen(false)} allowUpload
        onSelect={(item) => item?.filename && make({ kind: 'image', filename: item.filename, src: srcFor('image', item.filename) })} />
    </PublishCard>
  );
}
