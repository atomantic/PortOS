// Single designated recipient for proactive (server-initiated) voice output.
//
// The bug this fixes: proactive speech (proactiveSpeech.js) used
// `io.emit('voice:speak', …)`, which fans the audio to EVERY connected browser
// tab and EVERY federated machine at once — so a reminder/briefing plays
// simultaneously on all of them. Per-turn TTS (`voice:tts:audio`) is already
// single-socket (it replies to the tab that took the turn); only the proactive
// channel broadcast.
//
// The fix mirrors the single-attached-socket pattern in services/shell.js: a
// registry tracks every connected socket as a candidate, exactly one is the
// `primary` recipient, and proactive audio is routed only to that socket.
// Which tab is primary follows the user's focus — the tab you're actively
// looking at claims output (client emits `voice:output:claim` on focus /
// visibility / an explicit "make this tab the speaker" click). On the primary's
// disconnect, output is promoted to another live candidate so audio always has
// exactly one home while any tab is connected.
//
// Single-user trust model (see CLAUDE.md): no locking/atomicity needed here —
// one server process, one human. This is a re-entrancy-free in-memory registry.

// Insertion-ordered set of every connected socket. Insertion order lets
// promotion prefer the most-recently-registered live candidate (roughly "the
// newest tab") when the primary goes away without an explicit successor.
const candidates = new Set();
let primary = null;

// A socket is a viable recipient unless it has explicitly disconnected. Real
// Socket.IO sockets expose `.connected`; test doubles omit it, so `!== false`
// treats an absent flag as live.
const isLive = (socket) => !!socket && socket.connected !== false;

// Prune any candidate that has gone away without a release call (defensive —
// disconnect normally calls releaseVoiceOutput). Returns the last live
// candidate as a promotion pick.
const pruneAndPickLatest = () => {
  let latest = null;
  for (const s of candidates) {
    if (isLive(s)) latest = s;
    else candidates.delete(s);
  }
  return latest;
};

// Register a socket as a possible voice-output recipient. Does NOT make it
// primary — opening a new tab shouldn't steal audio from the tab you're using.
// Promotion to primary happens lazily (getVoiceOutputSocket) or explicitly
// (claimVoiceOutput on focus/click).
export const registerVoiceOutputCandidate = (socket) => {
  if (!socket) return;
  candidates.add(socket);
};

// Make `socket` the sole proactive-output recipient. The user's active tab
// calls this (via the `voice:output:claim` socket event) on focus / visibility
// / explicit request. The previous primary is told it lost the binding so its
// UI can reflect the change; the new primary is told it now owns output.
export const claimVoiceOutput = (socket) => {
  if (!socket) return null;
  // Move to the end of the insertion order so promotion (pruneAndPickLatest)
  // prefers the most-recently-FOCUSED tab, not the most-recently-connected —
  // keeping "the tab you're looking at speaks" true through the disconnect path
  // (when the primary dies, the last tab you focused inherits output).
  candidates.delete(socket);
  candidates.add(socket);
  if (primary === socket) return socket;
  const prev = primary;
  primary = socket;
  if (isLive(prev) && prev !== socket) {
    prev.emit('voice:output:detached', { reason: 'claimed-elsewhere' });
  }
  socket.emit('voice:output:primary', { primary: true });
  console.log(`🔊 voice: output primary → ${socket.id ?? 'socket'}`);
  return socket;
};

// Drop a socket from the registry (on disconnect). If it was the primary,
// promote the latest remaining live candidate so proactive audio keeps a
// single home, and notify the successor that it now owns output.
export const releaseVoiceOutput = (socket) => {
  if (!socket) return;
  candidates.delete(socket);
  if (primary !== socket) return;
  primary = pruneAndPickLatest();
  if (primary) {
    primary.emit('voice:output:primary', { primary: true });
    console.log(`🔊 voice: output primary promoted → ${primary.id ?? 'socket'}`);
  }
};

// The current proactive-output recipient, or null when no tab is connected.
// Lazily promotes when there is no primary (or it has gone stale) so the very
// first proactive line after a connect still reaches exactly one tab even if no
// explicit claim has arrived yet.
export const getVoiceOutputSocket = () => {
  if (isLive(primary) && candidates.has(primary)) return primary;
  primary = pruneAndPickLatest();
  return primary;
};

// Route one voice-output event to the single designated recipient. Deliberately
// does NOT fall back to `io.emit` when no candidate is registered — broadcasting
// is the exact bug this module exists to prevent, and with any tab connected
// getVoiceOutputSocket() always returns one socket, so the only time there's no
// target is when nobody is connected (where a broadcast would reach nobody
// anyway). A proactive line reaching no one beats one reaching every
// tab/machine. `io` is retained in the signature for the caller/tests. Returns
// delivery metadata for logging/tests.
export const emitVoiceOutput = (io, event, payload) => {
  const target = getVoiceOutputSocket();
  if (target) {
    target.emit(event, payload);
    return { delivered: true, socketId: target.id ?? null };
  }
  return { delivered: false };
};

// Test helper — reset module state between cases.
export const __resetVoiceOutput = () => {
  candidates.clear();
  primary = null;
};
