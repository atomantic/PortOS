import { useState } from 'react';
import { Download, Image as ImageIcon, Sparkles } from 'lucide-react';

const MAX_SOURCES = 24;

/** Images the cover can be made from: cover images made for it, Cast & Sets renders, look references, scene frames, then kit thumbnails. */
export function coverArtSources(project) {
  const kit = project?.publishKit || {};
  const seen = new Set();
  const out = [];
  const add = (kind, filename, label) => {
    if (!filename || seen.has(`${kind}:${filename}`)) return;
    seen.add(`${kind}:${filename}`);
    out.push({ kind, filename, label, src: kind === 'thumbnail' ? `/data/video-thumbnails/${encodeURIComponent(filename)}` : `/data/images/${encodeURIComponent(filename)}` });
  };
  for (const f of kit.coverArt?.generated || []) add('image', f, 'Cover image');
  for (const [key, img] of Object.entries(project?.castAndSets?.images || {})) add('image', img?.imageId, `Cast & Sets: ${key}`);
  for (const ref of project?.visualSpec?.references || []) add('image', ref?.imageId, ref?.label || 'Look reference');
  (project?.scenes || []).forEach((scene, i) => add('image', scene?.referenceImageId, `Shot ${i + 1}${scene?.sectionLabel ? ` (${scene.sectionLabel})` : ''}`));
  (kit.thumbnails || []).forEach((f, i) => add('thumbnail', f, `Video frame ${i + 1}`));
  return out.slice(0, MAX_SOURCES);
}

/**
 * Release cover art: the square image Spotify (via DistroKid) and Suno show.
 * Any image the project has can be the source; the title and artist tag are
 * set on it by code, so the lettering stays sharp. "Make with Codex" asks an
 * image backend for a fresh source, and the cover is composed from it when it
 * lands.
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
  const [likeness, setLikeness] = useState(false);
  const busy = publishKit.composing;
  const chosen = art.source ? `${art.source.kind}:${art.source.filename}` : null;
  const look = () => ({ title: title.trim(), ...(tag !== null ? { tag: tag.trim() } : {}), focusX });
  const compose = (source) => publishKit.composeCover({ ...(source ? { source: { kind: source.kind, filename: source.filename } } : {}), ...look() });
  const generate = () => publishKit.generateCover({
    ...(notes.trim() ? { notes: notes.trim() } : {}),
    ...(likeness && art.source?.kind === 'image' ? { reference: { kind: 'image', filename: art.source.filename } } : {}),
  });

  return (
    <section aria-label="Cover art" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs">
      <h3 className="text-sm font-medium flex items-center gap-1.5"><ImageIcon size={14} /> Cover art</h3>
      <p className="text-port-text-muted">The square cover Spotify (via DistroKid) and Suno show. Pick an image, and the title and artist are set on it.</p>
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="w-full sm:w-48 shrink-0 space-y-1">
          {art.filename ? (
            <>
              <img src={`/data/video-thumbnails/${encodeURIComponent(art.filename)}`} alt={`Cover art for ${project?.name || 'the song'}`} className="w-full aspect-square object-cover rounded border border-port-border" />
              <a href={`/data/video-thumbnails/${encodeURIComponent(art.filename)}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] sm:min-h-0"><Download size={12} /> Download</a>
            </>
          ) : (
            <div className="w-full aspect-square rounded border border-dashed border-port-border flex items-center justify-center text-port-text-muted p-2 text-center">No cover yet</div>
          )}
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <div className="grid grid-cols-2 gap-2">
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
          </div>
          <div>
            <label htmlFor={idFor('focus')} className="block text-[11px] text-port-text-muted">Crop position (left to right)</label>
            <input id={idFor('focus')} type="range" min={0} max={1} step={0.05} value={focusX} onChange={(e) => setFocusX(Number(e.target.value))}
              className="w-full min-h-[44px] sm:min-h-0" />
          </div>
          <button type="button" onClick={() => compose(null)} disabled={busy || !art.source || !title.trim()}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
            {busy ? 'Setting the cover…' : 'Apply to the cover'}
          </button>
        </div>
      </div>

      {art.pending && <p role="status" className="text-port-text-muted">Making a cover image on {art.pending.mode || 'the image backend'}. The cover updates when it lands.</p>}
      {art.lastError && !art.pending && <p role="alert" className="text-port-warning">{art.lastError}</p>}

      <div className="space-y-1">
        <span className="text-port-text-muted">Cover image: pick one</span>
        {sources.length ? (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {sources.map((s) => (
              <button key={`${s.kind}:${s.filename}`} type="button" onClick={() => compose(s)} disabled={busy || !title.trim()}
                aria-pressed={chosen === `${s.kind}:${s.filename}`} aria-label={`Make the cover from ${s.label}`} title={s.label}
                className={`rounded overflow-hidden border-2 disabled:opacity-60 ${chosen === `${s.kind}:${s.filename}` ? 'border-port-accent' : 'border-transparent'}`}>
                <img src={s.src} alt="" loading="lazy" className="w-full aspect-square object-cover" />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-port-text-muted">No images yet. Build the publishing kit for video frames, or make one below.</p>
        )}
      </div>

      <div className="space-y-1 rounded border border-port-border p-2">
        <label htmlFor={idFor('notes')} className="block text-[11px] text-port-text-muted">Make a new cover image (optional: what it should show)</label>
        <textarea id={idFor('notes')} value={notes} maxLength={1500} rows={2} onChange={(e) => setNotes(e.target.value)}
          placeholder="Close-up profile of the singer under flash"
          className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
        <div className="flex flex-wrap items-center gap-3">
          {art.source?.kind === 'image' && (
            <label htmlFor={idFor('likeness')} className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0">
              <input id={idFor('likeness')} type="checkbox" checked={likeness} onChange={(e) => setLikeness(e.target.checked)} />
              Keep the likeness of the current cover image
            </label>
          )}
          {/* Never disabled by `pending`: the server tells a live render from one a restart lost. */}
          <button type="button" onClick={generate}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
            <Sparkles size={13} /> Make with Codex
          </button>
        </div>
      </div>
    </section>
  );
}
