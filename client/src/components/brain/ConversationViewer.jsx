import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import MarkdownOutput from '../cos/MarkdownOutput';
import Modal from '../ui/Modal';

/**
 * Full-content reader for handwritten memories and imported conversations. The Memory
 * record stores only a truncated preview; the complete thread (with inline
 * images and asset links) lives in the import archive, fetched on open.
 */
export default function ConversationViewer({ record, onClose }) {
  const [archive, setArchive] = useState(null);
  const [loading, setLoading] = useState(record.source === 'chatgpt-import' && !!record.sourceRef);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (record.source !== 'chatgpt-import' || !record.sourceRef) return;
    let active = true;
    setArchive(null);
    setLoading(true);
    setError(null);
    api.getChatgptArchive(record.sourceRef, { silent: true })
      .then((data) => { if (active) { setArchive(data); setLoading(false); } })
      .catch((err) => { if (active) { setError(err.message); setLoading(false); } });
    return () => { active = false; };
  }, [record.source, record.sourceRef]);

  return (
    <Modal
      open
      onClose={onClose}
      size="3xl"
      ariaLabel={record.title}
      panelClassName="bg-port-card border border-port-border rounded-lg flex flex-col"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
        <h3 className="font-medium text-white truncate pr-4">{record.title}</h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white flex-shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"
          aria-label="Close entry reader"
        >
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto p-4 sm:p-6 break-words">
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
        {!loading && <MarkdownOutput content={archive?.transcript || record.content || record.notes || record.context || 'No content yet.'} />}
      </div>
    </Modal>
  );
}
