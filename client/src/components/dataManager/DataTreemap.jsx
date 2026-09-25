import { useMemo } from 'react';
import useContainerWidth from '../../hooks/useContainerWidth';
import { squarifyTreemap } from '../../lib/squarifyTreemap';
import { formatBytes } from '../../utils/formatters';
import { DATA_KINDS, HATCH_STYLE, dataKindOf } from './dataKinds';

// Before the first ResizeObserver callback (and under happy-dom, which never
// fires one) lay out against a typical desktop width so the map still renders.
const FALLBACK_WIDTH = 960;
const HEADER_H = 22;
const GAP = 3;
// A category can hold thousands of entries; past this many the extra tiles are
// sub-pixel slivers, so only the largest get laid out and rendered.
const MAX_NESTED = 60;

const mapHeight = (width) => Math.round(Math.min(560, Math.max(260, width * 0.5)));

// The selected category's own entries, packed into its tile below the header —
// one level of drill-down, the way disktree nests a directory's children.
function NestedItems({ items, width, height }) {
  const rects = useMemo(
    () => squarifyTreemap(
      [...items].sort((a, b) => b.size - a.size).slice(0, MAX_NESTED),
      width,
      height,
      (i) => i.size,
    ),
    [items, width, height],
  );
  return rects.map(({ item, x, y, w, h }) => {
    const showName = w > 56 && h > 18;
    const showSize = showName && h > 34;
    return (
      <span
        key={item.name}
        className="absolute block overflow-hidden rounded-sm border border-black/20 bg-black/15 px-1.5 py-0.5"
        style={{ left: x + 1, top: y + 1, width: Math.max(0, w - 2), height: Math.max(0, h - 2) }}
        title={`${item.name} — ${formatBytes(item.size)}`}
      >
        {showName && <span className="block truncate text-[11px] leading-4 text-gray-200">{item.name}</span>}
        {showSize && <span className="block truncate text-[10px] leading-3 text-gray-400 font-mono">{formatBytes(item.size)}</span>}
      </span>
    );
  });
}

// Files sitting directly in data/ (settings, state JSON) count toward the
// total but belong to no category directory. Without this tile the
// directories would be scaled to fill the whole map and overstate their share.
const LOOSE_KEY = '__loose-files';

export default function DataTreemap({ categories, looseBytes = 0, selectedKey, detail, onSelect }) {
  const [ref, measured] = useContainerWidth();
  const width = measured || FALLBACK_WIDTH;
  const height = mapHeight(width);

  const tiles = useMemo(
    () => squarifyTreemap(
      looseBytes > 0
        ? [...(categories || []), { key: LOOSE_KEY, label: 'Loose files', size: looseBytes, loose: true }]
        : categories || [],
      width,
      height,
      (c) => c.size,
    ),
    [categories, looseBytes, width, height],
  );

  // One wrapper for both states: useContainerWidth observes the element it
  // first mounted on, so swapping roots would strand the observer on a
  // detached node when an empty overview later fills in.
  return (
    <div ref={ref} className="relative w-full rounded-lg bg-port-bg" style={{ height: tiles.length ? height : undefined }}>
      {!tiles.length && (
        <div className="flex items-center justify-center h-40 rounded-lg border border-port-border text-sm text-gray-500">
          Nothing stored in data/ yet
        </div>
      )}
      {tiles.map(({ item: cat, x, y, w, h }) => {
        const kind = DATA_KINDS[dataKindOf(cat)];
        const selected = cat.key === selectedKey;
        const tileW = Math.max(0, w - GAP);
        const tileH = Math.max(0, h - GAP);
        const showHeader = tileW > 44 && tileH > 20;
        const showSize = tileW > 110;
        const items = selected && detail?.key === cat.key ? detail.items : null;
        const bodyH = tileH - HEADER_H - 4;
        return (
          <button
            key={cat.key}
            type="button"
            onClick={() => onSelect(cat.key)}
            disabled={cat.loose}
            title={cat.loose
              ? `Files directly in data/ (settings and state) — ${formatBytes(cat.size)}`
              : `${cat.label} — ${formatBytes(cat.size)} · ${kind.label}`}
            aria-pressed={selected}
            className={`absolute flex flex-col justify-start overflow-hidden rounded-md border-t-2 text-left transition-colors ${kind.tile} ${kind.edge} ${selected ? 'ring-2 ring-white/70 z-10' : ''}`}
            style={{ left: x, top: y, width: tileW, height: tileH, ...(kind.hatch ? HATCH_STYLE : null) }}
          >
            {showHeader && (
              <span className="flex w-full shrink-0 items-baseline justify-between gap-2 px-2 bg-black/20" style={{ height: HEADER_H, lineHeight: `${HEADER_H}px` }}>
                <span className="truncate text-xs font-medium text-white">{cat.label}</span>
                {showSize && <span className="shrink-0 text-[11px] font-mono text-gray-400">{formatBytes(cat.size)}</span>}
              </span>
            )}
            {items?.length > 0 && showHeader && bodyH > 24 && (
              <span className="absolute left-1 right-1 bottom-1" style={{ top: HEADER_H + 2 }}>
                <NestedItems items={items} width={tileW - 8} height={bodyH} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
