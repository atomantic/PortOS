/**
 * Character Reference Sheet panel — embeds inside the universe Cast section.
 *
 * The panel reads the server's variant catalog (`GET /reference-sheet-variants`)
 * on mount and renders one self-contained row per variant. Each row tracks
 * its own in-flight render job, HEAD-poll, and completion callback so a
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
} from '../../services/apiUniverseBuilder';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import useMounted from '../../hooks/useMounted';
import { readSheetPointer, LEGACY_SHEET_VARIANT_ID } from '../../lib/sheetPointers';
import toast from '../ui/Toast';

// HEAD-poll for the rendered sheet at its destination URL, with backoff. The
// server-side onSheetComplete listener copies the gallery PNG into
// /data/image-refs/ AFTER the SSE 'completed' event fires (the listener is
// async, the event was sync), so claiming the file exists at SSE-completion
// time races and shows a 404 thumbnail. Returns true once reachable, false
// after the budget elapses, or `null` when the caller aborts (lets the
// caller distinguish "give up + warn" from "navigated away, ignore").
//
// `cache: 'no-store'` is load-bearing — without it, the browser caches a
// transient 404 and poisons subsequent <img> requests for the same URL.
async function waitForImageRef(filename, { maxMs = 3000, intervalMs = 150, signal } = {}) {
  if (!filename) return false;
  if (signal?.aborted) return null;
  const url = `/data/image-refs/${filename}`;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal })
      .catch(() => null);
    if (signal?.aborted) return null;
    if (res?.ok) return true;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return false;
}

// One self-contained render row per variant — owns its jobId + HEAD-poll
// so a render in this variant cannot collide with a parallel render of a
// different variant for the same character. Local to this module.
function VariantRow({
  variant, universeId, entry, locked, onSheetCompleted, onSheetDeleted, onOpenLightbox,
}) {
  const existing = useMemo(() => readSheetPointer(entry, variant.id), [entry, variant.id]);
  const [jobId, setJobId] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Captured at render-start so the SSE-completion handler can pass the
  // image-refs filename up to the parent — the SSE event itself names the
  // gallery copy in /data/images/, which is a different path.
  const destFilenameRef = useRef(null);
  // Prevent the completion callback from firing twice under React 18
  // StrictMode dev double-mount.
  const settledRef = useRef(null);
  // mountedRef gates the post-completion HEAD-poll callback so an unmount
  // (universe switch, parent collapse) mid-poll doesn't fire onSheetCompleted
  // against a stale entry/universe. useMounted resets on every effect setup —
  // a plain useRef(true) + cleanup-only effect leaves it false after
  // StrictMode's mount→cleanup→remount dev cycle.
  const mountedRef = useMounted();
  // Cancels the in-flight HEAD-poll loop on unmount or new render kicking off;
  // without it the loop keeps issuing requests against a dead component.
  const pollAbortRef = useRef(null);

  const { status, filename, error, progress } = useMediaJobProgress(jobId);

  useEffect(() => {
    if (!jobId) { settledRef.current = null; return; }
    if (settledRef.current === jobId) return;
    if (status === 'completed' && filename) {
      settledRef.current = jobId;
      const dest = destFilenameRef.current;
      const entryId = entry?.id;
      destFilenameRef.current = null;
      setJobId(null);
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      waitForImageRef(dest, { signal: controller.signal }).then((ok) => {
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
        if (!mountedRef.current) return;
        if (ok === null) return;
        if (ok) onSheetCompleted?.(entryId, dest, variant.id);
        else toast.error('Sheet render finished but the image never appeared — refresh to see it');
      });
    } else if (status === 'failed' || status === 'canceled') {
      settledRef.current = jobId;
      destFilenameRef.current = null;
      toast.error(`Sheet render failed: ${error || status}`);
      setJobId(null);
    }
  }, [jobId, status, filename, error, entry?.id, variant.id, onSheetCompleted, mountedRef]);

  useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

  const handleDelete = async () => {
    if (deleting || !universeId || !entry?.id || !existing) return;
    setDeleting(true);
    const result = await deleteCharacterReferenceSheet(universeId, entry.id, {
      variant: variant.id, silent: true,
    })
      .catch((err) => { toast.error(err.message || 'Failed to delete reference sheet'); return null; })
      .finally(() => { setDeleting(false); });
    if (!result) return;
    setConfirmingDelete(false);
    onSheetDeleted?.(entry.id, variant.id);
    toast.success(`Deleted ${variant.label} for ${entry.name}`);
  };

  const handleGenerate = async () => {
    if (jobId || !universeId || !entry?.id) return;
    const queued = await renderCharacterReferenceSheet(universeId, entry.id, { variant: variant.id })
      .catch((err) => { toast.error(err.message || 'Sheet render failed to start'); return null; });
    if (!queued?.jobId) return;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    destFilenameRef.current = queued.destFilename || null;
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
            <>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-port-error/60 text-port-error hover:bg-port-error/15 disabled:opacity-40"
              >
                {deleting ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                {deleting ? 'Deleting' : 'Delete'}
              </button>
            </>
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
          <img
            src={`/data/image-refs/${existing}`}
            alt={`${entry.name} ${variant.label}`}
            className="w-full h-auto block"
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
      console.error('Failed to load reference-sheet variant catalog', err);
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
          key={variant.id}
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
