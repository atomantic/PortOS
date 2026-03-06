import { useState, useEffect, useCallback, useRef } from 'react';
import { Mail, Search, RefreshCw, ChevronRight, Sparkles, Archive, Trash2, Reply, Eye, Flag, Pin } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import * as api from '../../services/api';
import MessageDetail from './MessageDetail';

const ACTION_CONFIG = {
  reply:   { icon: Reply,   color: 'text-port-accent',  bg: 'bg-port-accent/10',  label: 'Reply' },
  archive: { icon: Archive,  color: 'text-gray-400',     bg: 'bg-gray-500/10',     label: 'Archive' },
  delete:  { icon: Trash2,   color: 'text-port-error',   bg: 'bg-port-error/10',   label: 'Delete' },
  review:  { icon: Eye,      color: 'text-port-warning', bg: 'bg-port-warning/10', label: 'Review' }
};

const PRIORITY_DOT = {
  high: 'bg-port-error',
  medium: 'bg-port-warning',
  low: 'bg-gray-500'
};

export default function InboxTab({ accounts }) {
  const [messages, setMessages] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [fetchingFull, setFetchingFull] = useState(false);
  const debounceRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (selectedAccount) params.accountId = selectedAccount;
    if (debouncedSearch) params.search = debouncedSearch;
    const result = await api.getMessageInbox(params).catch(() => ({ messages: [], total: 0 }));
    setMessages(result.messages || []);
    setTotal(result.total || 0);
    setLoading(false);
  }, [selectedAccount, debouncedSearch]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  const handleSync = async (mode) => {
    const targets = selectedAccount
      ? accounts.filter(a => a.id === selectedAccount && a.enabled)
      : accounts.filter(a => a.enabled);
    if (targets.length === 0) return toast.error('No enabled accounts to sync');
    setSyncing(true);
    let totalNew = 0;
    for (const acct of targets) {
      toast(`Syncing ${acct.name} (${mode})...`, { icon: '📧' });
      const result = await api.syncMessageAccount(acct.id, mode).catch(err => {
        toast.error(`${acct.name}: ${err?.message || 'Sync failed'}`);
        return null;
      });
      if (result?.newMessages) totalNew += result.newMessages;
    }
    setSyncing(false);
    toast.success(`Sync complete — ${totalNew} new messages`);
    fetchMessages();
  };

  const handleEvaluate = async () => {
    setEvaluating(true);
    const data = selectedAccount ? { accountId: selectedAccount } : {};
    const result = await api.evaluateMessages(data).catch((err) => {
      toast.error(err?.message || 'Evaluation failed');
      return null;
    });
    setEvaluating(false);
    if (!result) return;
    const count = Object.keys(result.evaluations || {}).length;
    toast.success(`Evaluated ${count} messages`);
    // Merge evaluations into local state
    setMessages(prev => prev.map(m => {
      const ev = result.evaluations?.[m.id];
      return ev ? { ...m, evaluation: ev } : m;
    }));
  };

  const handleQuickReply = async (msg, e) => {
    e.stopPropagation();
    const account = accounts.find(a => a.id === msg.accountId) || accounts[0];
    if (!account) return toast.error('No account available');
    toast('Generating AI reply...', { icon: '✨' });
    const draft = await api.generateMessageDraft({
      accountId: account.id,
      replyToMessageId: msg.id,
      threadId: msg.threadId,
      context: `Replying to: "${msg.subject}" from ${msg.from?.name || msg.from?.email}`,
      instructions: ''
    }).catch(() => null);
    if (draft) {
      toast.success('Draft created — opening Drafts');
      navigate('/messages/drafts');
    }
  };

  if (selectedMessage) {
    return (
      <MessageDetail
        message={selectedMessage}
        accounts={accounts}
        onBack={() => { setSelectedMessage(null); fetchMessages(); }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages..."
            className="w-full pl-9 pr-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
          />
        </div>
        <select
          value={selectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white focus:outline-none focus:border-port-accent"
        >
          <option value="">All accounts</option>
          {accounts.map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button
          onClick={handleEvaluate}
          disabled={evaluating || syncing}
          className="flex items-center gap-1 px-3 py-2 bg-purple-500/10 text-purple-400 rounded-lg text-sm hover:bg-purple-500/20 transition-colors disabled:opacity-50"
          title="AI triage — evaluate messages for recommended actions"
        >
          <Sparkles size={14} className={evaluating ? 'animate-pulse' : ''} />
          {evaluating ? 'Evaluating...' : 'Triage'}
        </button>
        <button
          onClick={() => handleSync('unread')}
          disabled={syncing}
          className="flex items-center gap-1 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
          title="Sync unread messages from all enabled accounts"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync Unread'}
        </button>
        <button
          onClick={() => handleSync('full')}
          disabled={syncing}
          className="flex items-center gap-1 px-3 py-2 bg-port-border text-gray-300 rounded-lg text-sm hover:bg-port-border/80 transition-colors disabled:opacity-50"
          title="Full sync — fetch all messages (slower)"
        >
          Full Sync
        </button>
        {selectedAccount && (
          <button
            onClick={async () => {
              setFetchingFull(true);
              const result = await api.fetchFullContent(selectedAccount).catch(() => null);
              setFetchingFull(false);
              if (!result) return;
              toast.success(`Fetched full content for ${result.count || 0} messages`);
              fetchMessages();
            }}
            disabled={fetchingFull}
            className="flex items-center gap-1 px-3 py-2 bg-port-warning/10 text-port-warning rounded-lg text-sm hover:bg-port-warning/20 transition-colors disabled:opacity-50"
            title="Fetch full body content for messages with preview-only text"
          >
            <RefreshCw size={14} className={fetchingFull ? 'animate-spin' : ''} />
            {fetchingFull ? 'Fetching...' : 'Fetch Full Content'}
          </button>
        )}
      </div>

      <div className="text-sm text-gray-500">{total} messages</div>

      {messages.length === 0 && !loading && (
        <div className="text-center py-12 text-gray-500">
          <Mail size={48} className="mx-auto mb-4 opacity-50" />
          <p>No messages yet</p>
          <p className="text-sm mt-1">Add an account and sync to get started</p>
        </div>
      )}

      <div className="space-y-1">
        {messages.map((msg) => {
          const ev = msg.evaluation;
          const actionCfg = ev ? ACTION_CONFIG[ev.action] : null;
          const ActionIcon = actionCfg?.icon;
          return (
            <div
              key={msg.id}
              className={`flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-port-card group ${
                msg.isRead && !msg.isUnread ? 'opacity-70' : ''
              }`}
            >
              {/* Priority dot + flags */}
              <div className="flex flex-col items-center gap-1 w-4 shrink-0">
                {ev && <span className={`w-2 h-2 rounded-full ${PRIORITY_DOT[ev.priority] || PRIORITY_DOT.medium}`} title={`${ev.priority} priority`} />}
                {msg.isPinned && <Pin size={10} className="text-gray-500" />}
                {msg.isFlagged && <Flag size={10} className="text-port-warning" />}
              </div>

              {/* Message content — clickable */}
              <button
                onClick={() => setSelectedMessage(msg)}
                className="flex-1 min-w-0 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className={`text-sm truncate ${msg.isUnread || !msg.isRead ? 'text-white font-medium' : 'text-gray-400'}`}>
                    {msg.from?.name || msg.from?.email || 'Unknown'}
                  </span>
                  <span className="text-xs text-gray-600 shrink-0">
                    {msg.date ? new Date(msg.date).toLocaleDateString() : ''}
                  </span>
                </div>
                <div className={`text-sm truncate ${msg.isUnread || !msg.isRead ? 'text-gray-300' : 'text-gray-500'}`}>
                  {msg.subject || '(no subject)'}
                </div>
                <div className="text-xs text-gray-600 truncate">
                  {msg.bodyText?.substring(0, 100) || ''}
                </div>
              </button>

              {/* Evaluation badge + quick action */}
              <div className="flex items-center gap-2 shrink-0">
                {ev && (
                  <span className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${actionCfg.bg} ${actionCfg.color}`} title={ev.reason}>
                    {ActionIcon && <ActionIcon size={12} />}
                    {actionCfg.label}
                  </span>
                )}
                {ev?.action === 'reply' && (
                  <button
                    onClick={(e) => handleQuickReply(msg, e)}
                    className="flex items-center gap-1 px-2 py-1 bg-port-accent/10 text-port-accent rounded text-xs hover:bg-port-accent/20 transition-colors opacity-0 group-hover:opacity-100"
                    title="Generate AI reply draft"
                  >
                    <Sparkles size={12} /> Draft
                  </button>
                )}
                {!ev && (
                  <button
                    onClick={(e) => handleQuickReply(msg, e)}
                    className="flex items-center gap-1 px-2 py-1 bg-port-accent/10 text-port-accent rounded text-xs hover:bg-port-accent/20 transition-colors opacity-0 group-hover:opacity-100"
                    title="Generate AI reply draft"
                  >
                    <Reply size={12} /> Reply
                  </button>
                )}
                <ChevronRight size={16} className="text-gray-600" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
