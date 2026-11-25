/** Opens fetch-based streaming responses and reads SSE or NDJSON frames to completion or cancellation. */

import { createServerUnreachableError, throwStreamApiError } from './apiCore.js';

export async function openStreamResponse(fetchPromise) {
  const response = await fetchPromise.catch((error) => {
    if (error?.name === 'AbortError') throw error;
    throw createServerUnreachableError();
  });
  if (!response.ok) await throwStreamApiError(response);
  if (typeof response.body?.getReader !== 'function') throw new Error('This browser cannot read a streamed response');
  return response;
}

function consumeSseFrame(frame, onFrame) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length) return onFrame({ event, data: dataLines.join('\n') });
}

function consumeNdjsonFrame(data, onFrame) {
  if (data.trim()) return onFrame({ event: 'message', data });
}

// Returns true when the caller stops on a frame and false on EOF.
export async function readStreamFrames(response, { format, fatal = false, onFrame }) {
  const decoder = new TextDecoder('utf-8', { fatal });
  const reader = response.body.getReader();
  const separator = format === 'sse' ? /\r?\n\r?\n/ : /\r?\n/;
  const consume = format === 'sse' ? consumeSseFrame : consumeNdjsonFrame;
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      try {
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      } catch (cause) {
        throw Object.assign(new Error('Stream contained invalid UTF-8', { cause }), { code: 'INVALID_STREAM_UTF8' });
      }
      const frames = buffer.split(separator);
      buffer = frames.pop() ?? '';
      if (done) frames.push(buffer);
      for (const frame of frames) {
        if (consume(frame, onFrame) === true) return true;
      }
      if (done) return false;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}
