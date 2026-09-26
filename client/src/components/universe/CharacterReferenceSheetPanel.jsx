/**
 * Character Reference Sheet panel — embeds inside the universe Cast section.
 *
 * The panel reads the server's variant catalog (`GET /reference-sheet-variants`)
 * on mount and renders one self-contained row per variant. Each row tracks
 * its own in-flight render job and publication callback so a
 * blueprint render can be in flight while a standard sheet is showing, etc.
 * Adding a new variant on the server (e.g. 'noir') lights up a new row here
 * automatically — no client code changes needed.
 *
 * Storage shape on `entry`:
 *  - `entry.referenceSheetImageRef`  → legacy 'standard' variant
 *  - `entry.referenceSheets[<id>]`   → every other variant
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Loader2, RefreshCcw, ExternalLink, Trash2 } from 'lucide-react';
import {
  renderCharacterReferenceSheet,
  deleteCharacterReferenceSheet,
  fetchReferenceSheetVariants,
  getCharacterReferenceSheet,
} from '../../services/apiUniverseBuilder';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { useSocketResource } from '../../hooks/useSocketResource';
import useMounted from '../../hooks/useMounted';
import { readSheetPointer, LEGACY_SHEET_VARIANT_ID } from '../../lib/sheetPointers';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import MediaImage from '../MediaImage';

const SHEET_EVENTS = ['reference-sheet:changed'];

function VariantRow({
  variant, universeId, entry, locked, onSheetCompleted, onSheetDeleted, onOpenLightbox,
}) {
  const existing = useMemo(() => readSheetPointer(entry, variant.id), [entry, variant.id]);
  const [jobId, setJobId] = useState(null);
  const [requestGeneration, setRequestGeneration] = useState(0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const destFilenameRef = useRef(null);
  const pendingRef = useRef(false);
  const mountedRef = useMounted();
  const { status, error, progress } = useMediaJobProgress(jobId);
  const { data: sheet, updateData } = useSocketResource(
    () => getCharacterReferenceSheet(universeId, entry.id, variant.id, { silent: true }), {
      events: SHEET_EVENTS,
      resourceKey: `${universeId}:${entry.id}:${variant.id}:${requestGeneration}`,
      matchesEvent: data => data.universeId === universeId && data.entryId === entry.id && data.variant === variant.id,
    });

  useEffect(() => {
    if (sheet?.filename && sheet.filename !== existing) onSheetCompleted?.(entry.id, sheet.filename, variant.id);
    if (!sheet || !jobId || sheet.pendingJobId === jobId) return;
    if (sheet.filename !== destFilenameRef.current && !sheet.pendingJobId) {
      toast.error('Sheet render finished but the reference sheet could not be saved');
    }
    destFilenameRef.current = null;
    setJobId(null);
  }, [sheet, jobId, existing, entry.id, variant.id, onSheetCompleted]);

  useEffect(() => {
    if (!jobId) return;
    if (existing && existing === destFilenameRef.current) {
      destFilenameRef.current = null;
      setJobId(null);
    } else if (status === 'failed' || status === 'canceled') {
      destFilenameRef.current = null;
      toast.error(`Sheet render failed: ${error || status}`);
      setJobId(null);
    }
  }, [jobId, existing, status, error]);

  const handleDelete = async () => {
    if (deleting || !universeId || !entry?.id || !existing) return;
    setDeleting(true);
    const result = await deleteCharacterReferenceSheet(universeId, entry.id, {
      variant: variant.id, silent: true,
    })
      .catch((err) => { toast.error(err.message || 'Failed to delete reference sheet'); return null; })
      .finally(() => { setDeleting(false); });
    if (!result) return;
    updateData({ filename: null, pendingJobId: null });
    setConfirmingDelete(false);
    onSheetDeleted?.(entry.id, variant.id);
    toast.success(`Deleted ${variant.label} for ${entry.name}`);
  };

  const handleGenerate = async () => {
    if (jobId || pendingRef.current || !universeId || !entry?.id) return;
    pendingRef.current = true;
    const queued = await renderCharacterReferenceSheet(universeId, entry.id, { variant: variant.id }, { silent: true })
      .catch((err) => { if (mountedRef.current) toast.error(err.message || 'Sheet render failed to start'); return null; });
    pendingRef.current = false;
    if (!mountedRef.current) return;
    if (!queued?.jobId) return;

    destFilenameRef.current = queued.destFilename || null;
    setRequestGeneration(generation => generation + 1);
    setJobId(queued.jobId);
    toast.success(`Rendering ${variant.label.toLowerCase()} for ${entry.name}…`);
  };

  const inFlight = !!jobId;
  const pctLabel = inFlight && typeof progress === 'number'
    ? ` ${Math.round(progress * 100)}%`
    : '';

  return (
    <div className="rounded border border-port-border bg-port-bg/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-500" title={variant.description || ''}>
          <Camera size={11} />
          {variant.label}
        </div>
        <div className="flex items-center gap-1">
          {confirmingDelete ? (
            <ConfirmButtonPair
              confirmIcon={Trash2}
              busy={deleting}
              busyText="Deleting"
              onConfirm={handleDelete}
              onCancel={() => setConfirmingDelete(false)}
            />
          ) : (
            <>
              {existing && !inFlight ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={locked}
                  title={locked
                    ? `Unlock ${entry.name} to delete this sheet`
                    : `Delete the ${variant.label.toLowerCase()}`}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-400 hover:border-port-error/60 hover:text-port-error disabled:opacity-40"
                  aria-label={`Delete ${variant.label} for ${entry.name}`}
                >
                  <Trash2 size={10} />
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={inFlight || locked}
                title={locked
                  ? `Unlock ${entry.name} to render this sheet`
                  : (existing ? `Regenerate the ${variant.label.toLowerCase()}` : `Generate a ${variant.label.toLowerCase()}`)}
                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
              >
                {inFlight
                  ? <Loader2 size={10} className="animate-spin" />
                  : (existing ? <RefreshCcw size={10} /> : <Camera size={10} />)}
                {inFlight
                  ? `Rendering${pctLabel}`
                  : (existing ? 'Regenerate' : 'Generate')}
              </button>
            </>
          )}
        </div>
      </div>
      {existing ? (
        <button
          type="button"
          onClick={() => onOpenLightbox?.(existing)}
          className="mt-2 block w-full bg-port-bg rounded overflow-hidden border border-port-border hover:border-port-accent/60 cursor-zoom-in p-0"
          title="Open sheet at full size"
        >
          {/* MediaImage handles the "this asset was peer-pushed but hasn't been
              pulled yet" case — without it, this would show a broken-image icon
              until the receiver's background pull finishes. */}
          <MediaImage
            src={`/data/image-refs/${existing}`}
            alt={`${entry.name} ${variant.label}`}
            className="w-full h-auto block"
            placeholderClassName="w-full h-32"
            loading="lazy"
          />
          <span className="flex items-center justify-center gap-1 px-2 py-1 text-[10px] text-gray-500 border-t border-port-border">
            <ExternalLink size={10} /> {existing}
          </span>
        </button>
      ) : !inFlight && variant.description ? (
        <p className="mt-1.5 text-[11px] text-gray-500 italic">
          {variant.description}
        </p>
      ) : null}
    </div>
  );
}

// Module-level catalog cache + in-flight fetch promise so the GET fires once
// per page session — every character row reads the same variant list. Without
// this, opening a 30-character cast would hammer the catalog endpoint 30
// times on initial render.
let _variantCache = null;
let _variantInflight = null;
function getVariantCatalog() {
  if (_variantCache) return Promise.resolve(_variantCache);
  if (_variantInflight) return _variantInflight;
  _variantInflight = fetchReferenceSheetVariants({ silent: true })
    .then((res) => {
      _variantCache = Array.isArray(res?.variants) ? res.variants : [];
      return _variantCache;
    })
    .catch((err) => {
      console.error(`❌ Failed to load reference-sheet variant catalog: ${err?.message || err}`);
      // Fallback to the legacy standard-only catalog so the panel still
      // works against an older server that hasn't shipped the registry yet.
      _variantCache = [{ id: LEGACY_SHEET_VARIANT_ID, label: 'Reference sheet', description: '' }];
      return _variantCache;
    })
    .finally(() => { _variantInflight = null; });
  return _variantInflight;
}

export default function CharacterReferenceSheetPanel({
  universeId, entry, locked, onSheetCompleted, onSheetDeleted, onOpenLightbox,
}) {
  const [variants, setVariants] = useState(() => _variantCache);
  const mountedRef = useMounted();
  useEffect(() => {
    if (variants) return undefined;
    let alive = true;
    getVariantCatalog().then((list) => {
      if (alive && mountedRef.current) setVariants(list);
    });
    return () => { alive = false; };
  }, [variants, mountedRef]);

  if (!variants || variants.length === 0) {
    return (
      <div className="mt-2 rounded border border-port-border bg-port-bg/50 p-2 text-[11px] text-gray-500 italic">
        Loading reference sheet variants…
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {variants.map((variant) => (
        <VariantRow
          key={`${universeId}:${entry.id}:${variant.id}`}
          variant={variant}
          universeId={universeId}
          entry={entry}
          locked={locked}
          onSheetCompleted={onSheetCompleted}
          onSheetDeleted={onSheetDeleted}
          onOpenLightbox={onOpenLightbox}
        />
      ))}
    </div>
  );
}
