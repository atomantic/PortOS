import { AlertTriangle, Download, HardDrive } from 'lucide-react';
import Modal from '../ui/Modal';
import { formatBytes } from '../../utils/formatters';

const VERDICT_COPY = {
  ok: null,
  tight: 'This will fit, but it will leave little free disk afterward.',
  insufficient: 'There is not enough free disk for this download. Free space and try again.',
};

/**
 * Confirm a multi-gigabyte weight download with the numbers in front of the
 * user: size, destination, and free disk. Confirm is disabled when the
 * preflight verdict is `insufficient` so a doomed transfer cannot start.
 */
export default function DownloadPreflightConfirm({
  open,
  title = 'Download model weights',
  loading = false,
  error = null,
  assessment = null,
  confirmLabel = 'Download',
  onConfirm,
  onCancel,
}) {
  const insufficient = assessment?.verdict === 'insufficient';
  const warning = VERDICT_COPY[assessment?.verdict] || null;
  const sizeKnown = Number(assessment?.expectedBytes) > 0;
  const freeKnown = Number.isFinite(assessment?.freeBytes);
  // A leftover .partial credits its own bytes toward the space this download
  // still needs, so `requiredBytes` (+ headroom) can read well under the full
  // `expectedBytes` size shown above — without calling that out, "Size 20 GB
  // / Free disk 4 GB" with Confirm enabled reads as a broken check rather
  // than a resume that only needs a few GB more.
  const requiredBytes = Number(assessment?.requiredBytes) || 0;
  const headroomBytes = Number(assessment?.headroomBytes) || 0;
  const resuming = sizeKnown && requiredBytes > 0 && requiredBytes < (assessment.expectedBytes + headroomBytes);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      ariaLabel={title}
      usePortal
    >
      <div className="rounded-xl border border-port-border bg-port-card p-4 sm:p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-port-accent/10 p-2 text-port-accent shrink-0">
            <HardDrive size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">{title}</h2>
            <p className="mt-1 text-xs text-gray-400">
              Check the size, destination, and free disk before the transfer starts.
            </p>
          </div>
        </div>

        {loading && (
          <p className="text-sm text-gray-400">Checking size and free disk…</p>
        )}

        {error && (
          <p className="text-sm text-port-error" role="alert">{error}</p>
        )}

        {!loading && !error && assessment && (
          <dl className="grid grid-cols-1 gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">Size</dt>
              <dd className="font-medium tabular-nums text-white">
                {sizeKnown ? formatBytes(assessment.expectedBytes) : 'Unknown until the transfer starts'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">Destination</dt>
              <dd className="font-medium text-gray-200 break-all text-right">{assessment.destPath || '—'}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">Free disk</dt>
              <dd className="font-medium tabular-nums text-white">
                {freeKnown ? formatBytes(assessment.freeBytes) : 'Unavailable'}
              </dd>
            </div>
            {resuming && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">Still needed</dt>
                <dd className="font-medium tabular-nums text-white">{formatBytes(requiredBytes)}</dd>
              </div>
            )}
          </dl>
        )}

        {resuming && (
          <p className="text-xs text-gray-500">Resuming — part of this download is already on disk.</p>
        )}

        {warning && (
          <p className={`flex items-start gap-2 text-xs ${insufficient ? 'text-port-error' : 'text-port-warning'}`}>
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{warning}</span>
          </p>
        )}

        {assessment?.alreadyDownloaded && (
          <p className="text-xs text-port-success">This file is already on disk.</p>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[36px] rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-300 hover:bg-port-border/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || Boolean(error) || insufficient || assessment?.alreadyDownloaded}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-port-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download size={14} />
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
