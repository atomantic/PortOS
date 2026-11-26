/** Computes the source-pixel crop shared by the vertical publish preview and FFmpeg encode. */

export function publishCropRect(sourceWidth, sourceHeight, position) {
  // Use even dimensions and origins for yuv420p, with an exact 9:16 crop.
  const units = Math.floor(Math.min(sourceWidth / 18, sourceHeight / 32));
  if (!(units > 0)) return null;
  const width = units * 18;
  const height = units * 32;
  const x = 2 * Math.round(Math.floor((sourceWidth - width) / 2) * position);
  const y = 2 * Math.floor((sourceHeight - height) / 4);
  return { x, y, width, height };
}
