// Single designated recipient for proactive (server-initiated) voice output.
//
// `io.emit('voice:speak')` would play a reminder on EVERY tab and device at once.
// Instead a registry tracks each tab that announced itself (`voice:output:available`),
// exactly one is `primary`, and proactive audio goes only to that socket. Primary
// follows focus (the client emits `voice:output:claim`); on the primary's disconnect
// it is promoted to the most recently focused tab.
//
// Only announcing sockets are eligible: a federated peer's relay client never
// announces, so it can't be elected and swallow audio. A PRE-UPGRADE client bundle
// also never announces; the `emitVoiceOutput` fallback covers that.
//
// In-memory and re-entrancy-free; no locking (see AGENTS.md trust model).

// Announced candidate sockets; iteration (connection) order is only the tiebreak when none has claimed.
const candidates = new Set();
// Claim recency per socket: a monotonic sequence stamped on each claim. Promotion
// prefers the highest, so a tab that merely reconnected later can't inherit audio
// over the one the user looked at; connection order is the fallback.
const claimSeq = new Map();
let claimCounter = 0;
let primary = null;

// Viable unless explicitly disconnected; test doubles omit `.connected`, so `!== false`.
const isLive = (socket) => !!socket && socket.connected !== false;

const forget = (socket) => {
  candidates.delete(socket);
  claimSeq.delete(socket);
};

// Pick the promotion successor: the live candidate with the most recent claim, or
// the latest-connected live one when none has claimed. Prunes dead candidates.
const pickSuccessor = () => {
  let latest = null;         // connection-order fallback
  let bestClaimed = null;
  let bestSeq = -1;
  for (const s of candidates) {
    if (!isLive(s)) { forget(s); continue; }
    latest = s;
    const seq = claimSeq.get(s) ?? -1;
    if (seq > bestSeq) { bestSeq = seq; bestClaimed = s; }
  }
  return bestSeq >= 0 ? bestClaimed : latest;
};

// Register a socket as a possible recipient. Does NOT make it primary (a new tab
// shouldn't steal audio); promotion is lazy (getVoiceOutputSocket) or explicit (claimVoiceOutput).
export const registerVoiceOutputCandidate = (socket) => {
  if (!socket) return;
  candidates.add(socket);
};

// Stamp claim recency so a later election picks the most-recently-focused tab.
const stampFocus = (socket) => {
  candidates.add(socket);
  claimSeq.set(socket, ++claimCounter);
};

// Record a focus claim while voice is disabled: stamp recency without electing a
// primary (or logging), and clear a primary held by another tab so the first
// election after re-enable follows focus.
export const noteVoiceOutputFocus = (socket) => {
  if (!socket) return;
  stampFocus(socket);
  if (!primary || primary === socket) return;
  const prev = primary;
  primary = null;
  if (isLive(prev)) prev.emit('voice:output:detached', { reason: 'claimed-elsewhere' });
};

// Make `socket` the sole proactive-output recipient (the active tab calls this via
// `voice:output:claim`). The previous primary is told it lost the binding.
export const claimVoiceOutput = (socket) => {
  if (!socket) return null;
  stampFocus(socket);
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
// promote the most-recently-focused remaining candidate and notify it.
export const releaseVoiceOutput = (socket) => {
  if (!socket) return;
  forget(socket);
  if (primary !== socket) return;
  primary = pickSuccessor();
  if (primary) {
    primary.emit('voice:output:primary', { primary: true });
    console.log(`🔊 voice: output primary promoted → ${primary.id ?? 'socket'}`);
  }
};

// The current proactive-output recipient, or null when no candidate tab is
// registered. Lazily promotes when there is no primary (or it went stale) and
// notifies the elected tab so its indicator doesn't read "muted" while playing.
export const getVoiceOutputSocket = () => {
  if (isLive(primary) && candidates.has(primary)) return primary;
  primary = pickSuccessor();
  if (primary) primary.emit('voice:output:primary', { primary: true });
  return primary;
};

// Route one voice-output event to the single designated recipient.
//
// Falls back to `io.emit` ONLY when no announced candidate exists. In normal
// operation every current-bundle tab announces, so this broadcast is never taken.
// It exists for a PRE-UPGRADE tab (server updated, tab not reloaded) that speaks
// the same `voice:speak` event but never announces; it also harmlessly reaches
// peer-relay sockets, which ignore `voice:speak`.
//
// Accepted limitation: if a pre-upgrade tab coexists with a current tab, the
// current tab wins and the old one is excluded until it reloads. Dual-protocol
// routing is not worth carrying for a brief upgrade window.
export const emitVoiceOutput = (io, event, payload) => {
  const target = getVoiceOutputSocket();
  if (target) {
    target.emit(event, payload);
    return { delivered: true, socketId: target.id ?? null };
  }
  if (io) {
    io.emit(event, payload);
    return { delivered: true, broadcast: true };
  }
  return { delivered: false };
};

// Test helper — reset module state between cases.
export const __resetVoiceOutput = () => {
  candidates.clear();
  claimSeq.clear();
  claimCounter = 0;
  primary = null;
};
