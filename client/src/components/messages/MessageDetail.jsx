import { useState } from 'react';
import { ArrowLeft, Reply, Sparkles, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';

export default function MessageDetail({ message, accounts, onBack }) {
  const [showReply, setShowReply] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedDraftId, setGeneratedDraftId] = useState(null);

  const account = accounts.find(a => a.id === message.accountId) || accounts[0];

  const handleGenerateReply = async () => {
    if (!account) return toast.error('No account available');
    setGenerating(true);
    const draft = await api.generateMessageDraft({
      accountId: account.id,
      replyToMessageId: message.id,
      threadId: message.threadId,
      context: `Replying to: "${message.subject}" from ${message.from?.name || message.from?.email}`,
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
    const to = [message.from?.email].filter(Boolean);
    const subject = `Re: ${message.subject || ''}`;
    const result = generatedDraftId
      ? await api.updateMessageDraft(generatedDraftId, { to, subject, body: replyBody }).catch(() => null)
      : await api.createMessageDraft({
          accountId: account.id,
          replyToMessageId: message.id,
          threadId: message.threadId,
          to, subject, body: replyBody,
          generatedBy: 'manual'
        }).catch(() => null);
    if (!result) return;
    toast.success('Draft saved');
    setShowReply(false);
    setReplyBody('');
    setGeneratedDraftId(null);
  };

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
      >
        <ArrowLeft size={16} /> Back to inbox
      </button>

      <div className="p-4 bg-port-card rounded-lg border border-port-border space-y-3">
        <h2 className="text-lg font-medium text-white">{message.subject || '(no subject)'}</h2>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-400">
            From: <span className="text-white">{message.from?.name || message.from?.email || 'Unknown'}</span>
          </span>
          {message.date && (
            <span className="text-gray-500">{new Date(message.date).toLocaleString()}</span>
          )}
        </div>
        {message.to?.length > 0 && (
          <div className="text-sm text-gray-500">To: {message.to.map(t => t.email || t).join(', ')}</div>
        )}
        <div className="pt-3 border-t border-port-border text-sm text-gray-300 whitespace-pre-wrap">
          {message.bodyText || '(no content)'}
        </div>
      </div>

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
