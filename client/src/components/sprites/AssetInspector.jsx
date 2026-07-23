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

import { Download, ClipboardCopy, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { spriteAssetUrl, spritePreviewStyle } from './spriteAssets.js';
import { formatBytes, timeAgo } from '../../utils/formatters.js';
import { copyToClipboard } from '../../lib/clipboard.js';

const IMAGE_EXT = /\.(png|gif|webp|jpe?g|avif|tiff?)$/i;

export const isImageAsset = (path) => IMAGE_EXT.test(path);

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
  const open = !!asset;
  const url = asset ? spriteAssetUrl(recordId, asset.path) : '';
  const fileName = asset ? asset.path.split('/').pop() : '';
  // The server omits image fields entirely for non-images and for files sharp
  // couldn't read, so `undefined` here means "unknown", not "zero".
  const dimensions = asset?.width && asset?.height ? `${asset.width} × ${asset.height}` : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      ariaLabel={asset ? `Asset ${asset.path}` : undefined}
    >
      {asset && (
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

          {isImageAsset(asset.path) ? (
            <div
              className="rounded border border-port-border flex items-center justify-center p-2"
              style={spritePreviewStyle(10)}
            >
              <img
                src={url}
                alt={asset.path}
                className="max-w-full max-h-[55vh] object-contain"
                style={{ imageRendering: 'pixelated' }}
              />
            </div>
          ) : (
            <p className="text-xs text-gray-500 border border-port-border rounded p-4 text-center">
              No inline preview for this file type — use Download to open it.
            </p>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <Row label="Path" value={asset.path} />
            <Row label="Dimensions" value={dimensions} />
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
            <button
              type="button"
              onClick={() => copyToClipboard(asset.path, 'Asset path copied')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded"
            >
              <ClipboardCopy className="w-3.5 h-3.5" /> Copy path
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
