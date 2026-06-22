/**
 * TrackRenderModal — the full detail view for a single render take.
 *
 * Opened from a TrackRenderCard's "Details" action. Shows the complete prompt,
 * the lyrics that conditioned the take (lyric-aware engines), every piece of
 * generation metadata, and a full-width player. The "Remix" action seeds the
 * generation panel with this take's settings so the user can iterate; "Use this
 * take" makes it the active render. Mirrors the image/video MediaLightbox role.
 */

import { Sparkles, CheckCircle2, Download, Trash2, X } from 'lucide-react';
import Modal from '../ui/Modal';
import { formatTimecode, timeAgo } from '../../utils/formatters';
import { trackAudioUrl } from '../../services/api';

function MetaRow({ label, children }) {
  return (
    <div className="flex gap-3 text-xs">
      <span className="w-20 shrink-0 text-gray-500 uppercase tracking-wider text-[10px] pt-0.5">{label}</span>
      <span className="flex-1 min-w-0 text-gray-300 break-words">{children}</span>
    </div>
  );
}

export default function TrackRenderModal({ render, active = false, onClose, onSelect, onRemix, onDelete }) {
  if (!render) return null;
  const { prompt, lyrics, engine, modelId, durationSec, audioFilename, createdAt } = render;
  const isUpload = !engine;

  return (
    <Modal
      open={!!render}
      onClose={onClose}
      size="lg"
      align="top"
      ariaLabelledBy="track-render-title"
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-port-border">
        <h2 id="track-render-title" className="text-sm font-semibold text-white flex items-center gap-2">
          {isUpload ? 'Uploaded take' : 'Render details'}
          {active ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-port-success">
              <CheckCircle2 size={11} aria-hidden="true" /> Active
            </span>
          ) : null}
        </h2>
        <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
        <audio controls preload="metadata" src={trackAudioUrl(audioFilename)} className="w-full">
          <track kind="captions" />
        </audio>

        <div className="space-y-1.5">
          {engine ? <MetaRow label="Engine">{engine}</MetaRow> : null}
          {modelId ? <MetaRow label="Model">{modelId}</MetaRow> : null}
          {durationSec ? <MetaRow label="Duration">{formatTimecode(durationSec)} ({durationSec}s)</MetaRow> : null}
          {createdAt ? <MetaRow label="Created">{timeAgo(createdAt)}</MetaRow> : null}
          <MetaRow label="File">{audioFilename}</MetaRow>
        </div>

        {prompt ? (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Prompt</div>
            <p className="text-xs text-gray-300 whitespace-pre-wrap break-words bg-port-bg border border-port-border rounded p-2.5">{prompt}</p>
          </div>
        ) : null}

        {lyrics ? (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Lyrics (conditioning)</div>
            <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words bg-port-bg border border-port-border rounded p-2.5 font-mono max-h-48 overflow-auto">{lyrics}</pre>
          </div>
        ) : null}
      </div>

      <div className="px-5 py-3 border-t border-port-border flex items-center justify-end gap-2 flex-wrap">
        {onDelete ? (
          <button
            type="button"
            onClick={() => onDelete(render)}
            className="mr-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-port-error hover:bg-port-error/10 text-xs"
          >
            <Trash2 size={13} /> Delete
          </button>
        ) : null}
        <a
          href={trackAudioUrl(audioFilename)}
          download
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-border hover:bg-port-border/70 text-white text-xs"
        >
          <Download size={13} /> Download
        </a>
        {onSelect && !active ? (
          <button
            type="button"
            onClick={() => onSelect(render)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-success/20 hover:bg-port-success/40 text-port-success text-xs font-medium"
          >
            <CheckCircle2 size={13} /> Use this take
          </button>
        ) : null}
        {onRemix ? (
          <button
            type="button"
            onClick={() => onRemix(render)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-xs font-medium"
          >
            <Sparkles size={13} /> Remix
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
