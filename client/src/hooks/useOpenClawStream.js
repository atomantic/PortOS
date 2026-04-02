import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../services/apiOpenClaw';

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) return content.map(normalizeContent).filter(Boolean).join('\n\n');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

// sending / setSending are passed in from the component so that useOpenClawAttachments
// can also receive the same sending boolean without a circular hook dependency.
// onError receives error strings (for both load and send failures); the component owns
// the messagesError state and passes setMessagesError as onError.
// onSendComplete is called after a successful send with { sessionId } so the component
// can update session metadata (e.g. lastMessageAt) without the hook owning sessions state.
export function useOpenClawStream({ selectedSessionId, attachments, setAttachments, composer, setComposer, context, apps, sending, setSending, onError = () => {}, onSendComplete = () => {} } = {}) {
  const [messages, setMessages] = useState([]);
  const [activityLabel, setActivityLabel] = useState('');
  const [messagesLoading, setMessagesLoading] = useState(false);
  const abortControllerRef = useRef(null);
  const scrollAnimationFrameRef = useRef(null);
  const messagesEndRef = useRef(null);
  const loadingSessionRef = useRef(null);

  useEffect(() => {
    if (!messagesEndRef.current) return;
    if (scrollAnimationFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
    }
    scrollAnimationFrameRef.current = requestAnimationFrame(() => {
      scrollAnimationFrameRef.current = null;
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
    return () => {
      if (scrollAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrollAnimationFrameRef.current);
        scrollAnimationFrameRef.current = null;
      }
    };
  }, [messages]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const loadMessages = useCallback(async (sessionId) => {
    if (!sessionId) {
      loadingSessionRef.current = null;
      setMessages([]);
      setMessagesLoading(false);
      onError('');
      return;
    }

    loadingSessionRef.current = sessionId;
    setMessagesLoading(true);
    onError('');

    try {
      const data = await api.getOpenClawMessages(sessionId, { limit: 50 });
      if (loadingSessionRef.current !== sessionId) return;
      setMessages(data?.messages || []);
    } catch (err) {
      if (loadingSessionRef.current !== sessionId) return;
      setMessages([]);
      onError(err.message || 'Failed to load messages');
    } finally {
      if (loadingSessionRef.current === sessionId) setMessagesLoading(false);
    }
  }, [onError]);

  const handleSend = useCallback(async (event) => {
    event?.preventDefault();

    const message = composer.trim();
    if ((!message && attachments.length === 0) || !selectedSessionId || sending) return;

    const userMessageId = `local-user-${Date.now()}`;
    const assistantMessageId = `local-assistant-${Date.now()}`;
    const selectedApp = apps.find(app => app.id === context.appId);
    const payloadContext = Object.fromEntries(
      Object.entries({
        appName: selectedApp?.name || '',
        repoPath: selectedApp?.repoPath || '',
        directoryPath: context.directoryPath,
        extraInstructions: context.extraInstructions
      }).filter(([, value]) => String(value || '').trim())
    );
    const payloadAttachments = attachments.map(({ id, size, previewUrl, ...attachment }) => attachment);

    setSending(true);
    setActivityLabel('Connecting…');
    onError('');

    const userMessage = {
      id: userMessageId,
      role: 'user',
      content: message || 'Please inspect the attached context and respond.',
      createdAt: new Date().toISOString(),
      status: 'completed',
      attachments: attachments.map(({ id, data, previewUrl, ...attachment }) => ({ id, ...attachment }))
    };

    setMessages(current => [...current, userMessage, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      status: 'streaming'
    }]);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const updateAssistant = (updater) =>
      setMessages(current => current.map(item =>
        item.id === assistantMessageId
          ? { ...item, ...(typeof updater === 'function' ? updater(item) : updater) }
          : item
      ));

    try {
      await api.streamOpenClawMessage(selectedSessionId, {
        message: message || 'Please inspect the attached context and respond.',
        context: payloadContext,
        attachments: payloadAttachments,
        signal: abortController.signal,
        onEvent: ({ event: eventName, data }) => {
          if (eventName === 'response.created' || eventName === 'response.in_progress') {
            setActivityLabel('Thinking…');
            return;
          }

          if (eventName === 'response.output_item.added' || eventName === 'response.content_part.added') {
            setActivityLabel('Working…');
            return;
          }

          if (eventName === 'response.output_text.delta') {
            const delta = typeof data === 'string' ? data : (data?.delta || data?.text || '');
            setActivityLabel('Responding…');
            updateAssistant(item => ({ content: `${item.content || ''}${delta}`, status: 'streaming' }));
            return;
          }

          // Fallback: unnamed SSE events (no event: line) arrive as eventName "message".
          // Map data.type to the same actions as named events so streams that omit event
          // lines (e.g. plain data: JSON) still render correctly.
          if (eventName === 'message') {
            if (data?.type === 'text_delta' && data?.text) {
              setActivityLabel('Responding…');
              updateAssistant(item => ({ content: `${item.content || ''}${data.text}`, status: 'streaming' }));
            }
            return;
          }

          if (eventName === 'response.output_text.done') {
            const finalText = normalizeContent(data?.text || data?.output_text || data);
            if (finalText) updateAssistant({ content: finalText, status: 'streaming' });
            return;
          }

          if (eventName === 'response.failed' || eventName === 'error') {
            throw new Error(data?.error?.message || data?.message || data?.error || 'OpenClaw stream failed');
          }

          if (eventName === 'done' || eventName === 'response.completed') {
            setActivityLabel('');
            updateAssistant({ status: 'completed', createdAt: new Date().toISOString() });
          }
        }
      });

      setComposer('');
      attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      setAttachments([]);
      updateAssistant(item => ({ status: 'completed', content: item.content || '[No text response]' }));
      onSendComplete?.({ sessionId: selectedSessionId });
    } catch (err) {
      if (err?.name === 'AbortError') {
        updateAssistant(item => ({ status: 'completed', content: item.content || '[Stopped]' }));
      } else {
        setMessages(current => current.filter(item => item.id !== assistantMessageId));
        onError(err.message || 'Failed to send message');
      }
    } finally {
      abortControllerRef.current = null;
      setSending(false);
      setActivityLabel('');
    }
  }, [composer, attachments, selectedSessionId, sending, apps, context, setComposer, setAttachments, setSending, onError, onSendComplete]);

  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  return {
    messages,
    activityLabel,
    messagesLoading,
    messagesEndRef,
    loadMessages,
    handleSend,
    handleStop
  };
}
