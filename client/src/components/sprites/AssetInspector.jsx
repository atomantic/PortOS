/**
 * Asset inspector (#2930 phase 2) — replaces the bare lightbox that rendered a
 * transparent PNG against plain black with no way to learn anything about it.
 *
 * Shows a checkerboarded, pixel-preserving preview plus the metadata the
 * pipeline actually needs when debugging a sprite (record-relative path,
 * dimensions, format, frame count, size, mtime) and the two actions that were
 * missing entirely: Download and Copy path. Modal supplies the backdrop, Esc
 * handling, focus trap, and focus restore to the thumbnail that opened it.
 */

import { useEffect, useState } from 'react';
import { Download, ClipboardCopy, ExternalLink, Trash2, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import SpritePreview from './SpritePreview.jsx';
import { spriteAssetUrl, hasSpritePreview, isVideoAsset } from './spriteAssets.js';
import { isRuntimeVersionPath, isRuntimeSidecarManifest } from '../../lib/spriteFacets.js';
import { formatBytes, timeAgo } from '../../utils/formatters.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { deleteSpriteAsset } from '../../services/apiSprites.js';

function Row({ label, value }) {
  // `frameCount: 0` is meaningful, so only null/undefined/'' are omitted.
  if (value === null || value === undefined || value === '') return null;
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-200 break-all">{value}</dd>
    </>
  );
}

export default function AssetInspector({ recordId, asset, onClose, onDeleted = null }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Reset per-open: switching which asset is inspected (or closing) clears any
  // half-armed confirm / stale error from the previously-inspected asset.
  const assetPath = asset?.path ?? null;
  useEffect(() => {
    setConfirming(false);
    setDeleteError(null);
  }, [assetPath]);

  if (!asset) return null;

  const url = spriteAssetUrl(recordId, asset.path);
  const fileName = asset.path.split('/').pop();
  const previewable = hasSpritePreview(asset);
  // A runtime version lives in `runtime/vN/` as an atlas PNG + its sidecar
  // manifest, deleted together as a unit by the server. Reuse the classifier's
  // grammar (spriteFacets) so this stays one definition — the delete copy fires
  // for either half; the note only for the manifest sidecar.
  const isRuntimeVersionFile = isRuntimeVersionPath(asset.path);
  const isRuntimeManifest = isRuntimeSidecarManifest(asset.path);

  const runDelete = () => {
    setDeleting(true);
    setDeleteError(null);
    // Custom inline error UI below → silence request()'s auto-toast.
    deleteSpriteAsset(recordId, asset.path, { silent: true })
      .then(() => { onDeleted?.(); onClose?.(); })
      .catch((err) => setDeleteError(err?.message || 'Delete failed'))
      .finally(() => setDeleting(false));
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      ariaLabel={`Asset ${asset.path}`}
      // The dialog panel needs its own opaque fill — without it the metadata
      // and buttons render straight onto the semi-transparent backdrop and the
      // page bleeds through, making the text unreadable (matches the imagegen
      // MediaLightbox, which pairs a denser backdrop with a solid card).
      backdropClassName="bg-black/90"
      panelClassName="bg-port-card border border-port-border rounded-lg p-4 shadow-2xl"
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-white break-all">{fileName}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close asset inspector"
            className="shrink-0 text-gray-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {previewable ? (
          <SpritePreview
            recordId={recordId}
            path={asset.path}
            className="rounded border border-port-border p-2"
            imgClassName="mx-auto max-w-full max-h-[55vh] object-contain"
            cell={10}
            loading="eager"
          />
        ) : isVideoAsset(asset) ? (
          // A walk run's grok source clip lives in the listing; play it here
          // rather than forcing a download just to review a render. No <track>:
          // these are silent generated animation clips with nothing to caption.
          <video src={url} controls className="w-full max-h-[55vh] bg-port-bg rounded border border-port-border" />
        ) : (
          <p className="text-xs text-gray-500 border border-port-border rounded p-4 text-center">
            {/* `imageError` distinguishes "PortOS tried and failed" from "this
                was never an image" — the server keeps them apart precisely so
                a corrupt asset reads as broken rather than as a sidecar. */}
            {asset.imageError
              ? 'This looks like an image, but PortOS could not read it — it may be truncated or corrupt.'
              : 'No inline preview for this file type — use Open to view it.'}
          </p>
        )}

        {isRuntimeManifest && (
          <p className="text-xs text-gray-400 border border-port-border rounded p-2 bg-port-bg">
            This is the atlas <span className="text-gray-200">build manifest</span> — the geometry,
            chroma key, and source provenance the compiler recorded for its sprite sheet. It’s
            behind-the-scenes metadata for the atlas in this same runtime version and is removed
            together with it, not a separately publishable asset.
          </p>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <Row label="Path" value={asset.path} />
          <Row label="Dimensions" value={previewable ? `${asset.width} × ${asset.height}` : null} />
          <Row label="Format" value={asset.format} />
          <Row label="Frames" value={asset.frameCount} />
          <Row label="Size" value={formatBytes(asset.size)} />
          <Row label="Modified" value={asset.mtime ? timeAgo(asset.mtime) : null} />
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={url}
            download={fileName}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-accent hover:bg-blue-600 text-white rounded"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </a>
          {/* `download` forces a save, so Download alone can't replace the
              open-in-a-tab the non-image rows used to have. */}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open
          </a>
          <button
            type="button"
            onClick={() => copyToClipboard(asset.path, 'Asset path copied')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded"
          >
            <ClipboardCopy className="w-3.5 h-3.5" /> Copy path
          </button>
          {onDeleted && !confirming && (
            <button
              type="button"
              onClick={() => { setDeleteError(null); setConfirming(true); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-bg border border-port-border hover:border-port-error text-gray-300 hover:text-port-error rounded ml-auto"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          )}
        </div>

        {onDeleted && confirming && (
          // Inline confirm row (project convention: no window.confirm, and no
          // two-click-arm — a discoverable Cancel/Delete pair instead).
          <div className="space-y-2 border border-port-error/40 bg-port-error/10 rounded p-2">
            <p className="text-xs text-gray-200">
              Delete <span className="font-semibold break-all">{fileName}</span> from disk?
              {isRuntimeVersionFile && ' The whole runtime version — atlas sprite sheet and its sidecar manifest — is removed together.'}
              {' '}This can’t be undone.
            </p>
            {deleteError && <p className="text-xs text-port-error break-all">{deleteError}</p>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={runDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-error hover:bg-red-600 text-white rounded disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> {deleting ? 'Deleting…' : 'Delete'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirming(false); setDeleteError(null); }}
                disabled={deleting}
                className="px-2.5 py-1.5 text-xs bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
