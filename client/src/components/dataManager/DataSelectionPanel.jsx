import ProgressBar from '../ui/ProgressBar';
import { formatBytes, formatCount, formatPercent } from '../../utils/formatters';
import { DATA_KINDS, dataKindOf } from './dataKinds';

const WORTH_A_LOOK_LIMIT = 6;

function Stat({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="truncate text-sm text-white">{children}</div>
    </div>
  );
}

function SectionTitle({ children, aside }) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <h2 className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">{children}</h2>
      {aside}
    </div>
  );
}

// Big-number readout for the current selection (or the whole data/ tree when
// nothing is selected), a ranked shortlist of what can actually be reclaimed,
// and how much room the volume has left — the disktree side panel, mapped onto
// PortOS's category model.
export default function DataSelectionPanel({ overview, totalFiles, selected, detail, onSelect, onShowActions }) {
  const total = overview?.totalSize || 0;
  const categories = overview?.categories || [];
  const kind = selected ? DATA_KINDS[dataKindOf(selected)] : null;
  const size = selected ? selected.size : total;
  const fileCount = selected ? selected.fileCount : totalFiles;
  const swatch = kind?.swatch ?? 'bg-port-accent';
  const [value, unit] = formatBytes(size).split(' ');
  const share = total > 0 ? (size / total) * 100 : 0;
  const itemCount = selected && detail?.key === selected.key ? detail.items.length : null;

  // Only whole-category purges belong here: an item-scoped category holds the
  // only copy of its files, so it is never "worth a look" as bulk reclaim.
  const reclaimable = categories
    .filter((c) => dataKindOf(c) === 'reclaimable' && c.size > 0)
    .sort((a, b) => b.size - a.size);
  const reclaimableTotal = reclaimable.reduce((sum, c) => sum + c.size, 0);
  const shortlist = reclaimable.slice(0, WORTH_A_LOOK_LIMIT);
  const shortlistMax = shortlist[0]?.size || 1;

  const disk = overview?.disk;

  return (
    <aside className="bg-port-card border border-port-border rounded-xl p-4 space-y-5" aria-label="Selection details">
      <section>
        <SectionTitle>Selection</SectionTitle>
        <div className="flex items-center gap-2">
          <span className={`w-1 h-6 rounded-full ${swatch}`} />
          <span className="truncate text-lg text-white">{selected ? selected.label : `${overview?.dataDir || 'data'}/`}</span>
        </div>
        <div className="mt-0.5 truncate text-xs font-mono text-gray-500">{selected?.path || 'everything PortOS stores'}</div>
        <div className="mt-3 flex items-baseline gap-1.5">
          <span className="text-4xl font-light text-white tabular-nums">{value}</span>
          <span className="text-sm text-gray-500">{unit}</span>
        </div>
        <ProgressBar percent={share} tone={kind?.tone ?? 'accent'} track="border" label="Share of data/" className="mt-2" />
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Of data/">{formatPercent(share, { decimals: share < 10 ? 1 : 0 })}</Stat>
          <Stat label="Files">{formatCount(fileCount, { fallback: '0' })}</Stat>
          <Stat label="Kind">{kind ? kind.label : `${formatCount(categories.length)} categories`}</Stat>
          <Stat label="Entries">{itemCount == null ? '—' : formatCount(itemCount)}</Stat>
        </div>
        {kind && <p className="mt-3 text-xs text-gray-500">{kind.hint}</p>}
        {selected && (
          <button
            type="button"
            onClick={onShowActions}
            className="mt-3 text-xs text-port-accent hover:underline"
          >
            Show actions and contents
          </button>
        )}
      </section>

      <section className="border-t border-port-border pt-4">
        <SectionTitle aside={<span className="text-xs font-mono text-port-warning">{formatBytes(reclaimableTotal)}</span>}>
          Worth a look
        </SectionTitle>
        {shortlist.length === 0 ? (
          <p className="text-xs text-gray-500">Nothing reproducible to reclaim right now.</p>
        ) : (
          <ul className="space-y-1">
            {shortlist.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => onSelect(c.key)}
                  className={`w-full rounded-md border-l-2 border-port-warning/70 px-2 py-1.5 text-left transition-colors hover:bg-port-bg/60 ${selected?.key === c.key ? 'bg-port-bg/60' : ''}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm text-gray-200">{c.label}</span>
                    <span className="shrink-0 text-xs font-mono text-white">{formatBytes(c.size)}</span>
                  </span>
                  <span className="mt-1 block h-1 w-full rounded-full bg-port-border/50 overflow-hidden">
                    <span className="block h-full rounded-full bg-port-warning/80" style={{ width: `${Math.max(2, (c.size / shortlistMax) * 100)}%` }} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {disk && (
        <section className="border-t border-port-border pt-4">
          <SectionTitle>Disk</SectionTitle>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-light text-white tabular-nums">{formatBytes(disk.free)}</span>
            <span className="text-sm text-gray-500">free</span>
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-port-border/60 overflow-hidden flex">
            <div className="h-full bg-port-accent" style={{ width: `${Math.min(100, (total / disk.total) * 100)}%` }} title={`PortOS data ${formatBytes(total)}`} />
            <div className="h-full bg-gray-500/70" style={{ width: `${Math.max(0, Math.min(100, ((disk.used - total) / disk.total) * 100))}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-xs text-gray-500">
            <span>{formatBytes(disk.used)} used</span>
            <span>{formatBytes(disk.total)} total</span>
          </div>
        </section>
      )}
    </aside>
  );
}
