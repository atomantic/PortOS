import { useState } from 'react';
import { Link2, X, GripVertical } from 'lucide-react';
import { faviconUrl, LINK_DND_TYPE } from './bucketColors';

/**
 * A compact favicon + title button for a link inside a bucket.
 * Clicking opens the link in a new tab; the hover-revealed X removes it
 * from the bucket (does not delete the underlying link). Draggable chips
 * carry their link id so they can be dropped into another bucket.
 */
export default function LinkChip({ link, onRemove, draggable }) {
  const [iconFailed, setIconFailed] = useState(false);
  const favicon = faviconUrl(link.url);

  return (
    <div
      className={`group flex items-center gap-2 pl-1.5 pr-1 py-1 bg-port-bg border border-port-border rounded-md hover:border-port-accent/50 transition-colors max-w-full ${draggable ? 'cursor-grab' : ''}`}
      draggable={draggable}
      onDragStart={draggable ? (e) => {
        e.dataTransfer.setData(LINK_DND_TYPE, link.id);
        e.dataTransfer.effectAllowed = 'move';
      } : undefined}
    >
      {draggable && (
        <GripVertical size={12} className="shrink-0 text-gray-600 group-hover:text-gray-400" />
      )}
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        draggable={false}
        className="flex items-center gap-1.5 min-w-0 flex-1 text-sm text-gray-200 hover:text-white"
        title={link.url}
      >
        {favicon && !iconFailed ? (
          <img
            src={favicon}
            alt=""
            width={16}
            height={16}
            className="shrink-0 rounded-sm"
            onError={() => setIconFailed(true)}
          />
        ) : (
          <Link2 size={14} className="shrink-0 text-gray-500" />
        )}
        <span className="truncate">{link.title}</span>
      </a>
      {onRemove && (
        <button
          onClick={() => onRemove(link)}
          className="shrink-0 p-0.5 text-gray-600 hover:text-port-error opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          title="Remove from bucket"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
