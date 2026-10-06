import { useEffect, useState } from 'react';
import { Disc3, Check, Sparkles, Wand2 } from 'lucide-react';
import { getMusicVideoSingleArtwork } from '../../services/apiMusicVideo.js';

const POSITIONS = ['top', 'center', 'bottom'];
const thumbSrc = (name) => `/data/video-thumbnails/${name}`;

/**
 * Single artwork (#10331): the song's own square cover for DistroKid. The style
 * prompt starts from the treatment, options come from the install's default
 * image backend, an adjust prompt revises one (earlier versions stay), the
 * title and artist are set by the server (never drawn by the model) at
 * 3000×3000, and nothing publishes until the director approves a composition.
 * Generation only runs on a button press.
 */
export default function SingleArtworkPanel({ project, singleArtwork: actions }) {
  const projectId = project?.id;
  const stored = project?.publishKit?.singleArtwork || null;
  const [view, setView] = useState(null);
  const [stylePrompt, setStylePrompt] = useState('');
  const [adjustPrompt, setAdjustPrompt] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [artist, setArtist] = useState('');
  const [type, setType] = useState({ position: 'bottom', color: '#ffffff', titleScale: 1, showArtist: true });
  const idFor = (s) => `mv-single-art-${projectId}-${s}`;

  // The server owns the proposed style (derived from the treatment); refetch when the stored state changes.
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    getMusicVideoSingleArtwork(projectId, { silent: true }).then((res) => {
      if (!live || !res?.singleArtwork) return;
      setView(res.singleArtwork);
      setStylePrompt(res.singleArtwork.stylePrompt);
      setType((t) => ({ ...t, ...res.singleArtwork.type }));
    }).catch(() => {});
    return () => { live = false; };
  }, [projectId, stored]);

  const options = view?.options || [];
  const selected = options.find((o) => o.id === selectedId) || options[options.length - 1] || null;
  const busy = actions?.busy;
  const approved = view?.approvedImageId || null;
  const composedFor = view?.composedOptionId === selected?.id && view?.composedPath;

  return (
    <section aria-label="Single artwork" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs">
      <h3 className="text-sm font-medium flex items-center gap-1.5"><Disc3 size={14} /> Single artwork</h3>
      <p className="text-port-text-muted">The cover DistroKid sends to Spotify. Generated with your default image backend only when you press Generate; the title and artist are set on top by PortOS. Without an approved cover, DistroKid falls back to a video thumbnail.</p>
      <div className="space-y-0.5">
        <label htmlFor={idFor('style')} className="text-[11px] text-port-text-muted">Visual style prompt</label>
        <textarea id={idFor('style')} value={stylePrompt} rows={4} maxLength={4000} onChange={(e) => setStylePrompt(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!!busy || !stylePrompt.trim()} onClick={() => actions.generate({ stylePrompt, count: 2 })}
          className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
          <Sparkles size={13} /> {busy === 'generate' ? 'Generating…' : 'Generate 2 options'}
        </button>
        {view?.proposedStylePrompt && stylePrompt !== view.proposedStylePrompt && (
          <button type="button" onClick={() => setStylePrompt(view.proposedStylePrompt)}
            className="text-port-text-muted underline min-h-[44px] sm:min-h-0 px-1">Reset to the treatment's style</button>
        )}
      </div>
      {options.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Artwork options">
            {options.map((o) => (
              <button key={o.id} type="button" onClick={() => setSelectedId(o.id)} aria-pressed={selected?.id === o.id}
                aria-label={`Artwork option ${o.kind === 'adjust' ? '(revision) ' : ''}${o.id}`}
                className={`relative rounded overflow-hidden border-2 ${selected?.id === o.id ? 'border-port-accent' : 'border-transparent'}`}>
                <img src={`/data/images/${o.filename}`} alt="" className="w-full aspect-square object-cover" />
                {approved === o.id && <span className="absolute top-1 right-1 bg-port-success text-black rounded px-1 text-[10px]">Approved</span>}
              </button>
            ))}
          </div>
          <div className="space-y-0.5">
            <label htmlFor={idFor('adjust')} className="text-[11px] text-port-text-muted">Adjust the selected option (the earlier version stays)</label>
            <div className="flex gap-2">
              <input id={idFor('adjust')} value={adjustPrompt} onChange={(e) => setAdjustPrompt(e.target.value)} placeholder="e.g. warmer light, more negative space"
                className="flex-1 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
              <button type="button" disabled={!!busy || !selected || !adjustPrompt.trim()}
                onClick={() => actions.adjust(selected.id, adjustPrompt).then((p) => { if (p) setAdjustPrompt(''); })}
                className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 text-xs min-h-[44px] sm:min-h-0">
                <Wand2 size={13} /> {busy === 'adjust' ? 'Adjusting…' : 'Adjust'}
              </button>
            </div>
          </div>
          <fieldset className="grid sm:grid-cols-4 gap-2">
            <legend className="text-[11px] text-port-text-muted">Title and artist (set by PortOS, 3000×3000)</legend>
            <div>
              <label htmlFor={idFor('artist')} className="block text-[11px] text-port-text-muted">Artist</label>
              <input id={idFor('artist')} value={artist} onChange={(e) => setArtist(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
            </div>
            <div>
              <label htmlFor={idFor('position')} className="block text-[11px] text-port-text-muted">Placement</label>
              <select id={idFor('position')} value={type.position} onChange={(e) => setType({ ...type, position: e.target.value })}
                className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0">
                {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={idFor('color')} className="block text-[11px] text-port-text-muted">Type color</label>
              <input id={idFor('color')} type="color" value={type.color} onChange={(e) => setType({ ...type, color: e.target.value })}
                className="w-full bg-port-bg border border-port-border rounded min-h-[44px] sm:min-h-0" />
            </div>
            <div>
              <label htmlFor={idFor('scale')} className="block text-[11px] text-port-text-muted">Size ({type.titleScale}×)</label>
              <input id={idFor('scale')} type="range" min="0.4" max="2" step="0.1" value={type.titleScale}
                onChange={(e) => setType({ ...type, titleScale: Number(e.target.value) })} className="w-full min-h-[44px] sm:min-h-0" />
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!!busy || !selected}
              onClick={() => actions.compose({ optionId: selected.id, artist, type: { ...type, showArtist: !!artist.trim() } })}
              className="bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
              {busy === 'compose' ? 'Composing…' : 'Compose cover'}
            </button>
            {composedFor && (
              approved === selected.id
                ? <button type="button" disabled={!!busy} onClick={actions.unapprove} className="text-port-text-muted underline min-h-[44px] sm:min-h-0 px-1">Withdraw approval</button>
                : <button type="button" disabled={!!busy} onClick={() => actions.approve(selected.id)}
                  className="flex items-center gap-1 bg-port-success/20 text-port-success disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0"><Check size={13} /> Approve for DistroKid</button>
            )}
          </div>
          {composedFor && <img src={thumbSrc(view.composedPath)} alt="Composed single artwork preview" className="w-full max-w-xs aspect-square object-cover rounded border border-port-border" />}
        </>
      )}
    </section>
  );
}
