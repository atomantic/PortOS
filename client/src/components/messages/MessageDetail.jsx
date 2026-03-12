import { useState, useEffect } from 'react';
import { ArrowLeft, Reply, Sparkles, Send, MessageSquare, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';

export default function MessageDetail({ message, accounts, onBack }) {
  const [showReply, setShowReply] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedDraftId, setGeneratedDraftId] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [displayedMessage, setDisplayedMessage] = useState(message);

  // Sync displayedMessage when the message prop changes (e.g., selecting a different message)
  useEffect(() => {
    setDisplayedMessage(message);
  }, [message]);

  const account = accounts.find(a => a.id === displayedMessage.accountId) || accounts[0];

  // Load thread messages if this message is part of a thread
  useEffect(() => {
    if (!message.threadId || !message.accountId) return;
    setThreadLoading(true);
    api.getMessageThread(message.accountId, message.threadId)
      .then(data => setThreadMessages(data?.messages || []))
      .catch(() => setThreadMessages([]))
      .finally(() => setThreadLoading(false));
  }, [message.threadId, message.accountId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    const result = await api.refreshMessage(message.accountId, message.id).catch(() => null);
    setRefreshing(false);
    if (!result) return;
    if (result.error) return toast.error(result.error);
    // Result is the updated messages array
    if (Array.isArray(result)) {
      const updated = result.find(m => m.id === message.id) || result[0];
      if (updated) setDisplayedMessage(prev => ({ ...prev, ...updated }));
      if (result.length > 1) setThreadMessages(result);
    }
    toast.success('Message content refreshed');
  };

  const handleGenerateReply = async () => {
    if (!account) return toast.error('No account available');
    setGenerating(true);
    const draft = await api.generateMessageDraft({
      accountId: account.id,
      replyToMessageId: displayedMessage.id,
      threadId: displayedMessage.threadId,
      context: `Replying to: "${displayedMessage.subject}" from ${displayedMessage.from?.name || displayedMessage.from?.email}`,
      instructions: ''
    }).catch(() => null);
    setGenerating(false);
    if (draft) {
      setReplyBody(draft.body);
      setGeneratedDraftId(draft.id);
      setShowReply(true);
      toast.success('AI draft generated');
    }
  };

  const handleCreateDraft = async () => {
    if (!account) return toast.error('No account available');
    const to = [displayedMessage.from?.email].filter(Boolean);
    const subject = `Re: ${displayedMessage.subject || ''}`;
    const result = generatedDraftId
      ? await api.updateMessageDraft(generatedDraftId, { to, subject, body: replyBody }).catch(() => null)
      : await api.createMessageDraft({
          accountId: account.id,
          replyToMessageId: displayedMessage.id,
          threadId: displayedMessage.threadId,
          to, subject, body: replyBody,
          generatedBy: 'manual'
        }).catch(() => null);
    if (!result) return;
    toast.success('Draft saved');
    setShowReply(false);
    setReplyBody('');
    setGeneratedDraftId(null);
  };

  // Show thread or single message
  const hasThread = threadMessages.length > 1;
  const displayMessages = hasThread ? threadMessages : [displayedMessage];

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
      >
        <ArrowLeft size={16} /> Back to inbox
      </button>

      <div className="p-4 bg-port-card rounded-lg border border-port-border">
        <h2 className="text-lg font-medium text-white">{displayedMessage.subject || '(no subject)'}</h2>
        {hasThread && (
          <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
            <MessageSquare size={12} />
            <span>{threadMessages.length} messages in conversation</span>
          </div>
        )}
      </div>

      {threadLoading ? (
        <div className="text-sm text-gray-500 animate-pulse">Loading conversation...</div>
      ) : (
        <div className="space-y-3">
          {displayMessages.map((msg, i) => (
            <div
              key={msg.id || i}
              className="p-4 bg-port-card rounded-lg border border-port-border space-y-2"
            >
              <div className="flex items-center gap-4 text-sm">
                <span className="text-gray-400">
                  From: <span className="text-white">{msg.from?.name || msg.from?.email || 'Unknown'}</span>
                </span>
                {msg.date && (
                  <span className="text-gray-500">{new Date(msg.date).toLocaleString()}</span>
                )}
              </div>
              {msg.to?.length > 0 && (
                <div className="text-xs text-gray-500">
                  To: {msg.to.map(t => typeof t === 'string' ? t : t.email || t).join(', ')}
                </div>
              )}
              <div className="pt-2 border-t border-port-border text-sm text-gray-300 whitespace-pre-wrap">
                {msg.bodyText || '(no content)'}
              </div>
              {!msg.bodyFull && msg.bodyText && (
                <div className="text-xs text-gray-600 italic">Preview only — re-sync for full content</div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowReply(!showReply)}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 transition-colors"
        >
          <Reply size={16} /> Reply
        </button>
        <button
          onClick={handleGenerateReply}
          disabled={generating}
          className="flex items-center gap-2 px-3 py-2 bg-purple-500/10 text-purple-400 rounded-lg text-sm hover:bg-purple-500/20 transition-colors disabled:opacity-50"
        >
          <Sparkles size={16} className={generating ? 'animate-pulse' : ''} />
          {generating ? 'Generating...' : 'AI Reply'}
        </button>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Fetching...' : 'Refresh'}
        </button>
      </div>

      {showReply && (
        <div className="p-4 bg-port-card rounded-lg border border-port-border space-y-3">
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Write your reply..."
            rows={6}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent resize-y"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreateDraft}
              className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 transition-colors"
            >
              <Send size={16} /> Save Draft
            </button>
            <button
              onClick={() => { setShowReply(false); setReplyBody(''); setGeneratedDraftId(null); }}
              className="px-4 py-2 bg-port-border text-gray-300 rounded-lg text-sm hover:bg-port-border/80 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
