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

import { Download, ClipboardCopy, ExternalLink, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import SpritePreview from './SpritePreview.jsx';
import { spriteAssetUrl, hasSpritePreview, isVideoAsset } from './spriteAssets.js';
import { formatBytes, timeAgo } from '../../utils/formatters.js';
import { copyToClipboard } from '../../lib/clipboard.js';

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

export default function AssetInspector({ recordId, asset, onClose }) {
  if (!asset) return null;

  const url = spriteAssetUrl(recordId, asset.path);
  const fileName = asset.path.split('/').pop();
  const previewable = hasSpritePreview(asset);

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
        </div>
      </div>
    </Modal>
  );
}
