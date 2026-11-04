import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { isUsableReference, rejectedReferenceKeys } from '../../../../server/lib/catalogMediaLibrary.js';
import { musicVideoAllowsMedia } from '../../../../server/lib/musicVideoMediaPolicy.js';
import { listCatalogIngredientMedia } from '../../services/apiCatalog.js';
import useMounted from '../../hooks/useMounted.js';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent.js';
import { MUSIC_VIDEO_MAX_REFERENCES } from '../../lib/musicVideoUniverseRefs.js';
import { uuidv4 } from '../../lib/uuid.js';
import MediaImage from '../MediaImage.jsx';

const IMAGE_NAME = /^[^/\\]+\.(png|jpe?g|webp)$/i;
const BUTTON = 'min-h-[44px] rounded border border-port-border px-2 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50';

// Object media can also live in image-refs. Only gallery files can be saved
// into visualSpec and sent by the existing music-video reference pipeline.
function ObjectImage({ item, index, subject, present, full, disabled, onAdd }) {
  const [location, setLocation] = useState('loading');
  const filename = item.mediaKey;
  return (
    <li className="flex min-w-0 items-center gap-2 rounded border border-port-border p-1.5">
      <MediaImage src={`/data/images/${encodeURIComponent(filename)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(filename)}`}
        alt={`${subject.name} reference ${index + 1}`} className="h-16 w-16 shrink-0 rounded bg-black object-cover"
        onLoad={(event) => setLocation(event.currentTarget.src.includes('/data/images/') ? 'gallery' : 'object')}
        onError={() => setLocation('missing')} />
      <div className="min-w-0 space-y-1">
        <p className="break-words text-xs">{item.caption || (item.kind === 'portrait' ? 'Canonical image' : 'Reference image')}</p>
        {present ? <p className="text-xs text-port-text-muted">Already in look references</p> : (
          <button type="button" className={BUTTON} disabled={disabled || full || location !== 'gallery'}
            title={full ? 'The look reference list is full' : location !== 'gallery' ? 'This image must be available in the gallery' : 'Make this image available to choose for shots'}
            aria-label={`Add ${subject.name} image ${index + 1} to look references`} onClick={() => onAdd(subject, filename)}>
            Add to look references
          </button>
        )}
        {!present && location === 'object' && <p className="text-xs text-port-text-muted">Only available in Objects; add it to the gallery before using it in a shot.</p>}
        {!present && location === 'missing' && <p className="text-xs text-port-text-muted">Image is not available yet.</p>}
      </div>
    </li>
  );
}

/** Show media linked to this video's object subjects without editing the approved sheet. */
export default function LinkedObjectReferences({ project, onSaveSpec, disabled = false }) {
  const mounted = useMounted();
  const subjects = (project.concept?.subjects || []).filter((subject) => subject?.kind === 'object' && subject.ingredientId && subject.name);
  const ids = JSON.stringify([...new Set(subjects.map((subject) => subject.ingredientId))].sort());
  const [loaded, setLoaded] = useState({ key: '', media: {} });
  const [refresh, setRefresh] = useState(0);
  const [adding, setAdding] = useState(null);
  const addingRef = useRef(null);
  const key = `${project.id}:${ids}`;
  const references = project.visualSpec?.references || [];
  useVisibilityEvent((state) => { if (state === 'visible') setRefresh((n) => n + 1); });
  useEffect(() => {
    const list = JSON.parse(ids);
    if (!list.length) return undefined;
    let active = true;
    Promise.all(list.map((id) => listCatalogIngredientMedia(id, { silent: true })
      .then((media) => [id, Array.isArray(media) ? media : null], () => [id, null])))
      .then((entries) => { if (active) setLoaded({ key, media: Object.fromEntries(entries) }); });
    return () => { active = false; };
  }, [ids, key, refresh]);
  if (!subjects.length) return null;
  const present = new Set(references.map((reference) => reference.imageId));
  const full = references.length >= MUSIC_VIDEO_MAX_REFERENCES;
  const imageAllowed = musicVideoAllowsMedia(project, 'image');
  const media = loaded.key === key ? loaded.media : null;
  const add = (subject, imageId) => {
    if (disabled || full || !imageAllowed || present.has(imageId) || addingRef.current || !onSaveSpec) return;
    addingRef.current = imageId;
    setAdding(imageId);
    const finish = () => {
      addingRef.current = null;
      if (mounted.current) setAdding(null);
    };
    Promise.resolve(onSaveSpec({ references: [...references, { id: `mvr-object-${uuidv4()}`, imageId, role: 'prop', label: subject.name.slice(0, 120), condition: false }] }))
      .then(finish, finish);
  };

  return (
    <section aria-label="Linked object references" className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-3">
      <h3 className="text-sm font-medium">Linked object references</h3>
      <p className="text-xs text-port-text-muted">Images follow the objects linked to this video. Add a gallery image to look references to choose it for a shot; this is separate from the Cast &amp; Sets sheet.</p>
      {!imageAllowed && <p className="text-xs text-port-text-muted">Code-only projects do not allow image references. Change the media mode to use them.</p>}
      {full && <p className="text-xs text-port-text-muted">The look reference list is full. Remove a reference there before adding another.</p>}
      {!media ? <p className="text-xs text-port-text-muted">Loading linked object images…</p> : subjects.map((subject) => {
        const rows = media[subject.ingredientId];
        const rejected = rejectedReferenceKeys(rows);
        const seen = new Set();
        const images = (rows || []).filter((item) => {
          const formId = item?.library?.variant?.formId || null;
          const subjectFormId = subject.castForm?.id || null;
          if (!item || item.deleted || !['portrait', 'reference'].includes(item.kind) || !isUsableReference(item)
            || rejected.has(item.mediaKey) || typeof item.mediaKey !== 'string' || item.mediaKey.length > 256 || !IMAGE_NAME.test(item.mediaKey)
            || formId !== subjectFormId || seen.has(item.mediaKey)) return false;
          seen.add(item.mediaKey);
          return true;
        });
        return (
          <div key={subject.id} className="min-w-0 space-y-1">
            <Link className="break-words text-xs font-medium text-port-accent" to={`/objects/${encodeURIComponent(subject.ingredientId)}`}>{subject.name}</Link>
            {rows === null ? <div className="flex flex-wrap items-center gap-2"><p className="text-xs text-port-error">Could not load these images.</p><button type="button" className={BUTTON} onClick={() => setRefresh((n) => n + 1)}>Retry</button></div>
              : images.length ? <ul className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-1.5">
                {images.map((item, index) => <ObjectImage key={item.mediaKey} item={item} index={index} subject={subject} present={present.has(item.mediaKey)} full={full} disabled={disabled || !imageAllowed || !onSaveSpec || Boolean(adding)} onAdd={add} />)}
              </ul> : <p className="text-xs text-port-text-muted">No usable images for this look.</p>}
          </div>
        );
      })}
    </section>
  );
}
