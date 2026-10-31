import { useId, useState } from 'react';
import { Link2 } from 'lucide-react';
import MediaUsageList from './MediaUsageList';

/** "Used ×N" on a media card; tap to list where, each a link there. */
export default function MediaUsageChip({ usages }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!Array.isArray(usages) || usages.length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        title={`Used in ${usages.length} ${usages.length === 1 ? 'place' : 'places'}`}
        className="px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-port-accent"
      >
        <Link2 className="w-2.5 h-2.5" aria-hidden="true" />Used ×{usages.length}
      </button>
      {open && (
        <div id={panelId} role="region" aria-label="Where this is used" className="basis-full mt-1 text-[11px]">
          <MediaUsageList usages={usages} />
        </div>
      )}
    </>
  );
}
