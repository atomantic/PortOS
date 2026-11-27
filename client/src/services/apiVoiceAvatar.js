// Manage the local Voice Call avatar and receive timestamped frames for assistant audio and continuous presence.
import { request, throwApiError } from './apiCore';

export const fetchVoiceAvatar = options => request('/voice/avatar/status', { signal: options?.signal, silent: true, hostControlOptional: true });
export const changeVoiceAvatar = (action, acceptTerms) => request('/voice/avatar/runtime', {
  method: 'POST', body: JSON.stringify({ action, ...(acceptTerms ? { acceptTerms: true } : {}) }), silent: true,
});

async function readAvatarFrameStream(response, onFrame) {
  if (!response.ok) await throwApiError(response);
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line) onFrame(JSON.parse(line));
      }
      if (pending.length > 256_000) throw new Error('Invalid avatar frame stream');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamVoiceAvatar(wav, { signal, onFrame }) {
  const response = await fetch('/api/voice/avatar/frames', {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav, signal,
  });
  await readAvatarFrameStream(response, onFrame);
}

export async function streamVoiceAvatarIdle({ stage = 'idle', signal, onFrame }) {
  const response = await fetch('/api/voice/avatar/idle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
    signal,
  });
  await readAvatarFrameStream(response, onFrame);
}
