import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, RefreshCw, Send, AlertCircle, MessageSquareText, PlugZap } from 'lucide-react';
import * as api from '../services/api';

function formatTimestamp(value) {
  if (!value) return 'Unknown time';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function getRuntimeState(status) {
  if (!status?.configured) {
    return {
      label: 'Unconfigured',
      classes: 'bg-gray-500/15 text-gray-300 border-gray-500/30'
    };
  }

  if (status.reachable) {
    return {
      label: 'Connected',
      classes: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    };
  }

  return {
    label: 'Unavailable',
    classes: 'bg-amber-500/15 text-amber-300 border-amber-500/30'
  };
}

export default function OpenClaw() {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [messages, setMessages] = useState([]);
  const [composer, setComposer] = useState('');
  const [statusLoading, setStatusLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [pageError, setPageError] = useState('');
  const [messagesError, setMessagesError] = useState('');

  const runtimeState = useMemo(() => getRuntimeState(status), [status]);

  const loadMessages = useCallback(async (sessionId) => {
    if (!sessionId) {
      setMessages([]);
      setMessagesError('');
      return;
    }

    setMessagesLoading(true);
    setMessagesError('');

    try {
      const data = await api.getOpenClawMessages(sessionId, { limit: 50 });
      setMessages(data?.messages || []);
    } catch (err) {
      setMessages([]);
      setMessagesError(err.message || 'Failed to load messages');
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  const loadRuntime = useCallback(async () => {
    setStatusLoading(true);
    setSessionsLoading(true);
    setPageError('');

    try {
      const statusData = await api.getOpenClawStatus();
      setStatus(statusData);

      if (!statusData?.configured) {
        setSessions([]);
        setSelectedSessionId('');
        setMessages([]);
        setMessagesError('');
        return;
      }

      const sessionsData = await api.getOpenClawSessions();
      const nextSessions = sessionsData?.sessions || [];
      setSessions(nextSessions);

      const validIds = new Set(nextSessions.map(session => session.id).filter(Boolean));
      const preferredSessionId = [
        selectedSessionId,
        statusData.defaultSession,
        nextSessions[0]?.id
      ].find(id => id && (validIds.size === 0 || validIds.has(id)));

      const fallbackSessionId = preferredSessionId || statusData.defaultSession || '';
      setSelectedSessionId(fallbackSessionId);
    } catch (err) {
      setStatus(null);
      setSessions([]);
      setSelectedSessionId('');
      setMessages([]);
      setPageError(err.message || 'Failed to load OpenClaw status');
    } finally {
      setStatusLoading(false);
      setSessionsLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    loadRuntime();
  }, [loadRuntime]);

  useEffect(() => {
    if (!status?.configured || !selectedSessionId) {
      setMessages([]);
      setMessagesError('');
      return;
    }

    loadMessages(selectedSessionId);
  }, [loadMessages, selectedSessionId, status?.configured]);

  const handleSend = async (event) => {
    event.preventDefault();

    const message = composer.trim();
    if (!message || !selectedSessionId || sending) return;

    setSending(true);
    setMessagesError('');

    try {
      await api.sendOpenClawMessage(selectedSessionId, message);
      setComposer('');
      await loadMessages(selectedSessionId);
      await loadRuntime();
    } catch (err) {
      setMessagesError(err.message || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const selectedSession = sessions.find(session => session.id === selectedSessionId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-4 border-b border-port-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <Bot className="h-8 w-8 text-port-accent" />
          <div>
            <h1 className="text-xl font-bold text-white">OpenClaw</h1>
            <p className="text-sm text-gray-500">Operator chat surface for an optional runtime.</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${runtimeState.classes}`}>
            {runtimeState.label}
          </span>
          <button
            type="button"
            onClick={loadRuntime}
            disabled={statusLoading || sessionsLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-port-border bg-port-card px-3 py-2 text-sm text-gray-200 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={16} className={statusLoading || sessionsLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col gap-4">
          <section className="rounded-xl border border-port-border bg-port-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <PlugZap size={16} className="text-port-accent" />
              <h2 className="text-sm font-semibold text-white">Runtime Status</h2>
            </div>

            {statusLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <RefreshCw size={14} className="animate-spin" />
                Loading runtime status…
              </div>
            ) : (
              <div className="space-y-2 text-sm text-gray-300">
                <div className="flex justify-between gap-3">
                  <span className="text-gray-500">Label</span>
                  <span className="text-right text-white">{status?.label || 'OpenClaw Runtime'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-gray-500">Configured</span>
                  <span>{status?.configured ? 'Yes' : 'No'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-gray-500">Reachable</span>
                  <span>{status?.reachable ? 'Yes' : 'No'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-gray-500">Default Session</span>
                  <span className="text-right">{status?.defaultSession || 'None'}</span>
                </div>
                {status?.message && (
                  <div className="rounded-lg border border-port-border bg-port-bg px-3 py-2 text-xs text-gray-400">
                    {status.message}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-port-border bg-port-card">
            <div className="flex items-center justify-between border-b border-port-border px-4 py-3">
              <div className="flex items-center gap-2">
                <MessageSquareText size={16} className="text-port-accent" />
                <h2 className="text-sm font-semibold text-white">Sessions</h2>
              </div>
              <span className="text-xs text-gray-500">{sessions.length}</span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {sessionsLoading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-gray-400">
                  <RefreshCw size={14} className="animate-spin" />
                  Loading sessions…
                </div>
              ) : !status?.configured ? (
                <div className="p-4 text-sm text-gray-400">
                  Add local OpenClaw config to enable session discovery.
                </div>
              ) : sessions.length === 0 ? (
                <div className="p-4 text-sm text-gray-400">
                  No sessions available.
                </div>
              ) : (
                sessions.map((session) => {
                  const isActive = session.id === selectedSessionId;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => setSelectedSessionId(session.id)}
                      className={`block w-full border-b border-port-border px-4 py-3 text-left transition-colors last:border-b-0 ${
                        isActive ? 'bg-port-accent/10 text-white' : 'text-gray-300 hover:bg-port-border/20 hover:text-white'
                      }`}
                    >
                      <div className="truncate text-sm font-medium">{session.title || session.label || session.id}</div>
                      <div className="mt-1 flex items-center justify-between gap-3 text-xs text-gray-500">
                        <span className="truncate">{session.id}</span>
                        <span>{session.messageCount ?? 0} msgs</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </aside>

        <section className="flex min-h-0 flex-col rounded-xl border border-port-border bg-port-card">
          <div className="border-b border-port-border px-4 py-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-semibold text-white">
                  {selectedSession?.title || selectedSession?.label || selectedSessionId || 'No session selected'}
                </h2>
                <p className="text-sm text-gray-500">
                  {selectedSessionId ? `Session ID: ${selectedSessionId}` : 'Choose a session to load recent messages.'}
                </p>
              </div>
              {selectedSession?.lastMessageAt && (
                <div className="text-xs text-gray-500">
                  Last activity {formatTimestamp(selectedSession.lastMessageAt)}
                </div>
              )}
            </div>
          </div>

          {pageError && (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{pageError}</span>
            </div>
          )}

          {messagesError && (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{messagesError}</span>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {messagesLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-400">
                <RefreshCw size={16} className="animate-spin" />
                Loading messages…
              </div>
            ) : !status?.configured ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-port-border bg-port-bg/40 p-6 text-center text-sm text-gray-400">
                OpenClaw is not configured for this PortOS instance.
              </div>
            ) : !selectedSessionId ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-port-border bg-port-bg/40 p-6 text-center text-sm text-gray-400">
                Select a session to load recent messages.
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-port-border bg-port-bg/40 p-6 text-center text-sm text-gray-400">
                No recent messages found for this session.
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((message, index) => {
                  const role = message.role || 'assistant';
                  const isUser = role === 'user';
                  const key = message.id || `${message.createdAt || 'message'}-${index}`;

                  return (
                    <div
                      key={key}
                      className={`rounded-xl border px-4 py-3 ${
                        isUser
                          ? 'ml-auto max-w-3xl border-port-accent/30 bg-port-accent/10'
                          : 'max-w-3xl border-port-border bg-port-bg/60'
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs uppercase tracking-wide">
                        <span className={isUser ? 'text-port-accent' : 'text-gray-400'}>{role}</span>
                        <span className="text-gray-500">{formatTimestamp(message.createdAt)}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-sm leading-6 text-gray-100">
                        {message.content || '[Empty message]'}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <form onSubmit={handleSend} className="border-t border-port-border p-4">
            <label className="mb-2 block text-sm font-medium text-white" htmlFor="openclaw-composer">
              Send message
            </label>
            <textarea
              id="openclaw-composer"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              rows={4}
              placeholder={status?.configured ? 'Send a message to the selected session…' : 'OpenClaw is not configured'}
              disabled={!status?.configured || !selectedSessionId || sending}
              className="w-full resize-none rounded-lg border border-port-border bg-port-bg px-3 py-3 text-sm text-white focus:border-port-accent focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">
                {status?.configured && selectedSessionId ? 'Messages are proxied through PortOS.' : 'Select a configured session to send.'}
              </span>
              <button
                type="submit"
                disabled={!composer.trim() || !status?.configured || !selectedSessionId || sending}
                className="inline-flex items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-port-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sending ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
