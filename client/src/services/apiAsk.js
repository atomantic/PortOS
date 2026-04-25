import { request, API_BASE } from './apiCore.js';

export const listAskConversations = () => request('/ask');
export const getAskConversation = (id) => request(`/ask/${encodeURIComponent(id)}`);
export const deleteAskConversation = (id) => request(`/ask/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const promoteAskConversation = (id, promoted = true) => request(`/ask/${encodeURIComponent(id)}/promote`, {
  method: 'POST',
  body: JSON.stringify({ promoted }),
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
  const response = await fetch(`${API_BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    let message = `HTTP ${response.status}`;
    // Server includes `{ error, context: { details: [{ path, message }] } }`
    // for zod validation failures — surface the first few field-level
    // messages so users see "question: required" instead of a flat "HTTP 400".
    if (text) {
      try {
        const parsed = JSON.parse(text);
        const baseError = parsed?.error || message;
        const details = parsed?.context?.details;
        if (Array.isArray(details) && details.length) {
          const fieldNotes = details.slice(0, 3).map((d) => d.path ? `${d.path}: ${d.message}` : d.message).filter(Boolean);
          message = fieldNotes.length ? `${baseError} — ${fieldNotes.join('; ')}` : baseError;
        } else {
          message = baseError;
        }
      } catch { /* response body wasn't JSON; keep the HTTP status message */ }
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Match the SSE parser used in `apiOpenClaw.js`: tolerate `\r\n\r\n`
  // separators (some proxies normalise line endings), preserve multi-line
  // `data:` frames by joining with `\n`, and strip the optional single
  // leading space from each data line per the SSE spec.
  const flushFrame = (frame) => {
    const lines = frame.split(/\r?\n/);
    let eventName = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) {
        const raw = line.slice(5);
        dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
      }
    }
    if (!dataLines.length) return;
    const rawData = dataLines.join('\n');
    let data;
    try { data = JSON.parse(rawData); } catch { data = { raw: rawData }; }
    onEvent?.({ event: eventName, data });
  };

  // Wrap the read loop so an abort or a thrown error still cancels the
  // underlying ReadableStream — otherwise the connection can stay half-open
  // longer than necessary. Mirrors the pattern in `apiOpenClaw.js`.
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) flushFrame(part);
    }

    // Flush any final un-terminated frame (server closed without a
    // trailing double newline).
    buffer += decoder.decode();
    if (buffer.trim()) flushFrame(buffer);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
