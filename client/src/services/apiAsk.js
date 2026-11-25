/**
 * Ask page (chat-like).
 */

import { request, API_BASE } from './apiCore.js';
import { openStreamResponse, readStreamFrames } from './streamResponse.js';

export const listAskConversations = (options) => request('/ask', options);
export const getAskConversation = (id) => request(`/ask/${encodeURIComponent(id)}`);
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// when it already renders its own error UI.
export const deleteAskConversation = (id, options = {}) => request(`/ask/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
export const promoteAskConversation = (id, promoted = true) => request(`/ask/${encodeURIComponent(id)}/promote`, {
  method: 'POST',
  body: JSON.stringify({ promoted }),
});

// One-click promotion of an assistant turn to a Brain note, CoS task, or Goal
// progress entry. `payload` shape matches the server's discriminated union:
//   { target: 'brain' }
//   { target: 'task', priority?: 'LOW'|'MEDIUM'|'HIGH' }
//   { target: 'goal', goalId: string }
export const promoteAskTurn = (conversationId, turnId, payload, options = {}) =>
  request(`/ask/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/promote`, {
    method: 'POST',
    body: JSON.stringify(payload),
    ...options,
  });

/**
 * Stream an Ask turn via Server-Sent Events. Consumes the event-stream
 * response from POST /api/ask manually because EventSource only supports GET.
 *
 * Returns an AbortController.signal-aware Promise that resolves when the
 * server closes the stream. Each event is delivered to `onEvent({ event, data })`.
 *
 * Events: 'open' | 'sources' | 'delta' | 'error' | 'done'
 */
export async function streamAskTurn(payload, { onEvent, signal } = {}) {
  const response = await openStreamResponse(fetch(`${API_BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  }));
  await readStreamFrames(response, {
    format: 'sse',
    onFrame: ({ event, data: raw }) => {
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw }; }
      onEvent?.({ event, data });
    },
  });
}
