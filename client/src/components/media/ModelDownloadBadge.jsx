// Inline "Available · 7.8 GB" / "Download (~8 GB)" badge for the image and
// video gen model pickers. Drops below the model <select> so the user can
// see — before hitting Render — whether their pick still needs a multi-GB
// HF pull. Hitting Render is NOT blocked: lazy download remains the
// fallback, so a user who just wants to fire and wait can keep doing that.
//
// Three render states:
//   1. cached     → green CheckCircle, "Available · <size>"
//   2. unknown    → grey, no CTA (model has no `repo` in the registry)
//   3. needsDl    → "↓ Download (~est)" button; while downloading, a stage
//                   label + percentage replace the button.

import { CheckCircle, Download, Loader2 } from 'lucide-react';
import { formatBytes } from '../../utils/formatters.js';

const STAGE_LABELS = {
  starting: 'Starting…',
  list: 'Fetching file list…',
  download: 'Downloading…',
};

export default function ModelDownloadBadge({
  status,         // { id, repo, cached, sizeBytes, downloading?, progress? }
  onDownload,     // () => void
  onCancel,       // () => void
  estimateLabel,  // e.g. "~8 GB" — caller derives from model entry name
}) {
  if (!status) {
    return <p className="text-[10px] text-gray-500 mt-1">Checking model cache…</p>;
  }

  // Unknown repo (custom mflux entry without `repo`) — just skip the badge
  // rather than mislead the user with "not downloaded".
  if (status.cached === null) {
    return null;
  }

  if (status.downloading) {
    const frame = status.progress || {};
    const pct = typeof frame.progress === 'number' ? Math.round(frame.progress * 100) : null;
    const stage = STAGE_LABELS[frame.stage] || (frame.type === 'log' ? 'Downloading…' : (STAGE_LABELS[frame.type] || 'Downloading…'));
    const fileLine = frame.file ? `${frame.step}/${frame.total} · ${frame.file}` : '';
    return (
      <div className="mt-1 flex items-center gap-2 text-[11px]">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-port-accent" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 text-port-accent">
            <span className="truncate">
              {stage}
              {pct != null ? ` ${pct}%` : ''}
            </span>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="text-gray-400 hover:text-white shrink-0"
              >
                Cancel
              </button>
            )}
          </div>
          {fileLine && (
            <div className="text-[10px] text-gray-500 truncate" title={fileLine}>{fileLine}</div>
          )}
          {pct != null && (
            <div className="mt-0.5 h-1 bg-port-border rounded overflow-hidden">
              <div className="h-full bg-port-accent" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (status.cached) {
    const sizeLabel = status.sizeBytes ? ` · ${formatBytes(status.sizeBytes)}` : '';
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-port-success">
        <CheckCircle className="w-3.5 h-3.5" />
        <span>Available{sizeLabel}</span>
      </p>
    );
  }

  // Not cached, not in flight — offer the inline trigger.
  return (
    <button
      type="button"
      onClick={onDownload}
      className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-port-accent hover:text-white border border-port-border hover:border-port-accent rounded px-2 py-1"
      title={status.repo ? `Pre-download ${status.repo} into ~/.cache/huggingface/hub/` : 'Pre-download model weights'}
    >
      <Download className="w-3.5 h-3.5" />
      <span>Download{estimateLabel ? ` (${estimateLabel})` : ''}</span>
    </button>
  );
}

// Pull a size estimate out of the model's display name when the registry
// embedded one (e.g. "Flux 2 Klein 4B (SDNQ 4-bit, ~8 GB @ 512px)"). The
// registry isn't required to carry a structured size field, so we just
// pluck whatever "~N GB" parenthetical the human-readable label included.
export function deriveSizeEstimate(modelName) {
  if (!modelName) return null;
  const m = String(modelName).match(/~\s*(\d+(?:\.\d+)?)\s*GB/i);
  return m ? `~${m[1]} GB` : null;
}
