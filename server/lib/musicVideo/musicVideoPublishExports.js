/**
 * `publishExportLabel`: measured export presentation with explicit unknown dimensions for legacy kits.
 *
 * Shared with the publishing UI.
 */

/** Measured publish-kit export presentation, including kits predating dimension metadata. */
function publishExportDimensions(asset) {
  return Number.isInteger(asset?.width) && asset.width > 0 && Number.isInteger(asset?.height) && asset.height > 0
    ? `${asset.width} × ${asset.height}` : 'dimensions unknown';
}

export function publishExportLabel(asset) {
  const label = asset?.kind === 'x-1080p' ? 'X / social up to 1080p (12 Mbps)' : asset?.label;
  const layout = asset?.layout === 'crop' ? ' · Custom crop' : '';
  return `${label || 'Video export'}${layout} · ${publishExportDimensions(asset)}`;
}
