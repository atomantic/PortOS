import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  RefreshCw,
  Send,
  Square,
  AlertCircle,
  MessageSquareText,
  PlugZap,
  Paperclip,
  Image as ImageIcon,
  X,
  Upload,
  ClipboardPaste
} from 'lucide-react';
import AppContextPicker from '../components/AppContextPicker';
import * as api from '../services/apiOpenClaw';
import * as coreApi from '../services/api';
import { formatDateTime } from '../utils/formatters';
import { useOpenClawAttachments } from '../hooks/useOpenClawAttachments';
import { useOpenClawStream } from '../hooks/useOpenClawStream';

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

function ensureDefaultSession(sessions, status) {
  const nextSessions = Array.isArray(sessions) ? [...sessions] : [];
  const defaultSessionId = status?.defaultSession;
  if (!defaultSessionId) return nextSessions;
  if (nextSessions.some(session => session.id === defaultSessionId)) return nextSessions;

  return [
    {
      id: defaultSessionId,
      title: status?.label ? `${status.label} (default)` : 'Default PortOS session',
      label: 'Default PortOS session',
      status: 'default',
      messageCount: null,
      lastMessageAt: null,
      synthetic: true
    },
    ...nextSessions
  ];
}

function getSessionSortTime(session) {
  const value = session?.lastMessageAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isSessionEmpty(session) {
  return !session?.synthetic && !session?.lastMessageAt && Number(session?.messageCount || 0) === 0;
}

function partitionSessions(sessions = [], selectedSessionId = '', defaultSessionId = '') {
  const sorted = [...sessions].sort((left, right) => {
    const leftPinned = left.id === selectedSessionId || left.id === defaultSessionId;
    const rightPinned = right.id === selectedSessionId || right.id === defaultSessionId;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return getSessionSortTime(right) - getSessionSortTime(left);
  });

  const primary = [];
  const older = [];

  for (const session of sorted) {
    const pinned = session.id === selectedSessionId || session.id === defaultSessionId;
    const empty = isSessionEmpty(session);
    if (pinned || (!empty && primary.length < 6)) {
      primary.push(session);
    } else {
      older.push(session);
    }
  }

  return { primary, older };
}

export default function OpenClaw() {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [apps, setApps] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [composer, setComposer] = useState('');
  const [context, setContext] = useState({
    appId: '',
    directoryPath: '',
    extraInstructions: ''
  });
  const [statusLoading, setStatusLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [showOlderChats, setShowOlderChats] = useState(false);
  // sending is hoisted to the component so both hooks share the same boolean without a
  // circular hook dependency: useOpenClawAttachments reads it; useOpenClawStream updates it.
  const [sending, setSending] = useState(false);
  // messagesError is hoisted so it can be written by both hooks and read in the JSX.
  const [messagesError, setMessagesError] = useState('');
  const selectedSessionIdRef = useRef(selectedSessionId);

  const {
    attachments,
    setAttachments,
    isDragActive,
    fileInputRef,
    removeAttachment,
    handleAttachmentSelect,
    handlePaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop
  } = useOpenClawAttachments({
    sending,
    onError: setMessagesError
  });

  const handleSendComplete = useCallback(({ sessionId }) => {
    const now = new Date().toISOString();
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, lastMessageAt: now } : s
    ));
  }, []);

  const {
    messages,
    activityLabel,
    messagesLoading,
    messagesEndRef,
    loadMessages,
    handleSend,
    handleStop
  } = useOpenClawStream({
    selectedSessionId,
    attachments,
    setAttachments,
    composer,
    setComposer,
    context,
    apps,
    sending,
    setSending,
    onError: setMessagesError,
    onSendComplete: handleSendComplete
  });

  const runtimeState = useMemo(() => getRuntimeState(status), [status]);
  const visibleSessions = useMemo(
    () => partitionSessions(sessions, selectedSessionId, status?.defaultSession),
    [sessions, selectedSessionId, status?.defaultSession]
  );

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
        loadMessages('');
        return;
      }

      try {
        const sessionsData = await api.getOpenClawSessions();
        const nextSessions = ensureDefaultSession(sessionsData?.sessions || [], statusData);
        setSessions(nextSessions);

        const validIds = new Set(nextSessions.map(session => session.id).filter(Boolean));
        const preferredSessionId = [
          selectedSessionIdRef.current,
          statusData.defaultSession,
          nextSessions[0]?.id
        ].find(id => id && (validIds.size === 0 || validIds.has(id)));

        setSelectedSessionId(preferredSessionId || statusData.defaultSession || '');
      } catch (sessErr) {
        setSessions([]);
        setSelectedSessionId('');
        setPageError(sessErr instanceof Error ? sessErr.message : String(sessErr) || 'Failed to load sessions');
      }
    } catch (err) {
      setStatus(null);
      setSessions([]);
      setSelectedSessionId('');
      loadMessages('');
      setPageError(err instanceof Error ? err.message : String(err) || 'Failed to load OpenClaw status');
    } finally {
      setStatusLoading(false);
      setSessionsLoading(false);
    }
  }, [loadMessages]);

  useEffect(() => {
    loadRuntime();
    coreApi.getApps().then(data => setApps((data || []).filter(app => !app.archived))).catch(() => setApps([]));
  }, [loadRuntime]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    if (!status?.configured || !selectedSessionId) {
      loadMessages('');
      return;
    }

    loadMessages(selectedSessionId);
  }, [loadMessages, selectedSessionId, status?.configured]);

  const handleComposerKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSend();
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
            <p className="text-sm text-gray-500">Operator chat surface with streaming, context, and attachments.</p>
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
                <>
                  {visibleSessions.primary.map((session) => {
                    const isActive = session.id === selectedSessionId;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        disabled={sending}
                        onClick={() => {
                          if (sending || isActive) return;
                          setSelectedSessionId(session.id);
                        }}
                        className={`block w-full border-b border-port-border px-4 py-3 text-left transition-colors last:border-b-0 ${
                          isActive ? 'bg-port-accent/10 text-white' : 'text-gray-300 hover:bg-port-border/20 hover:text-white'
                        } ${sending ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <div className="truncate text-sm font-medium">{session.title || session.label || session.id}</div>
                        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-gray-500">
                          <span className="truncate">{session.id}</span>
                          <span>{session.messageCount ?? 0} msgs</span>
                        </div>
                      </button>
                    );
                  })}

                  {visibleSessions.older.length > 0 && (
                    <div className="border-t border-port-border">
                      <button
                        type="button"
                        onClick={() => setShowOlderChats(current => !current)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-gray-400 transition-colors hover:bg-port-border/20 hover:text-white"
                      >
                        <span>{showOlderChats ? 'Hide older chats' : `Show older chats (${visibleSessions.older.length})`}</span>
                        <span className="text-xs text-gray-500">{showOlderChats ? 'expanded' : 'collapsed'}</span>
                      </button>

                      {showOlderChats && visibleSessions.older.map((session) => {
                        const isActive = session.id === selectedSessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            disabled={sending}
                            onClick={() => {
                              if (sending || isActive) return;
                              setSelectedSessionId(session.id);
                            }}
                            className={`block w-full border-t border-port-border/60 px-4 py-3 text-left transition-colors ${
                              isActive ? 'bg-port-accent/10 text-white' : 'text-gray-400 hover:bg-port-border/20 hover:text-white'
                            } ${sending ? 'cursor-not-allowed opacity-60' : ''}`}
                          >
                            <div className="truncate text-sm font-medium">{session.title || session.label || session.id}</div>
                            <div className="mt-1 flex items-center justify-between gap-3 text-xs text-gray-500">
                              <span className="truncate">{session.id}</span>
                              <span>{session.messageCount ?? 0} msgs</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
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
              <div className="text-right text-xs text-gray-500">
                {selectedSession?.lastMessageAt && <div>Last activity {formatDateTime(selectedSession.lastMessageAt)}</div>}
                {activityLabel && <div className="mt-1 text-port-accent">{activityLabel}</div>}
              </div>
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
                  const messageAttachments = Array.isArray(message.attachments) ? message.attachments : [];

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
                        <span className="text-gray-500">{formatDateTime(message.createdAt)}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-sm leading-6 text-gray-100">
                        {message.content || (message.status === 'streaming' ? '…' : '[Empty message]')}
                      </div>
                      {messageAttachments.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {messageAttachments.map((attachment) => (
                            <div key={attachment.id || attachment.name} className="rounded-lg border border-port-border bg-port-card px-3 py-2 text-xs text-gray-300">
                              {attachment.kind === 'image' ? <ImageIcon size={12} className="mr-1 inline" /> : <Paperclip size={12} className="mr-1 inline" />}
                              {attachment.name || attachment.filename}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <form onSubmit={handleSend} className="border-t border-port-border p-4">
            <div className="mb-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <AppContextPicker
                apps={apps}
                value={context.appId}
                onChange={(appId) => setContext(current => ({ ...current, appId }))}
                label="App context"
                placeholder="PortOS (default)"
                showRepoPath
              />
              <label className="block text-xs text-gray-400">
                Directory context
                <input
                  value={context.directoryPath}
                  onChange={(event) => setContext(current => ({ ...current, directoryPath: event.target.value }))}
                  placeholder="client/src/pages"
                  className="mt-1 w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-hidden"
                />
              </label>
              <label className="block text-xs text-gray-400">
                Extra context
                <input
                  value={context.extraInstructions}
                  onChange={(event) => setContext(current => ({ ...current, extraInstructions: event.target.value }))}
                  placeholder="What to pay attention to"
                  className="mt-1 w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-hidden"
                />
              </label>
            </div>

            <div
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`rounded-xl border p-3 transition-colors ${
                isDragActive
                  ? 'border-port-accent bg-port-accent/10'
                  : 'border-port-border bg-port-bg/20'
              }`}
            >
              <label className="mb-2 block text-sm font-medium text-white" htmlFor="openclaw-composer">
                Send message
              </label>
              <textarea
                id="openclaw-composer"
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={handleComposerKeyDown}
                rows={4}
                placeholder={status?.configured ? 'Send a message, paste an image, or drop files here…' : 'OpenClaw is not configured'}
                disabled={!status?.configured || !selectedSessionId || sending}
                className="w-full resize-none rounded-lg border border-port-border bg-port-bg px-3 py-3 text-sm text-white focus:border-port-accent focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
              />

              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-400">
                <span className="inline-flex items-center gap-1">
                  <Upload size={12} />
                  drag & drop
                </span>
                <span className="inline-flex items-center gap-1">
                  <ClipboardPaste size={12} />
                  paste screenshots
                </span>
                <span className="inline-flex items-center gap-1">
                  <Paperclip size={12} />
                  files + images
                </span>
              </div>
            </div>

            {attachments.length > 0 && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="rounded-xl border border-port-border bg-port-bg/40 p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0 text-xs text-gray-300">
                        <div className="truncate font-medium text-white">{attachment.name}</div>
                        <div className="truncate text-gray-500">{attachment.mediaType}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => { if (!sending) removeAttachment(attachment.id); }}
                        disabled={sending}
                        className="text-gray-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-gray-400"
                        aria-label={sending ? `${attachment.name} is locked while sending` : `Remove ${attachment.name}`}
                        title={sending ? 'Attachments are locked while sending' : `Remove ${attachment.name}`}
                      >
                        <X size={14} />
                      </button>
                    </div>

                    {attachment.kind === 'image' && attachment.previewUrl ? (
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.name}
                        className="h-32 w-full rounded-lg border border-port-border object-cover"
                      />
                    ) : (
                      <div className="flex h-32 items-center justify-center rounded-lg border border-port-border bg-port-card text-xs text-gray-400">
                        <Paperclip size={16} className="mr-2" />
                        File attached
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span>
                  {status?.configured && selectedSessionId ? 'Stream via PortOS · ⌘↵ / Ctrl↵ to send' : 'Select a configured session to send.'}
                </span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!status?.configured || !selectedSessionId || sending}
                  className="inline-flex items-center gap-2 rounded-lg border border-port-border bg-port-card px-3 py-2 text-xs text-gray-200 hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Paperclip size={14} />
                  Add file/image
                </button>
              </div>
              <div className="flex items-center gap-2">
                {sending && (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="inline-flex items-center gap-2 rounded-lg border border-port-border bg-port-card px-4 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-red-500/50 hover:text-red-300"
                  >
                    <Square size={14} />
                    Stop
                  </button>
                )}
                <button
                  type="submit"
                  disabled={(!composer.trim() && attachments.length === 0) || !status?.configured || !selectedSessionId || sending}
                  className="inline-flex items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-port-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sending ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                  {sending ? (activityLabel || 'Working…') : 'Send'}
                </button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.json,.csv,.pdf"
              className="hidden"
              onChange={handleAttachmentSelect}
            />
          </form>
        </section>
      </div>
    </div>
  );
}
