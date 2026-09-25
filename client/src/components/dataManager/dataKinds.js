// What a Data Manager category means for cleanup, derived from the server's
// archivable/deletable/purgeScope/classified flags. One kind per category so
// the treemap, its legend, and the selection panel color a directory the same
// way everywhere. Older servers omit `purgeScope`/`classified`; only an
// explicit `purgeScope: 'items'` / `classified: false` changes the kind.

// Diagonal stripes over a reclaimable tile — the "safe to delete" tell, so it
// still reads when the tile is too small for a label.
export const HATCH_STYLE = {
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.07) 0 2px, transparent 2px 7px)',
};

export const DATA_KINDS = {
  reclaimable: {
    label: 'Reclaimable',
    hint: 'Reproducible — safe to purge',
    tile: 'bg-port-warning/15 hover:bg-port-warning/25',
    edge: 'border-port-warning/70',
    swatch: 'bg-port-warning',
    tone: 'warning',
    hatch: true,
  },
  userFiles: {
    label: 'Your files',
    hint: 'Only copy — delete entries one at a time',
    tile: 'bg-port-accent-2/15 hover:bg-port-accent-2/25',
    edge: 'border-port-accent-2/70',
    swatch: 'bg-port-accent-2',
    tone: 'accent2',
  },
  archivable: {
    label: 'Archivable',
    hint: 'Can be tarred into data/backup',
    tile: 'bg-port-accent/15 hover:bg-port-accent/25',
    edge: 'border-port-accent/70',
    swatch: 'bg-port-accent',
    tone: 'accent',
  },
  protected: {
    label: 'Protected',
    hint: 'PortOS state — never purged here',
    tile: 'bg-port-success/15 hover:bg-port-success/25',
    edge: 'border-port-success/70',
    swatch: 'bg-port-success',
    tone: 'success',
  },
  unclassified: {
    label: 'Unclassified',
    hint: 'Unknown directory — actions withheld',
    tile: 'bg-gray-500/15 hover:bg-gray-500/25',
    edge: 'border-gray-500/70',
    swatch: 'bg-gray-500',
    tone: 'muted',
  },
};

export const DATA_KIND_ORDER = ['reclaimable', 'userFiles', 'archivable', 'protected', 'unclassified'];

export function dataKindOf(cat) {
  if (cat?.classified === false) return 'unclassified';
  if (cat?.deletable) return cat.purgeScope === 'items' ? 'userFiles' : 'reclaimable';
  if (cat?.archivable) return 'archivable';
  return 'protected';
}
