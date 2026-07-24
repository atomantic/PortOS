// Single source of truth for the image-to-3D record status enum's display.
// The server owns the status values (`server/services/imageTo3d/` — draft →
// generating → ready | failed | canceled); this maps each to one label +
// text-color className so the list card (Media3D) and the detail view
// (Media3DDetail) can't drift out of sync (they already had, before this).
// Mirrors the `sceneStatus.js` precedent for the creative-director runner.

export const IMAGE_TO_3D_STATUS = Object.freeze({
  ready: { label: 'Ready', className: 'text-port-success' },
  generating: { label: 'Rendering on-device…', className: 'text-port-accent' },
  draft: { label: 'Queued', className: 'text-gray-400' },
  failed: { label: 'Render failed', className: 'text-port-error' },
  canceled: { label: 'Canceled', className: 'text-gray-500' },
});

// Resolve a record's status to its display meta, falling back to `draft` for an
// unknown/absent status so callers never render an empty label.
export const imageTo3dStatusMeta = (status) => IMAGE_TO_3D_STATUS[status] || IMAGE_TO_3D_STATUS.draft;
