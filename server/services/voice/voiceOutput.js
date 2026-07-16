// Single designated recipient for proactive (server-initiated) voice output.
//
// The bug this fixes: proactive speech (proactiveSpeech.js) used
// `io.emit('voice:speak', …)`, which fans the audio to EVERY connected browser
// tab and EVERY device at once — so a reminder/briefing plays simultaneously on
// all of them. Per-turn TTS (`voice:tts:audio`) is already single-socket (it
// replies to the tab that took the turn); only the proactive channel broadcast.
//
// The fix mirrors the single-attached-socket pattern in services/shell.js: a
// registry tracks each browser tab that announced itself (`voice:output:
// available`) as a candidate, exactly one is the `primary` recipient, and
// proactive audio is routed only to that socket. Which tab is primary follows
// the user's focus — the tab you're actively looking at claims output (client
// emits `voice:output:claim` on focus / visibility / an explicit "make this tab
// the speaker" click). On the primary's disconnect, output is promoted to the
// tab you focused most recently so audio always has exactly one home while any
// candidate is connected.
//
// Only sockets that announce are eligible: a federated peer's Socket.IO relay
// client lands on the same io.on('connection') but never announces, so it can't
// be elected and silently swallow audio. A client running a PRE-UPGRADE bundle
// (which predates the announce/claim protocol) also never announces — the
// `emitVoiceOutput` fallback covers that transient case.
//
// Single-user trust model (see CLAUDE.md): no locking/atomicity needed here —
// one server process, one human. This is a re-entrancy-free in-memory registry.

// Membership set of announced candidate sockets. Iteration order is connection
// order, used ONLY as the tiebreak when no candidate has ever claimed.
const candidates = new Set();
// Claim recency, keyed by socket — a monotonic sequence stamped each time a tab
// claims (focuses). Promotion prefers the highest sequence (most-recently
// focused) so a background tab that merely reconnected later can't inherit audio
// over a tab the user actually looked at. Connection order is the fallback only
// when NO surviving candidate has claimed.
const claimSeq = new Map();
let claimCounter = 0;
let primary = null;

// A socket is a viable recipient unless it has explicitly disconnected. Real
// Socket.IO sockets expose `.connected`; test doubles omit it, so `!== false`
// treats an absent flag as live.
const isLive = (socket) => !!socket && socket.connected !== false;

const forget = (socket) => {
  candidates.delete(socket);
  claimSeq.delete(socket);
};

// Pick the promotion successor: the live candidate with the most recent claim,
// or — when none has ever claimed — the latest-connected live candidate. Prunes
// dead candidates along the way (defensive — disconnect normally forgets them).
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
  candidates.add(socket);
  // Stamp claim recency so a later disconnect promotes the most-recently-focused
  // survivor (not merely the newest connection). Re-stamped on every claim.
  claimSeq.set(socket, ++claimCounter);
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
// promote the most-recently-focused remaining candidate so proactive audio keeps
// a single home, and notify the successor that it now owns output.
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
// registered. Lazily promotes when there is no primary (or it has gone stale) so
// the very first proactive line after a connect still reaches exactly one tab
// even if no explicit claim has arrived yet. Notifies the lazily-elected tab so
// its UI reflects that it is now the speaker (without this, a never-focused tab
// would play proactive audio while its indicator still read "muted").
export const getVoiceOutputSocket = () => {
  if (isLive(primary) && candidates.has(primary)) return primary;
  primary = pickSuccessor();
  if (primary) primary.emit('voice:output:primary', { primary: true });
  return primary;
};

// Route one voice-output event to the single designated recipient.
//
// Fallback to `io.emit` ONLY when no announced candidate exists. In normal
// operation every current-bundle browser tab announces, so there is always a
// candidate and this broadcast path is never taken — the single-recipient
// routing above is what fixes the play-on-every-tab bug. The fallback exists for
// backward compatibility: a client running a PRE-UPGRADE bundle (server was just
// updated, tab not yet reloaded) speaks the same unchanged `voice:speak` event
// but never announces, so without this its proactive audio would be silently
// dropped until the user reloads. Broadcasting reaches that stale tab; it also
// harmlessly reaches peer-relay sockets (they ignore `voice:speak`). Any
// transient multi-tab duplication only recurs among pre-upgrade tabs during an
// upgrade window and self-heals on reload.
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
