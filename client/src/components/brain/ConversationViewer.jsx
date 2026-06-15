import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import MarkdownOutput from '../cos/MarkdownOutput';

/**
 * Full-transcript viewer for an imported ChatGPT conversation. The Memory
 * record stores only a truncated preview; the complete thread (with inline
 * images and asset links) lives in the import archive, fetched on open.
 */
export default function ConversationViewer({ record, onClose }) {
  const [archive, setArchive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.getChatgptArchive(record.sourceRef)
      .then((data) => { if (active) { setArchive(data); setLoading(false); } })
      .catch((err) => { if (active) { setError(err.message); setLoading(false); } });
    return () => { active = false; };
  }, [record.sourceRef]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-port-card border border-port-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
          <h3 className="font-medium text-white truncate pr-4">{record.title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white flex-shrink-0"
            aria-label="Close conversation viewer"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {loading && (
            <div className="text-center py-12 text-gray-400">
              <BrailleSpinner /> Loading conversation…
            </div>
          )}
          {error && (
            <Banner tone="error" size="sm">
              Couldn't load the full transcript ({error}). Showing the preview instead.
              <div className="mt-2 text-sm text-gray-300 whitespace-pre-wrap">{record.content}</div>
            </Banner>
          )}
          {archive && <MarkdownOutput content={archive.transcript || record.content} />}
        </div>
      </div>
    </div>
  );
}
