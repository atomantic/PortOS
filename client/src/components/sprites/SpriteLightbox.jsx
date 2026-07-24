/**
 * Enlarged preview of a single sprite asset — the click-to-zoom surface for the
 * inline sprite thumbnails (reference set, anchors, candidates) that aren't in
 * the asset browser (which has its own richer AssetInspector). Mirrors that
 * inspector's framing — solid card over a dense backdrop, checkerboarded box,
 * pixel-preserving image — but with no metadata/actions, just the big picture.
 *
 * Inlines the checkerboard + <img> rather than reusing SpritePreview so the two
 * don't form an import cycle (SpritePreview opens this on zoom); the shared
 * spriteAssets helpers keep the checker-on-box rule identical.
 */

import { X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import AssetPromptSection from './AssetPromptSection.jsx';
import { checkerboardStyle, spriteAssetUrl, PIXELATED } from './spriteAssets.js';

export default function SpriteLightbox({ recordId, path, alt, onClose }) {
  const fileName = path.split('/').pop();
  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      ariaLabel={`Preview ${path}`}
      backdropClassName="bg-black/90"
      panelClassName="bg-port-card border border-port-border rounded-lg p-3 shadow-2xl"
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-white break-all">{fileName}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="shrink-0 text-gray-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <span
          className="block overflow-hidden rounded border border-port-border"
          style={checkerboardStyle(12)}
        >
          <img
            src={spriteAssetUrl(recordId, path)}
            alt={alt ?? path}
            className="mx-auto max-w-full max-h-[75vh] object-contain"
            style={PIXELATED}
          />
        </span>
        <AssetPromptSection recordId={recordId} path={path} />
      </div>
    </Modal>
  );
}
