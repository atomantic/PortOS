// Detect when an inbound voice transcript is actually the bot's own TTS being
// picked up by the user's microphone (laptop speakers + built-in mic, no
// headphones). Without this, the bot replies to its own speech and runs in a
// feedback loop until the user manually stops it.
//
// A mirror of this algorithm runs client-side in
// client/src/services/voiceClient.js for the Web Speech STT path (which
// produces transcripts in-browser and never sends audio to the server).
// KEEP THE TWO IN SYNC — same tokenizer, same thresholds, same window.
//
// Strategy — two stacked filters:
//   1. Length gate: utterances shorter than MIN_TOKENS_FOR_ECHO_CHECK words
//      are NEVER classified as echo. Barge-ins are typically short
//      ("wait", "stop", "actually no") while echoes are full sentences.
//      This single rule preserves user interrupts even when their words also
//      appear in TTS.
//   2. Trigram match: for longer utterances, share-counting against the
//      trigrams of recently-spoken TTS sentences. Two contiguous 3-word
//      windows aligning is strong evidence — coincidental overlap on common
//      words rarely produces multiple shared trigrams.
//
// Time-windowed: TTS sentences older than `windowMs` are ignored so an echo
// from 30 seconds ago can't suppress a legitimate later utterance.

export const ECHO_WINDOW_MS = 8000;
export const MIN_TOKENS_FOR_ECHO_CHECK = 4;
export const MIN_SHARED_TRIGRAMS = 2;

export const tokenize = (s) => (s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter(Boolean);

export const trigramsOf = (tokens) => {
  if (!Array.isArray(tokens) || tokens.length < 3) return [];
  const out = [];
  for (let i = 0; i + 3 <= tokens.length; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return out;
};

// Push a freshly-spoken TTS sentence into the per-socket echo memory and
// drop entries that have aged out. Mutates `recent` in place and returns it.
export const rememberTtsSentence = (recent, sentence, { now = Date.now(), windowMs = ECHO_WINDOW_MS } = {}) => {
  const tokens = tokenize(sentence);
  if (!tokens.length) return recent;
  // Expire stale entries before appending so the buffer doesn't grow unbounded.
  for (let i = recent.length - 1; i >= 0; i--) {
    if (now - recent[i].t > windowMs) recent.splice(i, 1);
  }
  recent.push({
    text: tokens.join(' '),
    trigrams: new Set(trigramsOf(tokens)),
    t: now,
  });
  return recent;
};

// Returns true iff the transcript is almost certainly the bot's own TTS
// echoed back. Default-false on any uncertainty so we never silently drop
// legitimate user input.
export const isEchoOfRecentTts = (transcript, recent, { now = Date.now(), windowMs = ECHO_WINDOW_MS } = {}) => {
  const tokens = tokenize(transcript);
  if (tokens.length < MIN_TOKENS_FOR_ECHO_CHECK) return false;
  if (!Array.isArray(recent) || !recent.length) return false;

  const heardText = tokens.join(' ');
  const heardTrigrams = trigramsOf(tokens);
  if (!heardTrigrams.length) return false;

  for (const entry of recent) {
    if (now - entry.t > windowMs) continue;
    // Substring fallback: clean echo where heard ⊆ said.
    if (entry.text.includes(heardText)) return true;
    let shared = 0;
    for (const tg of heardTrigrams) {
      if (entry.trigrams.has(tg)) {
        shared += 1;
        if (shared >= MIN_SHARED_TRIGRAMS) return true;
      }
    }
  }
  return false;
};
