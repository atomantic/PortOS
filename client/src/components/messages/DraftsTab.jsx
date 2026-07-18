import { useState, useEffect, useCallback } from 'react';
import { FileText, Trash2, Send, Check, RefreshCw, Copy } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { copyToClipboard } from '../../lib/clipboard.js';

export default function DraftsTab({ accounts }) {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const handleCopy = async (draft) => {
    const ok = await copyToClipboard(draft.body || '');
    if (!ok) { toast.error('Could not copy to clipboard'); return; }
    setCopiedId(draft.id);
    setTimeout(() => setCopiedId((prev) => (prev === draft.id ? null : prev)), 1500);
  };

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    const data = await api.getMessageDrafts().catch(() => []);
    setDrafts(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDrafts();
  }, [fetchDrafts]);

  const handleApprove = async (id) => {
    const result = await api.approveMessageDraft(id).catch(() => null);
    if (!result) return;
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, status: 'approved' } : d));
    toast.success('Draft approved');
  };

  const handleSend = async (id) => {
    const result = await api.sendMessageDraft(id).catch(() => null);
    if (!result || result.success === false) return;
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, status: 'sent' } : d));
    toast.success('Message sent');
  };

  const handleDelete = async (id) => {
    const ok = await api.deleteMessageDraft(id).then(() => true).catch(() => false);
    if (!ok) return;
    setDrafts(prev => prev.filter(d => d.id !== id));
    toast.success('Draft deleted');
  };

  const getAccountName = (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    // Tribe-outreach drafts (#2158) for iMessage/Signal have no message account.
    if (!account) return accountId ? 'Unknown' : 'Tribe outreach';
    return account.name;
  };

  const statusColors = {
    draft: 'bg-gray-700 text-gray-300',
    pending_review: 'bg-port-warning/20 text-port-warning',
    approved: 'bg-port-success/20 text-port-success',
    sending: 'bg-port-accent/20 text-port-accent',
    sent: 'bg-port-success/20 text-port-success',
    failed: 'bg-port-error/20 text-port-error'
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Drafts</h2>
        <button
          onClick={fetchDrafts}
          aria-label="Refresh drafts"
          className="p-2 text-gray-400 hover:text-white transition-colors"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {drafts.length === 0 && !loading && (
        <div className="text-center py-12 text-gray-500">
          <FileText size={48} className="mx-auto mb-4 opacity-50" />
          <p>No drafts</p>
          <p className="text-sm mt-1">Generate AI replies from the Inbox or create manual drafts</p>
        </div>
      )}

      <div className="space-y-2">
        {drafts.map((draft) => (
          <div
            key={draft.id}
            className="p-4 bg-port-card rounded-lg border border-port-border space-y-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-xs ${statusColors[draft.status] || ''}`}>
                  {draft.status}
                </span>
                <span className="text-xs text-gray-500">{getAccountName(draft.accountId)}</span>
                {draft.generatedBy === 'ai' && (
                  <span className="text-xs text-port-accent-2">AI generated</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {draft.status === 'draft' && draft.sendVia !== 'review' && (
                  <button
                    onClick={() => handleApprove(draft.id)}
                    className="p-1 text-gray-400 hover:text-port-success transition-colors"
                    title="Approve"
                  >
                    <Check size={16} />
                  </button>
                )}
                {/* Review-only drafts (e.g. Tribe outreach for iMessage/Signal,
                    which have no programmatic send channel) never offer Send —
                    messageSender can't deliver them, so the button would only
                    fail. Send them yourself from the Messages/Signal app. */}
                {draft.status === 'approved' && draft.sendVia !== 'review' && (
                  <button
                    onClick={() => handleSend(draft.id)}
                    className="p-1 text-gray-400 hover:text-port-accent transition-colors"
                    title="Send"
                  >
                    <Send size={16} />
                  </button>
                )}
                {draft.sendVia === 'review' && (
                  <>
                    <span className="text-xs text-gray-500" title="No programmatic send — copy and send from your messaging app">
                      Review only
                    </span>
                    <button
                      onClick={() => handleCopy(draft)}
                      className="p-1 text-gray-400 hover:text-port-accent transition-colors"
                      title="Copy message"
                      aria-label="Copy message"
                    >
                      {copiedId === draft.id ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </>
                )}
                {/* Review-only drafts never reach a 'sent' state (there's no send
                    channel), so keep Delete available at any status — otherwise an
                    approved iMessage/Signal draft would be stuck with no action. */}
                {(['draft', 'pending_review', 'failed'].includes(draft.status) || draft.sendVia === 'review') && (
                  <button
                    onClick={() => requestDelete(draft.id)}
                    className="p-1 text-gray-400 hover:text-port-error transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
            <div className="text-sm text-white">{draft.subject || '(no subject)'}</div>
            {draft.to?.length > 0 && (
              <div className="text-xs text-gray-500">To: {draft.to.join(', ')}</div>
            )}
            {/* Review-only drafts are sent by hand, so show the full body (not
                clamped) — it's the text the user copies into their messaging app. */}
            <div className={`text-sm text-gray-400 whitespace-pre-wrap ${draft.sendVia === 'review' ? '' : 'line-clamp-3'}`}>
              {draft.body}
            </div>
            {isConfirming(draft.id) && (
              <InlineConfirmRow
                question="Delete this draft? This cannot be undone."
                confirmText="Delete"
                confirmTitle="Delete draft"
                cancelTitle="Cancel"
                onConfirm={() => confirmDelete(() => handleDelete(draft.id))}
                onCancel={cancelDelete}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
