import { useId, useState } from 'react';
import { Search, X } from 'lucide-react';
import MediaImage from '../MediaImage';
import Modal from '../ui/Modal';

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'cast', label: 'Cast', roles: ['character'] },
  { id: 'environments', label: 'Environments', roles: ['set', 'place', 'location'] },
  { id: 'objects', label: 'Objects', roles: ['prop', 'object'] },
];

function ReferenceGallery({ references, label, tileProps, onFilterChange, children }) {
  const searchId = useId();
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [search, setSearch] = useState('');
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = references.filter((ref) => {
    if (category.roles && !category.roles.includes(ref.role)) return false;
    const kind = CATEGORIES.find((option) => option.roles?.includes(ref.role));
    const text = [ref.label, ref.note, ref.role, kind?.label].filter(Boolean).join(' ').toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  return (
    <>
      <div className="shrink-0 space-y-2 border-b border-port-border px-4 py-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-port-text-muted" aria-hidden="true" />
          <label htmlFor={searchId} className="sr-only">Search references</label>
          <input id={searchId} type="search" value={search} placeholder="Search references…"
            onChange={(event) => { setSearch(event.target.value); onFilterChange?.(); }}
            className="min-h-11 w-full rounded border border-port-border bg-port-bg py-2 pl-9 pr-3 text-sm text-port-text focus-visible:border-port-accent" />
        </div>
        <div role="group" aria-label="Reference type" className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((option) => (
            <button key={option.id} type="button" aria-pressed={category === option}
              onClick={() => { setCategory(option); onFilterChange?.(); }}
              className="min-h-11 rounded border border-port-border bg-port-bg px-2.5 text-sm text-port-text hover:border-port-accent aria-pressed:border-port-accent aria-pressed:bg-port-accent/15">
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
        {visible.length ? (
          <ul aria-label={label} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {visible.map((ref) => (
              <li key={ref.id} className="min-w-0">
                <button type="button" {...tileProps(ref)}
                  className="w-full min-w-0 select-none overflow-hidden rounded border border-port-border bg-port-bg text-left [-webkit-touch-callout:none] hover:border-port-accent disabled:opacity-50">
                  <MediaImage thumbnail src={`/data/images/${encodeURIComponent(ref.imageId)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(ref.imageId)}`}
                    alt="" loading="lazy" className="aspect-square w-full bg-black object-contain" />
                  <span className="block break-words p-2 text-xs text-port-text">{ref.label || ref.role || 'Reference'}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p role="status" className="text-sm text-port-text-muted">No matching references.</p>}
        {children}
      </div>
    </>
  );
}

/** The gallery a shot's references are added from: every choice as a tile large enough to tell its sheets apart. */
export default function SceneReferencePicker({ open, references, label, hint, onClose, tileProps, onFilterChange, children }) {
  return (
    <Modal open={open} onClose={onClose} size="xl" usePortal
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col" ariaLabel={label}>
      <div className="flex items-center justify-between gap-2 p-4 border-b border-port-border">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">{label}</h2>
          {hint && <p className="text-sm text-gray-400">{hint}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close reference picker"
          className="min-h-11 min-w-11 flex items-center justify-center rounded text-gray-400 hover:text-white">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <ReferenceGallery references={references} label={label} tileProps={tileProps} onFilterChange={onFilterChange}>
        {children}
      </ReferenceGallery>
    </Modal>
  );
}
