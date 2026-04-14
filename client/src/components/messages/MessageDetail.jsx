import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Reply, Sparkles, Send, RefreshCw, Archive, Trash2, User } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';

/**
 * Renders HTML email content in a sandboxed iframe.
 * Strips scripts, sets sandbox restrictions, and auto-resizes to content height.
 */
function SafeHtmlBody({ html }) {
  const iframeRef = useRef(null);

  const writeContent = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Strip script tags, event handlers, meta tags, SVG content, and javascript: URIs
    const sanitized = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<meta\b[^>]*>/gi, '')
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
      .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s+on\w+\s*=\s*\S+/gi, '')
      // Match the full quoted attribute value (capture the quote char so we
      // consume the closing quote too) — prevents leaving a stray trailing
      // quote in the output like `href="#""`.
      .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
      // Also handle unquoted attributes, which end at whitespace or `>`.
      .replace(/(href|src)\s*=\s*javascript:[^\s>]*/gi, '$1="#"');

    const doc = iframe.contentDocument;
    if (!doc) return;

    doc.open();
    doc.write(`<!DOCTYPE html><html><head><style>
      body { margin: 0; padding: 8px; font-family: -apple-system, sans-serif; font-size: 14px; color: #d1d5db; background: transparent; word-wrap: break-word; overflow-wrap: break-word; }
      a { color: #3b82f6; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100% !important; }
    </style></head><body>${sanitized}</body></html>`);
    doc.close();

    // Auto-resize iframe to content height
    const resize = () => {
      const h = doc.documentElement?.scrollHeight || doc.body?.scrollHeight;
      if (h) iframe.style.height = `${h + 16}px`;
    };
    resize();
    // Resize again after images load
    doc.querySelectorAll('img').forEach(img => img.addEventListener('load', resize));
  }, [html]);

  useEffect(() => {
    writeContent();
  }, [writeContent]);

  return (
    <iframe
      ref={iframeRef}
      // allow-same-origin is required to write/resize via contentDocument;
      // scripts remain blocked (no allow-scripts), and we sanitize HTML upstream
      // before injecting so the email body cannot execute JS.
      sandbox="allow-same-origin"
      className="w-full border-0 min-h-[100px]"
      style={{ background: 'transparent' }}
      title="Email content"
    />
  );
}

export default function MessageDetail({ message, accounts, onBack }) {
  const [showReply, setShowReply] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedDraftId, setGeneratedDraftId] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [displayedMessage, setDisplayedMessage] = useState(message);
  const [actioning, setActioning] = useState(null);
  const [useVoice, setUseVoice] = useState(false);

  // Sync displayedMessage when the message prop changes (e.g., selecting a different message)
  useEffect(() => {
    setDisplayedMessage(message);
  }, [message]);

  // Load voice mode default from settings
  useEffect(() => {
    api.getSettings()
      .then(s => setUseVoice(s?.messages?.voiceMode ?? false))
      .catch(() => {});
  }, []);

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
      instructions: '',
      useVoice: useVoice ?? undefined
    }).catch(() => null);
    setGenerating(false);
    if (draft) {
      setReplyBody(draft.body);
      setGeneratedDraftId(draft.id);
      setShowReply(true);
      toast.success(useVoice ? 'AI draft generated with your voice' : 'AI draft generated');
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

  const handleAction = (action) => {
    if (!displayedMessage.accountId) return;
    setActioning(action);
    api.executeMessageAction(displayedMessage.accountId, displayedMessage.id, action)
      .then(() => {
        toast.success(`Message ${action}d`);
        onBack();
      })
      .catch(() => toast.error(`Failed to ${action} message`))
      .finally(() => setActioning(null));
  };

  // Show thread or single message
  const hasThread = threadMessages.length > 1;
  const displayMessages = hasThread ? threadMessages : [displayedMessage];

  return (
    <div className="space-y-4">
      {/* Header: back + subject + actions — single compact row */}
      <div className="flex items-center gap-3 px-3 py-2 bg-port-card rounded-lg border border-port-border">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors shrink-0">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium text-white truncate">{displayedMessage.subject || '(no subject)'}</h2>
          {hasThread && (
            <span className="text-xs text-gray-500">{threadMessages.length} messages</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setShowReply(!showReply)} className="p-1.5 text-port-accent hover:bg-port-accent/10 rounded transition-colors" title="Reply"><Reply size={14} /></button>
          <button onClick={() => setUseVoice(v => !v)} className={`p-1.5 rounded transition-colors ${useVoice ? 'text-purple-400 bg-purple-500/10' : 'text-gray-500 hover:text-gray-300'}`} title={useVoice ? 'Voice mode ON — replies use your Digital Twin voice' : 'Voice mode OFF — replies use generic tone'}><User size={14} /></button>
          <button onClick={handleGenerateReply} disabled={generating} className="p-1.5 text-purple-400 hover:bg-purple-500/10 rounded transition-colors disabled:opacity-50" title="AI Reply"><Sparkles size={14} className={generating ? 'animate-pulse' : ''} /></button>
          <button onClick={handleRefresh} disabled={refreshing} className="p-1.5 text-port-accent hover:bg-port-accent/10 rounded transition-colors disabled:opacity-50" title="Refresh"><RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /></button>
          <span className="w-px h-4 bg-port-border mx-0.5" />
          <button onClick={() => handleAction('archive')} disabled={!!actioning} className="p-1.5 text-port-warning hover:bg-port-warning/10 rounded transition-colors disabled:opacity-50" title="Archive"><Archive size={14} /></button>
          <button onClick={() => handleAction('delete')} disabled={!!actioning} className="p-1.5 text-port-error hover:bg-port-error/10 rounded transition-colors disabled:opacity-50" title="Delete"><Trash2 size={14} /></button>
        </div>
      </div>

      {/* Reply composer */}
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

      {/* Message body / thread */}
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
              <div className="pt-2 border-t border-port-border text-sm text-gray-300">
                {msg.bodyHtml ? (
                  <SafeHtmlBody html={msg.bodyHtml} />
                ) : (
                  <div className="whitespace-pre-wrap">{msg.bodyText || '(no content)'}</div>
                )}
              </div>
              {!msg.bodyFull && msg.bodyText && (
                <div className="text-xs text-gray-600 italic">Preview only — re-sync for full content</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
