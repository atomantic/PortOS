import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Image as ImageIcon, Loader2, Sparkles, ThumbsDown, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import CatalogImagePreview from './CatalogImagePreview';
import { imageRefsSequenceKey, useCatalogPreviewSequence } from './CatalogImagePreviewProvider';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import ModelInputPreview from '../media/ModelInputPreview';
import CatalogMediaTile from './CatalogMediaTile';
import socket from '../../services/socket';
import useMounted from '../../hooks/useMounted';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { useMediaAnnotations } from '../../hooks/useMediaAnnotations';
import { LEGACY_SHEET_VARIANT_ID, readSheetPointer, listSheetPointers } from '../../lib/sheetPointers.js';
import { SHEET_ROLE_PREFIX } from '../../lib/creativeLibraries';
import { formsOf, splitSheetRole } from '../../lib/catalogForms';
import { listCatalogSheetVariants, previewCatalogSheet, renderCatalogSheet, updateCatalogIngredientMediaLibrary } from '../../services/apiCatalog';

// Universe-canon sheets live on the payload as pointers into /data/image-refs.
// `[variant, filename]` pairs, with the legacy pointer de-duplicated against a
// named variant that carries the same file.
export function pointerSheetsOf(payload) {
  const legacy = readSheetPointer(payload, LEGACY_SHEET_VARIANT_ID);
  return listSheetPointers(payload)
    .filter(({ filename }, index) => typeof filename === 'string'
      && (index === 0 && legacy || filename !== legacy))
    .map(({ variant, filename }) => [variant, filename]);
}

const universeCanonPath = (universeRef) => (universeRef?.refId
  ? `/universes/${encodeURIComponent(universeRef.refId)}#canon`
  : null);

// Media-annotation keys the viewer's good/bad rating writes: a universe sheet
// under /data/image-refs is `image-ref:<file>`, a catalog sheet is a gallery image.
const pointerRatingKey = (filename) => `image-ref:${filename}`;
const mediaRatingKey = (mediaKey) => `image:${mediaKey}`;

// `remove` (optional) is `{ armed, busy, disabled, onArm, onConfirm, onCancel }`; a sheet
// rated Bad keeps its remove control in view instead of behind hover.
function PointerSheetFigure({ variant, filename, bad = false, remove = null }) {
  return (
    <figure className={`relative group rounded border overflow-hidden bg-port-bg ${bad ? 'border-port-error/60' : 'border-port-border'}`}>
      <CatalogImagePreview src={`/data/image-refs/${encodeURIComponent(filename)}`} fallbackSrc={`/data/images/${encodeURIComponent(filename)}`} alt={`${variant} reference sheet`}
        className="w-full object-contain max-h-[420px]" />
      {bad && <BadFlag />}
      <figcaption className="text-[10px] uppercase tracking-wider text-gray-500 px-2 py-1 border-t border-port-border">
        {variant}
      </figcaption>
      {remove && (
        <div className={`port-media-overlay absolute top-1 right-1 flex gap-1 rounded transition-opacity ${bad || remove.armed ? 'opacity-100' : 'opacity-100 [@media(hover:hover)]:sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100'}`}>
          {remove.armed ? (
            <ConfirmButtonPair prompt="Remove sheet?" confirmText="Remove" cancelText="Cancel" ariaLabel="Confirm sheet removal"
              busy={remove.busy} busyText="Removing…" onConfirm={remove.onConfirm} onCancel={remove.onCancel} largeTouchTargets />
          ) : (
            <button type="button" onClick={remove.onArm} disabled={remove.disabled} title="Remove this sheet" aria-label={`Remove ${variant} sheet`}
              className="port-media-overlay-item p-2 sm:p-1 rounded hover:text-port-error">
              <Trash2 size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </figure>
  );
}

function BadFlag() {
  return (
    <span className="absolute top-1 left-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-port-error/20 text-port-error border border-port-error/40"
      title="Rated bad in the viewer: remove it so nothing picks it up again">
      <ThumbsDown size={10} aria-hidden="true" /> Rated bad
    </span>
  );
}

// The viewer's side-pane action for the open sheet: tap Remove, then confirm.
function SheetPreviewActions({ bad, busy, onRemove }) {
  const [arming, setArming] = useState(false);
  return (
    <div className="space-y-1.5">
      {bad && <p className="text-xs text-port-error">Rated bad. Remove it to take it off this record.</p>}
      <button type="button" disabled={busy} onClick={() => { if (arming) { setArming(false); onRemove(); } else setArming(true); }}
        onBlur={() => setArming(false)} title="Remove this reference sheet from the record"
        className={`flex w-full min-h-11 items-center justify-center gap-1.5 rounded border px-2 text-xs disabled:opacity-40 ${arming ? 'border-port-error bg-port-error/20 text-port-error' : 'border-port-border text-gray-300 hover:border-port-error hover:text-port-error'}`}>
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
        {arming ? 'Tap to remove' : 'Remove sheet'}
      </button>
    </div>
  );
}

// The untabbed (/catalog/character/:id) read-only view of a character's
// universe sheets, with a deep-link to the Universe Builder canon section
// (`#canon`, the anchor its hash-scroll resolves).
export function ReferenceSheetPanel({ payload, universeRef }) {
  const variants = pointerSheetsOf(payload);
  const hasSheet = variants.length > 0;
  const universePath = universeCanonPath(universeRef);
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <ImageIcon size={14} aria-hidden="true" /> Reference sheet
        </h2>
        {universePath && (
          <Link to={universePath}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            <Sparkles size={12} aria-hidden="true" />
            {hasSheet ? 'Re-render in Universe Builder' : 'Render in Universe Builder'}
            <ExternalLink size={11} aria-hidden="true" />
          </Link>
        )}
      </div>
      {hasSheet ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {variants.map(([variant, filename]) => <PointerSheetFigure key={variant} variant={variant} filename={filename} />)}
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          No reference sheet rendered yet.
          {universePath
            ? ' Render one from the linked universe (it carries the style data the renderer needs).'
            : ' Link this character to a universe to render a reference sheet from its style data.'}
        </p>
      )}
    </section>
  );
}

const SHEET_EVENT = 'reference-sheet:changed';

// One in-flight render. Binds the job's callbacks so several renders (one per
// age/look or sheet kind) can run side by side.
function SheetJob({ job, onFilename, onStatus }) {
  const handleFilename = useCallback((filename) => onFilename(job, filename), [job, onFilename]);
  const handleStatus = useCallback((status) => onStatus(job, status), [job, onStatus]);
  return (
    <li className="flex items-center gap-2 min-w-0">
      <MediaJobThumb jobId={job.jobId} label="Reference sheet" size="xs"
        onFilename={handleFilename} onStatus={handleStatus} />
      <span className="text-xs text-gray-300 truncate">{job.label}</span>
    </li>
  );
}

// The Sheets tab: universe pointer sheets plus `sheet:<variant>` catalog
// media, a variant picker, the server's preview of exactly what the render
// sends, and Generate. The render reads the SAVED record, so Generate is gated
// by `blockedReason` while the profile has unsaved edits or a save is running.
// A catalog-only render completes through MediaJobThumb (job socket events)
// and is attached optimistically via `onSheetFile` (the server hook is
// idempotent); a universe-linked character's render delegates to the canon
// renderer and lands as a payload pointer, announced by `reference-sheet:changed`.
// Renders run in the background: the form stays usable so another age/look or
// sheet kind can start while earlier ones finish; only a duplicate of a role
// already rendering is refused.
// Sheets group by form: the canonical present-story form first (universe
// pointers + `sheet:<variant>`), then each alternate age/look
// (`sheet:<variant>@<formId>`), which always renders through the catalog path.
export default function CatalogSheetsPanel({
  ingredientId, payload, universeRef, sheetMedia, missingMedia, onDetach,
  blockedReason = null, savedStamp = null, onSheetFile, onPointerSheetReady, onMediaChanged,
  onRemovePointerSheet, removingPointerSheet = null,
}) {
  const mountedRef = useMounted();
  const [variants, setVariants] = useState(null);
  const [variantsError, setVariantsError] = useState(null);
  const [variantId, setVariantId] = useState('');
  const [formId, setFormId] = useState(''); // '' = canonical
  const [starting, setStarting] = useState(false);
  const [jobs, setJobs] = useState([]); // [{ jobId, role, delegated, label }]
  const [armedDetach, setArmedDetach] = useState(null);
  const [armedPointer, setArmedPointer] = useState(null);
  const { annotations } = useMediaAnnotations();
  const ratedBad = (key) => annotations?.[key]?.rating === 'bad';

  useEffect(() => {
    let active = true;
    setVariants(null);
    setVariantsError(null);
    listCatalogSheetVariants(ingredientId, { silent: true })
      .then((r) => {
        if (!active) return;
        const list = Array.isArray(r?.variants) ? r.variants : [];
        setVariants(list);
        setVariantId((cur) => (list.some((v) => v.id === cur) ? cur : list[0]?.id || ''));
      })
      .catch((err) => {
        if (!active) return;
        setVariants([]);
        setVariantsError(err?.message || 'Failed to load sheet kinds');
      });
    return () => { active = false; };
  }, [ingredientId]);

  // `savedStamp` rides in the body only to re-run the preview after a save
  // (the server builds it from the saved record); it is stripped before the call.
  const fetchPreview = useCallback(({ savedStamp: _stamp, ...body }, options) =>
    previewCatalogSheet(ingredientId, body, options).then((r) => r?.preview ?? null), [ingredientId]);
  const forms = formsOf(payload);
  const activeFormId = forms.some((f) => f.id === formId) ? formId : '';
  const [likenessRevision, setLikenessRevision] = useState(0);
  const preview = useModelInputPreview(fetchPreview,
    { variant: variantId, ...(activeFormId ? { formId: activeFormId } : {}), savedStamp }, { enabled: !!variantId, revision: likenessRevision });

  // Leaving an image out (e.g. a multi-age collage board) keeps it on the
  // record but out of every likeness pick; the server applies it to both the
  // portrait and reference rows of that file.
  const toggleLikeness = useCallback(async (image, include) => {
    const updated = await updateCatalogIngredientMediaLibrary(ingredientId,
      { mediaKey: image.filename, kind: image.mediaKind, likeness: include }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not update reference'); return null; });
    if (!updated || !mountedRef.current) return;
    setLikenessRevision((n) => n + 1);
    onMediaChanged?.();
  }, [ingredientId, mountedRef, onMediaChanged]);

  // The page runs a universe sheet removal (`onRemovePointerSheet`) and holds
  // its in-flight file (`removingPointerSheet`), since it owns the record and
  // draft and outlives this tab.
  const removePointer = useCallback((variant, filename) => {
    setArmedPointer(null);
    return onRemovePointerSheet?.(variant, filename);
  }, [onRemovePointerSheet]);

  const dropJob = useCallback((jobId) => setJobs((cur) => cur.filter((j) => j.jobId !== jobId)), []);
  useEffect(() => {
    const delegatedJobs = jobs.filter((j) => j.delegated);
    if (!delegatedJobs.length) return undefined;
    const onChanged = (data) => {
      const job = delegatedJobs.find((j) => j.jobId === data?.jobId);
      if (!job) return;
      dropJob(data.jobId);
      if (data.status === 'ready') onPointerSheetReady?.();
      else if (data.status === 'failed') toast.error(`${job.label} render finished but the sheet could not be saved`);
    };
    socket.on(SHEET_EVENT, onChanged);
    return () => { socket.off(SHEET_EVENT, onChanged); };
  }, [jobs, dropJob, onPointerSheetReady]);

  const handleFilename = useCallback((job, filename) => {
    if (!filename || job.delegated) return;
    dropJob(job.jobId);
    onSheetFile?.(filename, job.role);
  }, [dropJob, onSheetFile]);

  const handleStatus = useCallback((job, status) => {
    if (status !== 'failed' && status !== 'canceled') return;
    dropJob(job.jobId);
    if (status === 'failed') toast.error(`${job.label} render failed`);
  }, [dropJob]);

  const variant = (variants || []).find((v) => v.id === variantId) || null;
  const renderBlocked = blockedReason || preview.error;
  const selectedRole = variant ? `${SHEET_ROLE_PREFIX}${variant.id}${activeFormId ? `@${activeFormId}` : ''}` : null;
  const selectedRendering = !!selectedRole && jobs.some((j) => j.role === selectedRole);

  const handleGenerate = async () => {
    if (!variant || renderBlocked || starting || selectedRendering) return;
    setStarting(true);
    const form = forms.find((f) => f.id === activeFormId) || null;
    const queued = await renderCatalogSheet(ingredientId, { variant: variant.id, ...(form ? { formId: form.id } : {}) }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Sheet render failed'); return null; });
    if (!mountedRef.current) return;
    setStarting(false);
    if (!queued?.jobId) {
      if (queued) toast.error('Sheet render returned no job');
      return;
    }
    const what = form ? `${variant.label} · ${form.label}` : variant.label;
    setJobs((cur) => [...cur.filter((j) => j.jobId !== queued.jobId), {
      jobId: queued.jobId,
      role: queued.role || `${SHEET_ROLE_PREFIX}${queued.variant || variant.id}${form ? `@${form.id}` : ''}`,
      delegated: queued.delegatedTo === 'universe',
      label: what,
    }]);
    toast.success(queued.delegatedTo === 'universe'
      ? `Rendering ${what} on the linked universe…`
      : `Rendering ${what}…`);
  };

  const pointerSheets = pointerSheetsOf(payload);
  const sheets = Array.isArray(sheetMedia) ? sheetMedia : [];
  const labelFor = (m) => {
    const { variant: id } = splitSheetRole(m.role, SHEET_ROLE_PREFIX);
    return (variants || []).find((v) => v.id === id)?.label || id;
  };
  const sheetsByForm = new Map();
  for (const m of sheets) {
    const key = splitSheetRole(m.role, SHEET_ROLE_PREFIX).formId || '';
    if (!sheetsByForm.has(key)) sheetsByForm.set(key, []);
    sheetsByForm.get(key).push(m);
  }
  const formLabel = (id) => forms.find((f) => f.id === id)?.label || 'Removed age or look';
  const groups = [
    { id: '', title: 'Canonical · present story', pointer: pointerSheets, items: sheetsByForm.get('') || [] },
    ...forms.map((f) => ({ id: f.id, title: [f.label, f.age].filter(Boolean).join(' · '), pointer: [], items: sheetsByForm.get(f.id) || [] })),
    ...[...sheetsByForm.keys()].filter((k) => k && !forms.some((f) => f.id === k))
      .map((k) => ({ id: k, title: formLabel(k), pointer: [], items: sheetsByForm.get(k) })),
  ];
  const universePath = universeCanonPath(universeRef);

  // The enlarged viewer steps through every sheet shown here and offers Remove.
  // One entry per file: removing a universe sheet clears every slot of this
  // record that holds the file, so two slots sharing one image remove together.
  const sheetEntries = groups.flatMap((g) => [
    ...g.pointer.map(([v, filename]) => ({ key: imageRefsSequenceKey(filename), variant: v, filename, ratingKey: pointerRatingKey(filename) })),
    ...g.items.map((m) => ({ key: m.mediaKey, media: m, ratingKey: mediaRatingKey(m.mediaKey) })),
  ]).filter((e, i, all) => all.findIndex((other) => other.key === e.key) === i);
  const sequenceKeys = sheetEntries.map((e) => e.key).join('|');
  const sequence = useMemo(() => ({
    keys: sheetEntries.map((e) => e.key),
    ingredientId,
    render: (key, { nextKey, prevKey, goTo }) => {
      const entry = sheetEntries.find((e) => e.key === key);
      if (!entry) return null;
      const remove = entry.media
        ? (onDetach && !entry.media.readOnly ? () => onDetach(entry.media.mediaKey, entry.media.kind) : null)
        : (onRemovePointerSheet ? () => removePointer(entry.variant, entry.filename) : null);
      if (!remove) return null;
      return <SheetPreviewActions key={key} bad={ratedBad(entry.ratingKey)} busy={!!removingPointerSheet}
        onRemove={async () => { goTo(nextKey ?? prevKey); await remove(); }} />;
    },
  // Dependency list is intentionally partial.
  }), [sequenceKeys, ingredientId, annotations, removingPointerSheet, onDetach, onRemovePointerSheet, removePointer]);
  useCatalogPreviewSequence(sequence);

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <ImageIcon size={14} aria-hidden="true" /> Reference sheets
        </h2>
        {universePath && (
          <Link to={universePath}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            Universe canon <ExternalLink size={11} aria-hidden="true" />
          </Link>
        )}
      </div>

      {variants === null ? (
        <p className="text-xs text-gray-500 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Loading sheet kinds…</p>
      ) : variants.length === 0 ? (
        <p className="text-xs text-gray-500">{variantsError || 'This record type has no reference sheet kinds.'}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-end gap-2 flex-wrap">
            {forms.length > 0 && (
              <div className="min-w-0 flex-1 max-w-sm">
                <label htmlFor="catalog-sheet-form" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Age or look</label>
                <select id="catalog-sheet-form" value={activeFormId} onChange={(e) => setFormId(e.target.value)}
                  className="w-full px-2 py-2 bg-port-bg border border-port-border rounded text-sm text-white focus:outline-none focus:border-port-accent">
                  <option value="">Canonical · present story</option>
                  {forms.map((f) => <option key={f.id} value={f.id}>{f.label || 'Unnamed'}</option>)}
                </select>
              </div>
            )}
            <div className="min-w-0 flex-1 max-w-sm">
              <label htmlFor="catalog-sheet-variant" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Sheet kind</label>
              <select id="catalog-sheet-variant" value={variantId} onChange={(e) => setVariantId(e.target.value)}
                className="w-full px-2 py-2 bg-port-bg border border-port-border rounded text-sm text-white focus:outline-none focus:border-port-accent">
                {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <button type="button" onClick={handleGenerate} disabled={starting || selectedRendering || !!renderBlocked || !variant}
              title={renderBlocked || (selectedRendering ? 'This sheet is already rendering' : undefined)}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium">
              {starting || selectedRendering ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
              {selectedRendering ? 'Rendering…' : 'Generate sheet'}
            </button>
          </div>
          {jobs.length > 0 && (
            <div aria-label="Sheets rendering">
              <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">Rendering {jobs.length}</p>
              <ul className="flex flex-wrap gap-3">
                {jobs.map((job) => <SheetJob key={job.jobId} job={job} onFilename={handleFilename} onStatus={handleStatus} />)}
              </ul>
            </div>
          )}
          {variant?.description && <p className="text-xs text-gray-400">{variant.description}</p>}
          {blockedReason && <p className="text-xs text-port-warning" role="status">{blockedReason}</p>}
          <ModelInputPreview preview={preview} prompt="" onToggleLikeness={onMediaChanged ? toggleLikeness : undefined} />
        </div>
      )}

      {groups.map((group) => (
        <div key={group.id || 'canonical'} className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-gray-400">{group.title}</h3>
          {group.pointer.length > 0 || group.items.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {group.pointer.map(([v, filename]) => (
                <PointerSheetFigure key={`ptr:${v}`} variant={v} filename={filename} bad={ratedBad(pointerRatingKey(filename))}
                  remove={onRemovePointerSheet ? {
                    armed: armedPointer === v,
                    busy: removingPointerSheet === filename,
                    // One removal at a time, so answers cannot arrive out of order.
                    disabled: !!removingPointerSheet,
                    onArm: () => setArmedPointer(v),
                    onConfirm: () => removePointer(v, filename),
                    onCancel: () => setArmedPointer(null),
                  } : null} />
              ))}
              {group.items.map((m) => {
                const bad = ratedBad(mediaRatingKey(m.mediaKey));
                return (
                  <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} label={labelFor(m)} contain
                    missing={missingMedia?.has?.(m.mediaKey)} onDetach={onDetach}
                    armedDetach={armedDetach} onArmDetach={setArmedDetach}
                    badge={bad ? <BadFlag /> : null} pinActions={bad} />
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-gray-500">No sheets yet.</p>
          )}
        </div>
      ))}
    </section>
  );
}
