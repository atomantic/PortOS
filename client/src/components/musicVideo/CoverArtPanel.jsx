import { useEffect, useState } from 'react';
import { Download, Image as ImageIcon, Images, Sparkles } from 'lucide-react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import useMusicVideoCoverLettering from '../../hooks/useMusicVideoCoverLettering.js';
import CoverLetteringPanel from './CoverLetteringPanel.jsx';
import PublishCard from './PublishCard.jsx';

const MAX_SOURCES = 24;

/** Images the cover can be made from: the current one, cover images made for it, Cast & Sets renders, look references, scene frames, then kit thumbnails. */
export function coverArtSources(project) {
  const kit = project?.publishKit || {};
  const seen = new Set();
  const out = [];
  const add = (kind, filename, label) => {
    if (!filename || seen.has(`${kind}:${filename}`)) return;
    seen.add(`${kind}:${filename}`);
    out.push({ kind, filename, label, src: kind === 'thumbnail' ? `/data/video-thumbnails/${encodeURIComponent(filename)}` : `/data/images/${encodeURIComponent(filename)}` });
  };
  // An image picked from history or uploaded is in none of the lists below.
  if (kit.coverArt?.source?.kind === 'image') add('image', kit.coverArt.source.filename, 'Current cover image');
  for (const f of kit.coverArt?.generated || []) add('image', f, 'Cover image');
  for (const [key, img] of Object.entries(project?.castAndSets?.images || {})) add('image', img?.imageId, `Cast & Sets: ${key}`);
  for (const ref of project?.visualSpec?.references || []) add('image', ref?.imageId, ref?.label || 'Look reference');
  (project?.scenes || []).forEach((scene, i) => add('image', scene?.referenceImageId, `Shot ${i + 1}${scene?.sectionLabel ? ` (${scene.sectionLabel})` : ''}`));
  (kit.thumbnails || []).forEach((f, i) => add('thumbnail', f, `Video frame ${i + 1}`));
  return out.slice(0, MAX_SOURCES);
}

/**
 * Release cover art: the square image DistroKid sends to the stores and Suno shows.
 * Each song has its own design: the lettering and the photo, drafted from the
 * song and steered by what the director types. "Restyle" redrafts the
 * lettering from that direction (or adjusts it); "Make a new image" asks an
 * image backend for a fresh photo (or an adjusted take on the current one).
 * Any image the project has, or any in image history (or uploaded), can be
 * the photo; the title and artist are set on it by code, so the lettering
 * stays sharp. A cover finished elsewhere is used bare ("lettering" off).
 * The Lettering section sets the song's design directly (no AI), with a live
 * preview, uploaded fonts and a saved style per artist (#10345).
 */
export default function CoverArtPanel({ project, publishKit }) {
  const art = project?.publishKit?.coverArt || {};
  const sources = coverArtSources(project);
  const idFor = (s) => `mv-cover-${project?.id}-${s}`;
  const [title, setTitle] = useState(art.title ?? project?.name ?? '');
  // null = untouched, so the server keeps the last tag (or the DistroKid artist).
  const [tag, setTag] = useState(null);
  const [focusX, setFocusX] = useState(Number.isFinite(art.focusX) ? art.focusX : 0.5);
  const [notes, setNotes] = useState('');
  const [adjustImage, setAdjustImage] = useState(false);
  const [lettering, setLettering] = useState(art.lettering !== false);
  // Follow the server: a restyle or a new photo turns lettering back on there.
  useEffect(() => { setLettering(art.lettering !== false); }, [art.lettering]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The Lettering section's open state lives here, not in the panel, which remounts whenever the saved design changes.
  const [lettersOpen, setLettersOpen] = useState(Boolean(art.source));
  const letterAssets = useMusicVideoCoverLettering({ enabled: lettering && lettersOpen });
  const busy = publishKit.composing || publishKit.designing || publishKit.requestingImage || publishKit.savingLettering;
  const chosen = art.source ? `${art.source.kind}:${art.source.filename}` : null;
  const chosenSource = sources.find((s) => `${s.kind}:${s.filename}` === chosen) || null;
  const look = () => ({ title: title.trim(), ...(tag !== null ? { tag: tag.trim() } : {}), focusX, lettering });
  const needsTitle = lettering && !title.trim();
  const compose = (source) => publishKit.composeCover({ ...(source ? { source: { kind: source.kind, filename: source.filename } } : {}), ...look() });
  const generate = () => publishKit.generateCover({
    ...(notes.trim() ? { notes: notes.trim() } : {}),
    ...(adjustImage && art.source?.kind === 'image' ? { reference: { kind: 'image', filename: art.source.filename } } : {}),
  });
  const restyle = () => publishKit.designCover(notes.trim() ? { direction: notes.trim() } : {});

  return (
    <PublishCard projectId={project?.id} cardId="cover" label="Cover art" icon={ImageIcon}
      summary={art.filename ? 'Set' : 'Not set yet'} defaultOpen={!art.filename}>
      <p className="text-port-text-muted">The square cover DistroKid sends to Spotify, Apple Music and the other stores, and Suno shows. Pick an image, and the title and artist are set on it, or use a finished cover as it is.</p>
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="w-full sm:w-48 shrink-0 space-y-1">
          {art.filename ? (
            <>
              <img src={`/data/video-thumbnails/${encodeURIComponent(art.filename)}`} alt={`Cover art for ${project?.name || 'the song'}`} className="w-full aspect-square object-cover rounded border border-port-border" />
              <a href={`/data/video-thumbnails/${encodeURIComponent(art.filename)}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] sm:min-h-0"><Download size={12} /> Download</a>
              {art.source?.filename && <p className="text-port-text-muted break-all">From {art.source.filename}</p>}
            </>
          ) : (
            <div className="w-full aspect-square rounded border border-dashed border-port-border flex items-center justify-center text-port-text-muted p-2 text-center">No cover yet</div>
          )}
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <label htmlFor={idFor('lettering')} className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0">
            <input id={idFor('lettering')} type="checkbox" checked={lettering} onChange={(e) => setLettering(e.target.checked)} />
            Set the title and artist on the image (off for a cover that already has its lettering)
          </label>
          {lettering && <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={idFor('title')} className="block text-[11px] text-port-text-muted">Title on the cover</label>
              <input id={idFor('title')} value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
            </div>
            <div>
              <label htmlFor={idFor('tag')} className="block text-[11px] text-port-text-muted">Artist tag</label>
              <input id={idFor('tag')} value={tag ?? art.tag ?? ''} maxLength={24} placeholder="Artist name" onChange={(e) => setTag(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
            </div>
          </div>}
          <div>
            <label htmlFor={idFor('focus')} className="block text-[11px] text-port-text-muted">Crop position (left to right)</label>
            <input id={idFor('focus')} type="range" min={0} max={1} step={0.05} value={focusX} onChange={(e) => setFocusX(Number(e.target.value))}
              className="w-full min-h-[44px] sm:min-h-0" />
          </div>
          <button type="button" onClick={() => compose(null)} disabled={busy || !art.source || needsTitle}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
            {busy ? 'Setting the cover…' : 'Apply to the cover'}
          </button>
        </div>
      </div>

      {art.pending && <p role="status" className="text-port-text-muted">Making a cover image on {art.pending.mode || 'the image backend'}. The cover updates when it lands.</p>}
      {art.lastError && !art.pending && <p role="alert" className="text-port-warning">{art.lastError}</p>}

      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-port-text-muted">Cover image: pick one</span>
          <button type="button" onClick={() => setPickerOpen(true)} disabled={busy || needsTitle}
            className="flex items-center gap-1 text-port-accent disabled:opacity-50 min-h-[44px] sm:min-h-0">
            <Images size={13} /> Choose from image history or upload
          </button>
        </div>
        {sources.length ? (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {sources.map((s) => (
              <button key={`${s.kind}:${s.filename}`} type="button" onClick={() => compose(s)} disabled={busy || needsTitle}
                aria-pressed={chosen === `${s.kind}:${s.filename}`} aria-label={`Make the cover from ${s.label}`} title={s.label}
                className={`rounded overflow-hidden border-2 disabled:opacity-60 ${chosen === `${s.kind}:${s.filename}` ? 'border-port-accent' : 'border-transparent'}`}>
                <img src={s.src} alt="" loading="lazy" className="w-full aspect-square object-cover" />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-port-text-muted">No images yet. Build the publishing kit for video frames, choose one from image history, or make one below.</p>
        )}
      </div>
      <GalleryImagePicker open={pickerOpen} onClose={() => setPickerOpen(false)} allowUpload
        onSelect={(item) => item?.filename && compose({ kind: 'image', filename: item.filename })} />

      {lettering && (
        <CoverLetteringPanel key={JSON.stringify(art.design ?? null)} project={project} art={art} source={chosenSource}
          title={title} tag={tag ?? art.tag ?? ''} focusX={focusX} publishKit={publishKit} lettering={letterAssets} busy={busy}
          open={lettersOpen} onToggle={setLettersOpen} />
      )}

      <div className="space-y-1 rounded border border-port-border p-2">
        {art.rationale && <p className="text-port-text-muted">This song's look: {art.rationale}</p>}
        <label htmlFor={idFor('notes')} className="block text-[11px] text-port-text-muted">
          {art.design ? 'Adjust the style or the image (optional)' : 'Style direction for this song (optional)'}
        </label>
        <textarea id={idFor('notes')} value={notes} maxLength={1500} rows={2} onChange={(e) => setNotes(e.target.value)}
          placeholder={art.design ? 'Bigger title, warmer light, less contrast' : 'Grainy black and white, tiny lowercase type'}
          className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={restyle} disabled={busy}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
            <Sparkles size={13} /> {publishKit.designing ? 'Designing…' : (art.design ? 'Restyle the lettering' : 'Design the cover')}
          </button>
          {/* Disabled only while this click is in flight, never by `pending`: the server tells a live render from one a restart lost. */}
          <button type="button" onClick={generate} disabled={busy}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
            <ImageIcon size={13} /> {publishKit.requestingImage ? (art.design ? 'Queuing the image…' : 'Designing, then queuing…') : 'Make a new image'}
          </button>
          {art.source?.kind === 'image' && (
            <label htmlFor={idFor('adjust-image')} className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0">
              <input id={idFor('adjust-image')} type="checkbox" checked={adjustImage} onChange={(e) => setAdjustImage(e.target.checked)} />
              Start from the current image
            </label>
          )}
        </div>
      </div>
    </PublishCard>
  );
}
