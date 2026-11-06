import { X } from 'lucide-react';
import MediaImage from '../MediaImage';
import Modal from '../ui/Modal';

/** The gallery a shot's references are added from: every choice as a tile large enough to tell its sheets apart. */
export default function SceneReferencePicker({ open, references, label, hint, onClose, tileProps, children }) {
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
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <ul aria-label={label} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {references.map((ref) => (
            <li key={ref.id} className="min-w-0">
              <button type="button" {...tileProps(ref)}
                className="w-full min-w-0 select-none overflow-hidden rounded border border-port-border bg-port-bg text-left [-webkit-touch-callout:none] hover:border-port-accent disabled:opacity-50">
                <MediaImage thumbnail src={`/data/images/${encodeURIComponent(ref.imageId)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(ref.imageId)}`}
                  alt="" loading="lazy" className="aspect-square w-full bg-black object-contain" />
                <span className="block break-words p-2 text-xs text-gray-300">{ref.label || ref.role || 'Reference'}</span>
              </button>
            </li>
          ))}
        </ul>
        {children}
      </div>
    </Modal>
  );
}
