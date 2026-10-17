import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Image as ImageIcon, Loader2, Sparkles } from 'lucide-react';
import toast from '../ui/Toast';
import MediaImage from '../MediaImage';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import ModelInputPreview from '../media/ModelInputPreview';
import CatalogMediaTile from './CatalogMediaTile';
import socket from '../../services/socket';
import useMounted from '../../hooks/useMounted';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { LEGACY_SHEET_VARIANT_ID, readSheetPointer, listSheetPointers } from '../../lib/sheetPointers.js';
import { SHEET_ROLE_PREFIX } from '../../lib/creativeLibraries';
import { listCatalogSheetVariants, previewCatalogSheet, renderCatalogSheet } from '../../services/apiCatalog';

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

function PointerSheetFigure({ variant, filename }) {
  return (
    <figure className="rounded border border-port-border overflow-hidden bg-port-bg">
      <MediaImage src={`/data/image-refs/${filename}`} alt={`${variant} reference sheet`}
        className="w-full object-contain max-h-[420px]" />
      <figcaption className="text-[10px] uppercase tracking-wider text-gray-500 px-2 py-1 border-t border-port-border">
        {variant}
      </figcaption>
    </figure>
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

// The Sheets tab: universe pointer sheets plus `sheet:<variant>` catalog
// media, a variant picker, the server's preview of exactly what the render
// sends, and Generate. The render reads the SAVED record, so Generate is gated
// by `blockedReason` while the profile has unsaved edits or a save is running.
// A catalog-only render completes through MediaJobThumb (job socket events)
// and is attached optimistically via `onSheetFile` (the server hook is
// idempotent); a universe-linked character's render delegates to the canon
// renderer and lands as a payload pointer, announced by `reference-sheet:changed`.
export default function CatalogSheetsPanel({
  ingredientId, payload, universeRef, sheetMedia, missingMedia, onDetach,
  blockedReason = null, savedStamp = null, onSheetFile, onPointerSheetReady,
}) {
  const mountedRef = useMounted();
  const [variants, setVariants] = useState(null);
  const [variantsError, setVariantsError] = useState(null);
  const [variantId, setVariantId] = useState('');
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState(null); // { jobId, role, delegated }
  const [armedDetach, setArmedDetach] = useState(null);

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
  const preview = useModelInputPreview(fetchPreview, { variant: variantId, savedStamp }, { enabled: !!variantId });

  const jobId = pending?.jobId || null;
  const delegated = !!pending?.delegated;
  useEffect(() => {
    if (!jobId || !delegated) return undefined;
    const onChanged = (data) => {
      if (data?.jobId !== jobId) return;
      setPending(null);
      if (data.status === 'ready') onPointerSheetReady?.();
      else if (data.status === 'failed') toast.error('Sheet render finished but the sheet could not be saved');
    };
    socket.on(SHEET_EVENT, onChanged);
    return () => { socket.off(SHEET_EVENT, onChanged); };
  }, [jobId, delegated, onPointerSheetReady]);

  const role = pending?.role;
  const handleFilename = useCallback((filename) => {
    if (!filename || delegated) return;
    setPending(null);
    onSheetFile?.(filename, role);
  }, [delegated, role, onSheetFile]);

  const handleStatus = useCallback((status) => {
    if (status !== 'failed' && status !== 'canceled') return;
    setPending(null);
    if (status === 'failed') toast.error('Sheet render failed');
  }, []);

  const variant = (variants || []).find((v) => v.id === variantId) || null;

  const handleGenerate = async () => {
    if (!variant || blockedReason) return;
    setStarting(true);
    const queued = await renderCatalogSheet(ingredientId, { variant: variant.id }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Sheet render failed'); return null; });
    if (!mountedRef.current) return;
    setStarting(false);
    if (!queued?.jobId) {
      if (queued) toast.error('Sheet render returned no job');
      return;
    }
    setPending({
      jobId: queued.jobId,
      role: queued.role || `${SHEET_ROLE_PREFIX}${queued.variant || variant.id}`,
      delegated: queued.delegatedTo === 'universe',
    });
    toast.success(queued.delegatedTo === 'universe'
      ? `Rendering ${variant.label} on the linked universe…`
      : `Rendering ${variant.label}…`);
  };

  const pointerSheets = pointerSheetsOf(payload);
  const sheets = Array.isArray(sheetMedia) ? sheetMedia : [];
  const labelFor = (m) => {
    const id = (m.role || '').slice(SHEET_ROLE_PREFIX.length);
    return (variants || []).find((v) => v.id === id)?.label || id;
  };
  const universePath = universeCanonPath(universeRef);
  const busy = starting || !!jobId;

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
            <div className="min-w-0 flex-1 max-w-sm">
              <label htmlFor="catalog-sheet-variant" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Sheet kind</label>
              <select id="catalog-sheet-variant" value={variantId} onChange={(e) => setVariantId(e.target.value)} disabled={busy}
                className="w-full px-2 py-2 bg-port-bg border border-port-border rounded text-sm text-white focus:outline-none focus:border-port-accent">
                {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <button type="button" onClick={handleGenerate} disabled={busy || !!blockedReason || !variant}
              title={blockedReason || undefined}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium">
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
              {jobId ? 'Rendering…' : 'Generate sheet'}
            </button>
            {jobId && (
              <MediaJobThumb jobId={jobId} label="Reference sheet" size="xs"
                onFilename={handleFilename} onStatus={handleStatus} />
            )}
          </div>
          {variant?.description && <p className="text-xs text-gray-400">{variant.description}</p>}
          {blockedReason && <p className="text-xs text-port-warning" role="status">{blockedReason}</p>}
          <ModelInputPreview preview={preview} prompt="" />
        </div>
      )}

      {pointerSheets.length > 0 || sheets.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {pointerSheets.map(([v, filename]) => <PointerSheetFigure key={`ptr:${v}`} variant={v} filename={filename} />)}
          {sheets.map((m) => (
            <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} label={labelFor(m)} contain
              missing={missingMedia?.has?.(m.mediaKey)} onDetach={onDetach}
              armedDetach={armedDetach} onArmDetach={setArmedDetach} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500">No reference sheets yet.</p>
      )}
    </section>
  );
}
