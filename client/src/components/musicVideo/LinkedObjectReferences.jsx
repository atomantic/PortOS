import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { isUsableReference, rejectedReferenceKeys } from '../../../../server/lib/catalogMediaLibrary.js';
import { musicVideoAllowsMedia } from '../../../../server/lib/musicVideoMediaPolicy.js';
import { detachCatalogIngredientMedia, listCatalogIngredientMedia } from '../../services/apiCatalog.js';
import useMounted from '../../hooks/useMounted.js';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent.js';
import { MUSIC_VIDEO_MAX_REFERENCES } from '../../lib/musicVideoUniverseRefs.js';
import { uuidv4 } from '../../lib/uuid.js';
import MediaImage from '../MediaImage.jsx';
import CollapsibleListItem from '../ui/CollapsibleListItem.jsx';

const IMAGE_NAME = /^[^/\\]+\.(png|jpe?g|webp)$/i;
const BUTTON = 'min-h-[44px] rounded border border-port-border px-2 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50';

// Object media can also live in image-refs. Only gallery files can be saved
// into visualSpec and sent by the existing music-video reference pipeline.
function ObjectImage({ item, index, subject, present, full, disabled, addDisabled, onAdd, onRemove, onUnlink, removing, onExited }) {
  const [location, setLocation] = useState('loading');
  const [confirming, setConfirming] = useState(false);
  const filename = item.mediaKey;
  return (
    <CollapsibleListItem removing={removing} onExited={onExited}>
      <div role="listitem" className="flex min-w-0 items-center gap-2 rounded border border-port-border p-1.5">
        <MediaImage src={`/data/images/${encodeURIComponent(filename)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(filename)}`}
          alt={`${subject.name} reference ${index + 1}`} className="h-16 w-16 shrink-0 rounded bg-black object-cover"
          onLoad={(event) => setLocation(event.currentTarget.src.includes('/data/images/') ? 'gallery' : 'object')}
          onError={() => setLocation('missing')} />
        <div className="min-w-0 space-y-1">
          <p className="break-words text-xs">{item.caption || (item.kind === 'portrait' ? 'Canonical image' : 'Reference image')}</p>
          {present ? <><p className="text-xs text-port-text-muted">Already in look references</p>
            <button type="button" className={BUTTON} disabled={disabled} aria-label={`Remove ${subject.name} image ${index + 1} from look references`} onClick={() => onRemove(filename)}>Remove from look</button></> : (
            <button type="button" className={BUTTON} disabled={disabled || addDisabled || full || location !== 'gallery'}
              title={full ? 'The look reference list is full' : location !== 'gallery' ? 'This image must be available in the gallery' : 'Make this image available to choose for shots'}
              aria-label={`Add ${subject.name} image ${index + 1} to look references`} onClick={() => onAdd(subject, filename)}>
              Add to look references
            </button>
          )}
          <button type="button" className={BUTTON} disabled={disabled} aria-label={`Unlink ${subject.name} image ${index + 1} from object`} onClick={() => setConfirming(true)}>Unlink from object</button>
          {confirming && <div className="space-y-1 text-xs">
            <p>Unlink this image from {subject.name} everywhere it is used? The object and image file are kept. Existing look and shot references are unchanged.</p>
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => onUnlink(subject, filename)}>Confirm unlink</button>
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => setConfirming(false)}>Cancel</button>
          </div>}
          {!present && location === 'object' && <p className="text-xs text-port-text-muted">Only available in Objects; add it to the gallery before using it in a shot.</p>}
          {!present && location === 'missing' && <p className="text-xs text-port-text-muted">Image is not available yet.</p>}
        </div>
      </div>
    </CollapsibleListItem>
  );
}

/** Show media linked to this video's object subjects without editing the approved sheet. */
export default function LinkedObjectReferences({ project, onSaveSpec, disabled = false }) {
  const mounted = useMounted();
  const subjects = (project.concept?.subjects || []).filter((subject) => subject?.kind === 'object' && subject.ingredientId && subject.name);
  const ids = JSON.stringify([...new Set(subjects.map((subject) => subject.ingredientId))].sort());
  const [loaded, setLoaded] = useState({ key: '', media: {} });
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(null);
  const pendingRef = useRef(null);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);
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
    if (disabled || full || !imageAllowed || present.has(imageId) || pendingRef.current || removing || !onSaveSpec) return;
    pendingRef.current = imageId;
    setPending(imageId);
    const finish = () => {
      pendingRef.current = null;
      if (mounted.current) setPending(null);
    };
    Promise.resolve(onSaveSpec({ references: [...references, { id: `mvr-object-${uuidv4()}`, imageId, role: 'prop', label: subject.name.slice(0, 120), condition: false }] }))
      .then(finish, finish);
  };

  const remove = (imageId) => {
    if (disabled || pendingRef.current || removing || !onSaveSpec) return;
    pendingRef.current = imageId;
    setPending(imageId);
    setError(null);
    Promise.resolve().then(() => onSaveSpec({ references: references.filter((reference) => reference.imageId !== imageId) }))
      .catch((err) => { if (mounted.current) setError(err.message || 'Could not remove the look reference.'); })
      .finally(() => { pendingRef.current = null; if (mounted.current) setPending(null); });
  };
  const unlink = (subject, imageId) => {
    if (disabled || pendingRef.current || removing) return;
    pendingRef.current = imageId;
    setPending(imageId);
    setError(null);
    const rows = (media[subject.ingredientId] || []).filter((row) => !row.deleted && row.mediaKey === imageId && ['portrait', 'reference'].includes(row.kind));
    // Apply each successful detach even if another kind fails, so retry only
    // targets associations that remain. The API never deletes the source file.
    const detached = new Set();
    rows.reduce((chain, row) => chain.then(() => detachCatalogIngredientMedia(subject.ingredientId, { mediaKey: imageId, kind: row.kind }, { silent: true }))
      .then(() => { detached.add(row.kind); }), Promise.resolve())
      .then(() => { if (mounted.current) setRemoving({ key, ingredientId: subject.ingredientId, imageId }); })
      .catch((err) => {
        if (!mounted.current) return;
        setLoaded((prev) => prev.key !== key ? prev : { ...prev, media: { ...prev.media, [subject.ingredientId]: prev.media[subject.ingredientId].filter((row) => row.mediaKey !== imageId || !detached.has(row.kind)) } });
        setError(err.message || 'Could not unlink the image. Try again.');
      })
      .finally(() => { pendingRef.current = null; if (mounted.current) setPending(null); });
  };
  const finishRemoval = () => {
    if (!removing) return;
    setLoaded((prev) => prev.key !== removing.key ? prev : { ...prev, media: { ...prev.media, [removing.ingredientId]: prev.media[removing.ingredientId].filter((row) => row.mediaKey !== removing.imageId) } });
    setRemoving(null);
  };

  return (
    <section aria-label="Linked object references" className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-3">
      <h3 className="text-sm font-medium">Linked object references</h3>
      <p className="text-xs text-port-text-muted">Images follow the objects linked to this video. Add a gallery image to look references to choose it for a shot; this is separate from the Cast &amp; Sets sheet.</p>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
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
              : <><div role="list" tabIndex={-1} className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-x-1.5">
                {images.map((item, index) => <ObjectImage key={item.mediaKey} item={item} index={index} subject={subject} present={present.has(item.mediaKey)} full={full} disabled={disabled || !onSaveSpec || Boolean(pending) || Boolean(removing)} addDisabled={!imageAllowed} onAdd={add} onRemove={remove} onUnlink={unlink} removing={removing?.key === key && removing.ingredientId === subject.ingredientId && removing.imageId === item.mediaKey} onExited={finishRemoval} />)}
              </div>{!images.length && <p className="text-xs text-port-text-muted">No usable images for this look.</p>}</>}
          </div>
        );
      })}
    </section>
  );
}
