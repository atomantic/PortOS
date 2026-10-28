/** Measured publish-kit export presentation, including kits predating dimension metadata. */
export function publishExportDimensions(asset) {
  return Number.isInteger(asset?.width) && asset.width > 0 && Number.isInteger(asset?.height) && asset.height > 0
    ? `${asset.width} × ${asset.height}` : 'dimensions unknown';
}

export function publishExportLabel(asset) {
  const label = asset?.kind === 'x-1080p' ? 'X / social up to 1080p (12 Mbps)' : asset?.label;
  return `${label || 'Video export'} · ${publishExportDimensions(asset)}`;
}
