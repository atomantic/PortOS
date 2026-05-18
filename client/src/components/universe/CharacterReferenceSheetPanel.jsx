/**
 * Character Reference Sheet panel — embeds inside the universe Cast section.
 *
 * Shows the existing sheet (if any) as a thumbnail that opens a lightbox, plus
 * a Generate / Regenerate button that kicks off the render. The renderer is
 * text-template-based and works across codex + local image-gen modes (the
 * user's current Image Gen setting decides). Subscribes to media-job SSE
 * for live progress; calls `onSheetCompleted(entryId, filename)` so the
 * parent can drop the new filename into the universe draft without needing
 * a fresh GET (the server has already persisted it).
 */

import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, RefreshCcw, ExternalLink } from 'lucide-react';
import { renderCharacterReferenceSheet } from '../../services/apiUniverseBuilder';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import useMounted from '../../hooks/useMounted';
import toast from '../ui/Toast';

// HEAD-poll for the rendered sheet at its destination URL, with backoff. The
// server-side onSheetComplete listener copies the gallery PNG into
// /data/image-refs/ AFTER the SSE 'completed' event fires (the listener is
// async, the event was sync), so claiming the file exists at SSE-completion
// time races and shows a 404 thumbnail. Returns true once the file is
// reachable, false after ~3s of polling, or `null` when the signal aborts
// (so the caller can distinguish "give up + warn the user" from "navigated
// away, ignore").
async function waitForImageRef(filename, { maxMs = 3000, intervalMs = 150, signal } = {}) {
  if (!filename) return false;
  if (signal?.aborted) return null;
  const url = `/data/image-refs/${filename}`;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    // cache: 'no-store' so a transient 404 isn't cached by the browser and
    // poisoning subsequent <img> tags. `signal` aborts the in-flight HEAD too
    // (not just the inter-attempt sleep).
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

export default function CharacterReferenceSheetPanel({
  universeId, entry, locked, onSheetCompleted, onOpenLightbox,
}) {
  const existing = entry?.referenceSheetImageRef || null;
  const [jobId, setJobId] = useState(null);
  // destFilename for the in-flight render — captured from the route response
  // so the SSE-completion handler can pass the real refs-dir filename up to
  // the parent without a universe refetch.
  const destFilenameRef = useRef(null);
  // Prevent the completion callback from firing twice under React 18 StrictMode
  // dev double-mount.
  const settledRef = useRef(null);
  // mountedRef gates the post-completion HEAD-poll callback so an unmount
  // (universe switch, parent collapsing the section, etc.) mid-poll doesn't
  // fire `onSheetCompleted` against a stale entry/universe. useMounted resets
  // the ref to true on every effect setup — a plain `useRef(true)` plus a
  // cleanup-only effect leaves the ref permanently false after React 18
  // StrictMode's mount→cleanup→remount cycle in dev.
  const mountedRef = useMounted();
  // Cancels the in-flight `waitForImageRef` HEAD-poll loop on unmount or on
  // a new render kicking off. Without this the loop keeps issuing requests
  // against a dead component for the full ~3s budget.
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
      // The SSE 'completed' event fires when the image-gen child exits —
      // BEFORE the server-side onSheetComplete listener has copied the
      // gallery PNG into /data/image-refs/ and stamped the character.
      // Verify the file is actually reachable before flipping the UI;
      // otherwise the <img> renders a 404 that the browser caches.
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      waitForImageRef(dest, { signal: controller.signal }).then((ok) => {
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
        if (!mountedRef.current) return;
        if (ok === null) return; // aborted — caller already moved on
        if (ok) onSheetCompleted?.(entryId, dest);
        else toast.error('Sheet render finished but the image never appeared — refresh to see it');
      });
    } else if (status === 'failed' || status === 'canceled') {
      settledRef.current = jobId;
      destFilenameRef.current = null;
      toast.error(`Sheet render failed: ${error || status}`);
      setJobId(null);
    }
  }, [jobId, status, filename, error, entry?.id, onSheetCompleted]);

  // Abort any in-flight HEAD poll when the panel unmounts.
  useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

  const handleGenerate = async () => {
    if (jobId || !universeId || !entry?.id) return;
    // Abort any in-flight HEAD poll from a previous render before kicking
    // off a new one. Without this a superseded render's poll could still
    // resolve and call `onSheetCompleted` with the stale filename — the
    // server-side supersede check skips the pointer stamp but the client
    // would have already swapped the displayed filename.
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    const queued = await renderCharacterReferenceSheet(universeId, entry.id)
      .catch((err) => { toast.error(err.message || 'Sheet render failed to start'); return null; });
    if (!queued?.jobId) return;
    destFilenameRef.current = queued.destFilename || null;
    setJobId(queued.jobId);
    toast.success(`Rendering reference sheet for ${entry.name}…`);
  };

  const inFlight = !!jobId;
  const pctLabel = inFlight && typeof progress === 'number'
    ? ` ${Math.round(progress * 100)}%`
    : '';

  return (
    <div className="mt-2 rounded border border-port-border bg-port-bg/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-500">
          <Camera size={11} />
          Reference sheet
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={inFlight || locked}
            title={locked
              ? `Unlock ${entry.name} to render a reference sheet`
              : (existing ? 'Regenerate the character reference sheet' : 'Generate a character reference sheet')}
            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
          >
            {inFlight
              ? <Loader2 size={10} className="animate-spin" />
              : (existing ? <RefreshCcw size={10} /> : <Camera size={10} />)}
            {inFlight
              ? `Rendering${pctLabel}`
              : (existing ? 'Regenerate sheet' : 'Generate sheet')}
          </button>
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
            alt={`${entry.name} reference sheet`}
            className="w-full h-auto block"
            loading="lazy"
          />
          <span className="flex items-center justify-center gap-1 px-2 py-1 text-[10px] text-gray-500 border-t border-port-border">
            <ExternalLink size={10} /> {existing}
          </span>
        </button>
      ) : !inFlight ? (
        <p className="mt-1.5 text-[11px] text-gray-500 italic">
          No reference sheet yet. Click <span className="text-gray-300">Generate sheet</span> to render a multi-view turnaround, expression progression, color palette, wardrobe + prop cards, and hand gestures — all in the universe's style.
        </p>
      ) : null}
    </div>
  );
}
