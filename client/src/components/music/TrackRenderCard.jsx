/**
 * TrackRenderCard — one take in a track's render history.
 *
 * Mirrors the image/video gen MediaCard: an inline player, the prompt + the
 * generation metadata (engine / model / duration) as badges, and opt-in actions
 * (open the detail modal, make this render active, remix from its settings,
 * download, delete). The ACTIVE render — the one the top-level track pointer
 * plays — is highlighted and labelled. Action callbacks are opt-in: pass only
 * the ones the parent wants rendered.
 */

import { useState } from 'react';
import { Maximize2, Sparkles, Download, Trash2, CheckCircle2, Music2, Upload } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { formatTimecode, timeAgo } from '../../utils/formatters';
import { trackAudioUrl } from '../../services/api';

export default function TrackRenderCard({
  render,
  active = false,
  onOpen,
  onSelect,
  onRemix,
  onDelete,
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { prompt, engine, modelId, durationSec, audioFilename, createdAt } = render;
  // An uploaded take has no engine (the studio cleared the gen metadata on
  // attach) — label it so a generated vs. imported take reads at a glance.
  const isUpload = !engine;

  return (
    <div className={`bg-port-card border rounded-xl p-2.5 space-y-2 ${active ? 'border-port-accent' : 'border-port-border'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isUpload
            ? <Upload size={13} className="text-gray-500 shrink-0" aria-hidden="true" />
            : <Music2 size={13} className="text-port-accent shrink-0" aria-hidden="true" />}
          <span className="text-[11px] text-gray-500 truncate" title={audioFilename}>
            {createdAt ? timeAgo(createdAt) : audioFilename}
          </span>
        </div>
        {active ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-port-success shrink-0">
            <CheckCircle2 size={11} aria-hidden="true" /> Active
          </span>
        ) : null}
      </div>

      <audio controls preload="none" src={trackAudioUrl(audioFilename)} className="w-full h-8">
        <track kind="captions" />
      </audio>

      {prompt ? (
        <p className="text-[11px] text-gray-300 line-clamp-2" title={prompt}>{prompt}</p>
      ) : (
        <p className="text-[11px] text-gray-600 italic">{isUpload ? 'Uploaded audio' : 'No prompt'}</p>
      )}

      <div className="flex flex-wrap gap-1 text-[9px]">
        {engine ? <span className="px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded">{engine}</span> : null}
        {modelId ? <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded truncate max-w-[140px]" title={modelId}>{modelId}</span> : null}
        {durationSec ? <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{formatTimecode(durationSec)}</span> : null}
      </div>

      {confirmingDelete && onDelete ? (
        <InlineConfirmRow
          question="Delete this render?"
          confirmText="Delete"
          confirmTitle="Remove from history (audio stays in the library)"
          onConfirm={() => { setConfirmingDelete(false); onDelete(render); }}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-1">
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen(render)}
              className="flex-1 min-w-0 px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center gap-1"
              title="View details"
            >
              <Maximize2 className="w-3 h-3 shrink-0" /> <span className="truncate">Details</span>
            </button>
          ) : null}
          {onSelect && !active ? (
            <button
              type="button"
              onClick={() => onSelect(render)}
              className="shrink-0 px-1.5 py-1 bg-port-success/20 hover:bg-port-success/40 text-port-success text-[10px] rounded flex items-center justify-center gap-1"
              title="Make this the active take"
            >
              <CheckCircle2 className="w-3 h-3" /> Use
            </button>
          ) : null}
          {onRemix ? (
            <button
              type="button"
              onClick={() => onRemix(render)}
              className="shrink-0 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded flex items-center justify-center gap-1"
              title="Reuse these settings for a new render"
            >
              <Sparkles className="w-3 h-3" /> Remix
            </button>
          ) : null}
          <a
            href={trackAudioUrl(audioFilename)}
            download
            className="shrink-0 px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
            title="Download"
            aria-label="Download"
          >
            <Download className="w-3 h-3" />
          </a>
          {onDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="shrink-0 px-1.5 py-1 bg-port-error/20 hover:bg-port-error/40 text-port-error text-[10px] rounded flex items-center justify-center"
              title="Delete render"
              aria-label="Delete render"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
