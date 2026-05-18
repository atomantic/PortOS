/**
 * Character Reference Sheet panel — embeds inside the universe Cast section.
 *
 * Shows the existing sheet (if any) as a thumbnail that opens a lightbox, plus
 * a Generate / Regenerate button that kicks off the FLUX.2 render. Subscribes
 * to media-job SSE for live progress; calls `onSheetCompleted(entryId, filename)`
 * so the parent can drop the new filename into the universe draft without
 * needing a fresh GET (the server has already persisted it).
 */

import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, RefreshCcw, ExternalLink } from 'lucide-react';
import { renderCharacterReferenceSheet } from '../../services/apiUniverseBuilder';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import toast from '../ui/Toast';

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

  const { status, filename, error, progress } = useMediaJobProgress(jobId);

  useEffect(() => {
    if (!jobId) { settledRef.current = null; return; }
    if (settledRef.current === jobId) return;
    if (status === 'completed' && filename) {
      settledRef.current = jobId;
      onSheetCompleted?.(entry.id, destFilenameRef.current);
      destFilenameRef.current = null;
      setJobId(null);
    } else if (status === 'failed' || status === 'canceled') {
      settledRef.current = jobId;
      destFilenameRef.current = null;
      toast.error(`Sheet render failed: ${error || status}`);
      setJobId(null);
    }
  }, [jobId, status, filename, error, entry?.id, onSheetCompleted]);

  const handleGenerate = async () => {
    if (jobId || !universeId || !entry?.id) return;
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
