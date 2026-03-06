import { useState, useEffect, useCallback } from 'react';
import { FileText, Trash2, Send, Check, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';

export default function DraftsTab({ accounts }) {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);

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
    if (!result || result.success === false) {
      toast.error(result?.error || 'Failed to send message');
      return;
    }
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
    return account?.name || 'Unknown';
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
                  <span className="text-xs text-purple-400">AI generated</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {draft.status === 'draft' && (
                  <button
                    onClick={() => handleApprove(draft.id)}
                    className="p-1 text-gray-400 hover:text-port-success transition-colors"
                    title="Approve"
                  >
                    <Check size={16} />
                  </button>
                )}
                {draft.status === 'approved' && (
                  <button
                    onClick={() => handleSend(draft.id)}
                    className="p-1 text-gray-400 hover:text-port-accent transition-colors"
                    title="Send"
                  >
                    <Send size={16} />
                  </button>
                )}
                {['draft', 'pending_review', 'failed'].includes(draft.status) && (
                  <button
                    onClick={() => handleDelete(draft.id)}
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
            <div className="text-sm text-gray-400 whitespace-pre-wrap line-clamp-3">
              {draft.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
