/** Select the supported aspect ratio with the smallest proportional difference. */
export function nearestRatio(width, height, ratios) {
  const w = Number(width);
  const h = Number(height);
  if (!Array.isArray(ratios) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

  const target = Math.log(w) - Math.log(h);
  let best = null;
  let bestDistance = Infinity;
  for (const ratio of ratios) {
    if (typeof ratio !== 'string' || !/^\d+:\d+$/.test(ratio)) continue;
    const [rw, rh] = ratio.split(':').map(Number);
    if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) continue;
    const distance = Math.abs(Math.log(rw) - Math.log(rh) - target);
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}
