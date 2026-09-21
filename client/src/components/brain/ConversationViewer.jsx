import { useState, useEffect } from 'react';
import { X, ArrowLeft, Library, Edit2 } from 'lucide-react';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import MarkdownOutput from '../cos/MarkdownOutput';
import CopyableId from '../ui/CopyableId';
import { timeAgo } from '../../utils/formatters';

/**
 * Sidebar preview for handwritten memories and imported conversations. The Memory
 * record stores only a truncated preview in the list card; the complete thread
 * (with inline images and asset links) lives in the import archive or markdown
 * body, rendered in this sidebar preview without a blocking modal.
 */
export default function ConversationViewer({ record, onClose, onEdit, onSendToCatalog }) {
  const [archive, setArchive] = useState(null);
  const [loading, setLoading] = useState(record?.source === 'chatgpt-import' && !!record?.sourceRef);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!record || record.source !== 'chatgpt-import' || !record.sourceRef) return;
    let active = true;
    setArchive(null);
    setLoading(true);
    setError(null);
    api.getChatgptArchive(record.sourceRef, { silent: true })
      .then((data) => { if (active) { setArchive(data); setLoading(false); } })
      .catch((err) => { if (active) { setError(err.message); setLoading(false); } });
    return () => { active = false; };
  }, [record?.source, record?.sourceRef]);

  if (!record) return null;

  const title = record.title || record.name || 'Untitled entry';
  const content = archive?.transcript || record.content || record.notes || record.context || 'No content yet.';

  return (
    <aside
      aria-label={`Preview: ${title}`}
      className="bg-port-card border border-port-border rounded-lg flex flex-col w-full overflow-hidden shadow-lg lg:sticky lg:top-4 max-h-[85vh] lg:max-h-[calc(100vh-10rem)]"
    >
      {/* Mobile-only back button bar */}
      <div className="px-4 pt-3 pb-0 lg:hidden">
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1.5 text-xs text-port-accent hover:text-white min-h-[44px]"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back to entries
        </button>
      </div>

      {/* Sidebar header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-port-border bg-port-bg/40 shrink-0">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-white truncate" title={title}>{title}</h3>
            {record.mood && (
              <span className="px-2 py-0.5 text-xs rounded border bg-pink-500/20 text-pink-400 border-pink-500/30 shrink-0">
                {record.mood}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onSendToCatalog && (
            <button
              onClick={() => onSendToCatalog(record)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-port-accent-2 rounded hover:bg-port-accent-2/20 transition-colors"
              title="Send to Catalog"
              aria-label="Send to Catalog"
            >
              <Library size={15} />
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(record)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white rounded hover:bg-port-border/50 transition-colors"
              title="Edit"
              aria-label="Edit"
            >
              <Edit2 size={15} />
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white flex-shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded hover:bg-port-border/30 transition-colors"
            aria-label="Close entry reader"
            title="Close preview"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Metadata strip */}
      {(record.tags?.length > 0 || record.updatedAt || record.sourceUpdatedAt || record.sourceCreatedAt || record.id) && (
        <div className="px-4 py-2 border-b border-port-border/50 bg-port-bg/20 text-xs text-gray-400 flex flex-wrap items-center gap-2 shrink-0">
          {(record.updatedAt || record.sourceUpdatedAt || record.sourceCreatedAt) && (
            <span>
              {record.source === 'chatgpt-import' && (record.sourceUpdatedAt || record.sourceCreatedAt)
                ? `Conversation ${timeAgo(record.sourceUpdatedAt || record.sourceCreatedAt)}`
                : `Updated ${timeAgo(record.updatedAt)}`}
            </span>
          )}
          {record.id && <CopyableId id={record.id} />}
          {record.tags?.map((tag, i) => (
            <span key={i} className="px-2 py-0.5 rounded bg-port-border/50 text-gray-300">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Preview content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 break-words space-y-4">
        {loading && (
          <div className="text-center py-12 text-gray-400">
            <BrailleSpinner /> Loading conversation…
          </div>
        )}
        {error && (
          <Banner tone="error" size="sm">
            Couldn't load the full transcript ({error}). Showing the preview instead.
          </Banner>
        )}
        {!loading && <MarkdownOutput content={content} />}
      </div>
    </aside>
  );
}
