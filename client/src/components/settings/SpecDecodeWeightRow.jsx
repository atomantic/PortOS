import { Check, Download, ExternalLink, Trash2, X } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import useConfirmDelete from '../../hooks/useConfirmDelete.js';
import { formatBytes } from '../../utils/formatters';

const ROLE_LABELS = { model: 'Target base model', draftModel: 'Drafter' };

/**
 * One GGUF of a speculative-decoding preset: where it goes, whether it's on
 * this machine, and the button that fetches it.
 *
 * The launcher can only ever report a missing file as a failed Start — the
 * weights are a separate multi-gigabyte download from the llama.cpp binary — so
 * this row is what turns "The base model was not found at `models/…`" into a
 * thing the user can act on without leaving the page.
 */
export default function SpecDecodeWeightRow({ entry, progress, onDownload, onCancel, onDelete, disabled }) {
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  if (!entry?.path) return null;
  const label = ROLE_LABELS[entry.role] || entry.role;
  const downloading = Boolean(progress) || entry.downloading;
  const received = progress?.received ?? entry.received ?? 0;
  const total = progress?.total ?? entry.total ?? 0;
  // An unknown total (no Content-Length behind the CDN redirect) renders as an
  // indeterminate byte counter rather than a bar stuck at 0%.
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

  return (
    <div className="bg-port-card/60 border border-port-border/60 rounded px-2.5 py-1.5 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-gray-500">{label}</p>
          <code className="text-[11px] text-gray-300 break-all">{entry.path}</code>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {entry.exists ? (
            isConfirming(entry.role) ? (
              <ConfirmButtonPair
                prompt="Delete this file?"
                confirmIcon={Trash2}
                confirmText="Yes, delete"
                busy={disabled}
                onConfirm={() => confirmDelete(() => onDelete(entry.role))}
                onCancel={cancelDelete}
              />
            ) : (
              <>
                <span className="flex items-center gap-1 text-[11px] text-port-success">
                  <Check size={12} />
                  Downloaded{entry.sizeBytes ? ` (${formatBytes(entry.sizeBytes)})` : ''}
                </span>
                {onDelete && (
                  <button
                    type="button"
                    onClick={() => requestDelete(entry.role)}
                    disabled={disabled}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-gray-500 hover:text-port-error hover:bg-port-error/10 rounded transition-colors disabled:opacity-50"
                    title={`Delete ${label.toLowerCase()} from disk to free up space`}
                  >
                    <Trash2 size={11} />
                    Delete
                  </button>
                )}
              </>
            )
          ) : downloading ? (
            <>
              <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <BrailleSpinner />
                {percent === null ? formatBytes(received) : `${percent}%`}
              </span>
              <button
                type="button"
                onClick={() => onCancel(entry.role)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-port-warning hover:bg-port-warning/10 rounded transition-colors"
                title={`Cancel download of ${label.toLowerCase()}`}
              >
                <X size={11} />
                Cancel
              </button>
            </>
          ) : entry.downloadable ? (
            <>
              <a
                href={entry.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
                title={`View ${entry.repo} on Hugging Face`}
              >
                {entry.repo} <ExternalLink size={10} />
              </a>
              <button
                type="button"
                onClick={() => onDownload(entry.role)}
                disabled={disabled}
                className="flex items-center gap-1.5 px-2 py-1 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-[11px] font-medium rounded transition-colors disabled:opacity-50"
                title={`Download ${label.toLowerCase()} from ${entry.repo} into ${entry.path}`}
              >
                <Download size={11} />
                Download
              </button>
            </>
          ) : (
            <a
              href={entry.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-port-warning hover:underline flex items-center gap-1"
              title="No single-file GGUF is published for this drafter — download one yourself and point the field at it"
            >
              Find on Hugging Face <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>
      {downloading && (
        <div className="space-y-1">
          <div className="h-1 bg-port-border/60 rounded overflow-hidden">
            <div
              className={`h-full bg-port-accent ${percent === null ? 'animate-pulse w-1/3' : 'transition-[width]'}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-500">
            {total > 0 ? `${formatBytes(received)} of ${formatBytes(total)}` : `${formatBytes(received)} downloaded`}
          </p>
        </div>
      )}
    </div>
  );
}
