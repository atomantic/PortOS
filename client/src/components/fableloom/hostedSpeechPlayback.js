/**
 * Play one hosted narration on the designated output and report how it ended.
 * The server commits a transition only for `ended` from this socket's turn.
 */

function report(socket, turnId, status) {
  socket?.emit('hosted:speech:done', { turnId, status });
}

export function abortHostedSpeech(playback) {
  if (!playback || playback.settled) return;
  playback.settled = true;
  playback.audio.onended = null;
  playback.audio.onerror = null;
  // Stop the element. A later `ended` would otherwise sound like a completion
  // the server has already been told to drop.
  try { playback.audio.pause(); } catch { /* element already gone */ }
  report(playback.socket, playback.turnId, 'aborted');
}

export function playHostedSpeech(audio, {
  socket,
  previous,
  turnId,
  target,
  expectedTarget,
  mimeType,
  audioBase64,
} = {}) {
  if (target !== expectedTarget) return previous || null;
  abortHostedSpeech(previous);
  if (!turnId || !socket) return null;
  if (!audio || !audioBase64) {
    report(socket, turnId, 'failed');
    return null;
  }

  const playback = { socket, audio, turnId, settled: false };
  const finish = (status) => {
    if (playback.settled) return;
    playback.settled = true;
    audio.onended = null;
    audio.onerror = null;
    report(socket, turnId, status);
  };
  audio.onended = () => finish('ended');
  audio.onerror = () => finish('failed');
  try {
    audio.src = `data:${mimeType || 'audio/wav'};base64,${audioBase64}`;
    const played = audio.play();
    played?.catch?.(() => finish('failed'));
  } catch {
    finish('failed');
  }
  return playback;
}
