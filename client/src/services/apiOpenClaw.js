/**
 * File browser / picker backend.
 */

import { API_BASE, request } from './apiCore.js';
import { openStreamResponse, readStreamFrames } from './streamResponse.js';

export const getOpenClawStatus = () => request('/openclaw/status', { silent: true });
export const getOpenClawSessions = () => request('/openclaw/sessions', { silent: true });
export const getOpenClawMessages = (sessionId, options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  const query = params.toString();
  return request(`/openclaw/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`, { silent: true });
};

export async function streamOpenClawMessage(sessionId, { message, context, attachments, signal, onEvent }) {
  const response = await openStreamResponse(fetch(`${API_BASE}/openclaw/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({ message, context, attachments }),
    signal
  }));
  await readStreamFrames(response, {
    format: 'sse',
    onFrame: ({ event, data: raw }) => {
      if (typeof onEvent !== 'function') return;
      if (raw === '[DONE]') {
        onEvent({ event: 'done', data: raw });
        return;
      }

      let data = raw;
      try { data = JSON.parse(raw); } catch { /* Keep the raw string. */ }
      onEvent({ event, data });
    },
  });
}
