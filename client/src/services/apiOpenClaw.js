import { API_BASE, request } from './apiCore.js';

export const getOpenClawStatus = () => request('/openclaw/status', { silent: true });
export const getOpenClawSessions = () => request('/openclaw/sessions', { silent: true });
export const getOpenClawMessages = (sessionId, options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  const query = params.toString();
  return request(`/openclaw/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`, { silent: true });
};

export const sendOpenClawMessage = (sessionId, message, context, attachments) => request(`/openclaw/sessions/${encodeURIComponent(sessionId)}/messages`, {
  method: 'POST',
  body: JSON.stringify({ message, context, attachments }),
  silent: true
});

export async function streamOpenClawMessage(sessionId, { message, context, attachments, signal, onEvent }) {
  const response = await fetch(`${API_BASE}/openclaw/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({ message, context, attachments }),
    signal
  }).catch((err) => {
    if (err?.name === 'AbortError') throw err;
    return null;
  });

  if (!response) {
    throw new Error('Server unreachable — check your connection and try again');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    const detailMessage = Array.isArray(error?.context?.details)
      ? error.context.details
          .map((d) => d?.message)
          .filter((m) => typeof m === 'string' && m.trim())
          .slice(0, 3)
          .join('; ')
      : '';
    throw new Error(detailMessage || error.error || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error('Streaming is unavailable for this response');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emit = (eventName, data) => {
    if (typeof onEvent === 'function') onEvent({ event: eventName, data });
  };

  const flushEventBlock = (block) => {
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      if (line.startsWith('data:')) {
        const raw = line.slice(5);
        dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
      }
    }

    if (dataLines.length === 0) return;
    const rawData = dataLines.join('\n');
    if (rawData === '[DONE]') {
      emit('done', '[DONE]');
      return;
    }

    let data = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // keep raw string
    }
    emit(eventName, data);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) flushEventBlock(part);
    }

    buffer += decoder.decode();
    if (buffer.trim()) flushEventBlock(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors to avoid masking the original error
    }
  }
}
