import { useId, useState } from 'react';
import { PHOTOGRAPHY_FIELDS, VISUAL_PROFILE_TEXT_MAX, naturalUniverseVisualProfile, normalizeUniverseVisualProfile, visualProfileLook } from '../../../../server/lib/universeVisualProfile.js';
import FilmLookControls from '../media/FilmLookControls.jsx';
import FilmLookPreview from '../media/FilmLookPreview.jsx';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';

export default function UniverseVisualProfile({ value, onChange }) {
  const id = useId();
  const [image, setImage] = useState(null);
  const [picking, setPicking] = useState(false);
  const profile = normalizeUniverseVisualProfile(value);
  const generation = patch => onChange({ ...profile, generation: { ...profile.generation, ...patch } });
  const finishing = patch => onChange({ ...profile, finishing: { ...profile.finishing, ...patch } });
  return (
    <section className="space-y-3 rounded-lg border border-port-border p-3" aria-label="Universe visual profile">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-port-text">Visual profile</h3>
          <p className="text-xs text-port-text-muted">Photographic direction and optional film finishing. Save the universe to apply changes to future renders.</p>
        </div>
        <button type="button" className="min-h-[44px] rounded border border-port-border px-3 text-xs text-port-accent" onClick={() => onChange(naturalUniverseVisualProfile())}>Use Natural 35mm</button>
        {profile && <button type="button" className="min-h-[44px] px-3 text-xs text-port-text-muted" onClick={() => onChange(null)}>Remove profile</button>}
      </div>
      {profile && <>
        <label htmlFor={`${id}-generation`} className="flex items-center gap-2 text-sm text-port-text">
          <input id={`${id}-generation`} type="checkbox" checked={profile.generation.enabled} onChange={e => generation({ enabled: e.target.checked })} />Add photography direction to image prompts
        </label>
        {profile.generation.enabled && <div className="grid gap-3 md:grid-cols-2">
          {[...PHOTOGRAPHY_FIELDS, { id: 'avoid', label: 'Avoid' }].map(field => <div key={field.id}>
            <label htmlFor={`${id}-${field.id}`} className="text-xs text-port-text-muted">{field.label}</label>
            <textarea id={`${id}-${field.id}`} value={profile.generation[field.id]} maxLength={VISUAL_PROFILE_TEXT_MAX} rows={3} onChange={e => generation({ [field.id]: e.target.value })} className="w-full rounded border border-port-border bg-port-bg p-2 text-sm text-port-text" />
          </div>)}
        </div>}
        <div>
          <label htmlFor={`${id}-mode`} className="mr-2 text-xs text-port-text-muted">Film finishing</label>
          <select id={`${id}-mode`} value={profile.finishing.mode} onChange={e => finishing({ mode: e.target.value })} className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-sm text-port-text">
            <option value="off">Off</option><option value="preview">Preview only</option><option value="save">Save finished variants after generation</option>
          </select>
        </div>
        {profile.finishing.mode !== 'off' && <>
          <p className="text-xs text-port-text-muted">Original recipes, without licensed stock profiles. Ungraded originals stay available for character conditioning. The finish cannot relight a scene or recover clipped detail.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {['colorAmount', 'textureAmount'].map(key => <div key={key}>
              <label htmlFor={`${id}-${key}`} className="text-xs text-port-text-muted">{key === 'colorAmount' ? 'Color strength' : 'Texture and optics strength'}</label>
              <input id={`${id}-${key}`} type="range" min="0" max="1" step="0.01" value={profile.finishing[key]} onChange={e => finishing({ [key]: Number(e.target.value) })} className="w-full" />
            </div>)}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <FilmLookControls look={profile.finishing.look} onChange={look => finishing({ look })} compact />
            <div className="min-w-0 space-y-2">
              <button type="button" className="min-h-[44px] rounded border border-port-border px-3 text-xs text-port-accent" onClick={() => setPicking(true)}>Compare on a gallery image</button>
              {image?.filmLookFrom && <p className="text-xs text-port-text-muted">Choose an ungraded original for this comparison.</p>}
              {image && !image.filmLookFrom && <FilmLookPreview src={image.downloadUrl || image.previewUrl || `/data/images/${encodeURIComponent(image.filename)}`} look={visualProfileLook(profile)} alt="Universe film finish comparison" className="flex max-h-96 items-center justify-center overflow-hidden rounded bg-port-bg" />}
            </div>
          </div>
        </>}
      </>}
      <GalleryImagePicker open={picking} onClose={() => setPicking(false)} onSelect={item => { setImage(item); setPicking(false); }} />
    </section>
  );
}
