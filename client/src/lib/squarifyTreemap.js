// Squarified treemap layout (Bruls, Huizing & van Wijk). Packs weighted items
// into a width×height rectangle so each tile's area is proportional to its
// value while keeping tiles as close to square as possible — the layout disk
// usage views (disktree, WinDirStat) use so a big directory reads as big.
//
// Pure: returns `{ item, x, y, w, h }` in the same units as width/height, in
// descending-value order. Zero/negative/non-finite values are dropped (they
// would occupy no area and poison the worst-ratio math).

const worstRatio = (row, side) => {
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (const r of row) {
    sum += r.area;
    if (r.area < min) min = r.area;
    if (r.area > max) max = r.area;
  }
  if (!sum || !side) return Infinity;
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
};

export function squarifyTreemap(items, width, height, getValue = (i) => i.value) {
  const rects = [];
  if (!(width > 0) || !(height > 0) || !Array.isArray(items)) return rects;

  const weighted = items
    .map((item) => ({ item, value: Number(getValue(item)) }))
    .filter((e) => Number.isFinite(e.value) && e.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = weighted.reduce((s, e) => s + e.value, 0);
  if (!total) return rects;

  const scale = (width * height) / total;
  const queue = weighted.map((e) => ({ item: e.item, area: e.value * scale }));
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;

  const layoutRow = (row) => {
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) {
      // Lay the row out as a column along the left edge.
      const colW = rowArea / h;
      let cy = y;
      for (const r of row) {
        const rh = r.area / colW;
        rects.push({ item: r.item, x, y: cy, w: colW, h: rh });
        cy += rh;
      }
      x += colW;
      w -= colW;
    } else {
      // Lay the row out along the top edge.
      const rowH = rowArea / w;
      let cx = x;
      for (const r of row) {
        const rw = r.area / rowH;
        rects.push({ item: r.item, x: cx, y, w: rw, h: rowH });
        cx += rw;
      }
      y += rowH;
      h -= rowH;
    }
  };

  let row = [];
  let i = 0;
  while (i < queue.length) {
    const side = Math.min(w, h);
    const candidate = [...row, queue[i]];
    if (!row.length || worstRatio(candidate, side) <= worstRatio(row, side)) {
      row = candidate;
      i += 1;
    } else {
      layoutRow(row);
      row = [];
    }
  }
  if (row.length) layoutRow(row);
  return rects;
}
