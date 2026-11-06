import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import socket from '../../services/socket.js';
import { VideoCastLinksDisclosure } from './VideoCastLinks.jsx';
import { isUsableReference, rejectedReferenceKeys } from '../../../../server/lib/catalogMediaLibrary.js';
import { musicVideoAllowsMedia } from '../../../../server/lib/musicVideoMediaPolicy.js';
import { detachCatalogIngredientMedia, listCatalogIngredientMedia } from '../../services/apiCatalog.js';
import useMounted from '../../hooks/useMounted.js';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent.js';
import MediaImage from '../MediaImage.jsx';
import CollapsibleListItem from '../ui/CollapsibleListItem.jsx';

const CATALOG_KINDS = { character: { label: 'Cast', path: '/casting' }, place: { label: 'Environments', path: '/environments' }, object: { label: 'Objects', path: '/objects' } };

const IMAGE_NAME = /^[^/\\]+\.(png|jpe?g|webp)$/i;
const BUTTON = 'min-h-[44px] rounded border border-port-border px-2 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50';

// Catalog media can live in the gallery or in image-refs; shot pickers resolve both.
// Character canon may also reference a file in its payload; its source editor
// owns correction rather than a media-row detach that would leave canon intact.
function CatalogImage({ item, index, subject, disabled, onUnlink, canUnlink = true, removing, onExited }) {
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const filename = item.mediaKey;
  return (
    <CollapsibleListItem removing={removing} onExited={onExited}>
      <div role="listitem" className="flex min-w-0 items-center gap-2 rounded border border-port-border p-1.5">
        <MediaImage src={`/data/images/${encodeURIComponent(filename)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(filename)}`}
          alt={`${subject.name} reference ${index + 1}`} className="h-16 w-16 shrink-0 rounded bg-black object-cover"
          onError={() => setMissing(true)} />
        <div className="min-w-0 space-y-1">
          <p className="break-words text-xs">{item.caption || (item.kind === 'portrait' ? 'Canonical image' : 'Reference image')}</p>
          {canUnlink ? <button type="button" className={BUTTON} disabled={disabled} aria-label={`Unlink ${subject.name} image ${index + 1} from catalog`} onClick={() => setConfirming(true)}>Unlink from catalog</button>
            : <Link className="inline-flex min-h-11 items-center text-xs text-port-accent" to={`${CATALOG_KINDS[subject.kind].path}/${encodeURIComponent(subject.ingredientId)}`}>Manage image in catalog</Link>}
          {confirming && <div className="space-y-1 text-xs">
            <p>Unlink this image from {subject.name} everywhere it is used? The catalog record and image file are kept.</p>
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => onUnlink(subject, filename)}>Confirm unlink</button>
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => setConfirming(false)}>Cancel</button>
          </div>}
          {missing && <p className="text-xs text-port-text-muted">Image is not available yet.</p>}
        </div>
      </div>
    </CollapsibleListItem>
  );
}

/** Live catalog media of the linked cast, sets and props: every shot's reference picker offers these. */
export default function CatalogLookReferences({ project, onLinked, checkin = null, catalogOnly = false, children, disabled = false }) {
  const mounted = useMounted();
  const subjects = (project.concept?.subjects || []).filter((subject) => CATALOG_KINDS[subject?.kind] && subject.name)
    .map((subject) => {
      const current = catalogOnly ? checkin?.items?.find((item) => item.subjectId === subject.id) : null;
      return current ? { ...subject, name: current.name || subject.name, ingredientId: current.ingredientId, catalogFormLabel: current.formLabel || current.formId } : subject;
    });
  const ids = JSON.stringify([...new Set(subjects.map((subject) => subject.ingredientId).filter(Boolean))].sort());
  const [loaded, setLoaded] = useState({ key: '', media: {} });
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(null);
  const pendingRef = useRef(null);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);
  const key = `${project.id}:${ids}`;
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
  useEffect(() => {
    const linked = new Set(JSON.parse(ids));
    let timer;
    const changed = (event) => {
      if (!linked.has(event?.ingredientId)) return;
      clearTimeout(timer);
      // Catalog notifications precede their transaction commit.
      timer = setTimeout(() => setRefresh((n) => n + 1), 1000);
    };
    socket.on('catalog:primitive-changed', changed);
    socket.on('catalog:assets-changed', changed);
    return () => {
      clearTimeout(timer);
      socket.off('catalog:primitive-changed', changed);
      socket.off('catalog:assets-changed', changed);
    };
  }, [ids]);
  const imageAllowed = musicVideoAllowsMedia(project, 'image');
  const media = loaded.key === key ? loaded.media : null;
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
    <section aria-label="Catalog-linked look" className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-3">
      <h3 className="text-sm font-medium">Catalog-linked look</h3>
      <p className="text-xs text-port-text-muted">Cast, environments and objects are read directly from their catalog records. Their canonical images, sheets and approved references are offered in every shot's reference picker. Correct an image at its source; changes appear here automatically.</p>
      <VideoCastLinksDisclosure summary="Manage catalog links" summaryClassName="flex min-h-[44px] cursor-pointer items-center text-sm font-medium"
        projectId={project.id} universeId={project.concept?.universeId || null} onLinked={onLinked} idPrefix={`mv-look-link-${project.id}`} />
      {children}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {!imageAllowed && <p className="text-xs text-port-text-muted">Code-only projects do not allow image references. Change the media mode to use them.</p>}
      {Object.entries(CATALOG_KINDS).map(([kind, group]) => <section key={kind} aria-label={group.label} className="min-w-0 space-y-2">
        <h4 className="text-sm font-medium">{group.label}</h4>
        {!subjects.some((subject) => subject.kind === kind) && <p className="text-xs text-port-text-muted">None linked.</p>}
        {subjects.filter((subject) => subject.kind === kind).map((subject) => {
        const rows = media?.[subject.ingredientId];
        const rejected = rejectedReferenceKeys(rows);
        const seen = new Set();
        const selected = catalogOnly ? new Set(checkin?.items?.find((item) => item.subjectId === subject.id)?.images || []) : null;
        const images = catalogOnly ? [...selected].map((filename) => (rows || []).find((row) => !row.deleted && ['portrait', 'reference'].includes(row.kind) && row.mediaKey === filename)
          || { kind: 'reference', mediaKey: filename, caption: 'Catalog reference' }) : (rows || []).filter((item) => {
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
            <div className="flex flex-wrap items-center gap-2">{subject.ingredientId ? <Link className="break-words text-xs font-medium text-port-accent" to={`${group.path}/${encodeURIComponent(subject.ingredientId)}`}>{subject.name}</Link> : <p className="text-xs">{subject.name} · Not linked. Use Manage catalog links above.</p>}{subject.catalogFormLabel && <span className="text-xs text-port-text-muted">Look: {subject.catalogFormLabel}</span>}</div>
            {!subject.ingredientId || (catalogOnly && !checkin) ? null : !media && !catalogOnly ? <p className="text-xs text-port-text-muted">Loading catalog images…</p> : rows === null && !catalogOnly ? <div className="flex flex-wrap items-center gap-2"><p className="text-xs text-port-error">Could not load these images.</p><button type="button" className={BUTTON} onClick={() => setRefresh((n) => n + 1)}>Retry</button></div>
              : <><div role="list" tabIndex={-1} className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-x-1.5">
                {images.map((item, index) => <CatalogImage key={item.mediaKey} item={item} index={index} subject={subject} disabled={disabled || Boolean(pending) || Boolean(removing)} onUnlink={unlink} canUnlink={subject.kind !== 'character' && !!rows?.some((row) => !row.deleted && row.mediaKey === item.mediaKey && ['portrait', 'reference'].includes(row.kind))} removing={removing?.key === key && removing.ingredientId === subject.ingredientId && removing.imageId === item.mediaKey} onExited={finishRemoval} />)}
              </div>{!images.length && <p className="text-xs text-port-text-muted">{imageAllowed ? "No usable images for this look." : "Catalog record linked; image references are disabled."}</p>}</>}
          </div>
        );
        })}
      </section>)}
    </section>
  );
}
