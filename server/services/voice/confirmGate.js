// Destructive-action confirmation gate.
//
// When the voice agent fires a `ui_click` whose resolved element label looks
// destructive (delete / remove / discard / reset / clear) we don't blindly
// click — instead the tool stashes a `pendingDestructive` record on the
// session state and returns a result asking the LLM to prompt the user for
// spoken confirmation. The user's NEXT spoken turn is intercepted by the
// voice pipeline (before the LLM runs) and routed through resolvePending():
//
//   "confirm" / "yes do it" / "go ahead" → re-issue the click side-effect
//   "no" / "cancel" / "stop"             → drop the pending click and send a
//                                          short spoken acknowledgement
//                                          ("Cancelled.") without running the
//                                          LLM
//   anything else (ambiguous)            → clear the pending state and fall
//                                          through to the normal LLM turn so
//                                          the user can do something else.
//
// Keeping this as a pure module (no I/O, no socket emits; the clock is
// injectable via `createdAt` / `now` parameters and only defaults to
// `Date.now()` for ergonomics at call sites) makes the state machine
// trivially testable.

// Conservative on purpose — false-negatives only mean the user clicks a Delete
// button without an extra confirm prompt, which mirrors a normal mouse click.
// False-positives ("Reset filters" → confirm gate) are mildly annoying but
// safe. Anchored on word boundaries so labels like "Cleared" / "Resettable"
// don't trip it.
export const DESTRUCTIVE_LABEL_RE = /\b(delete|remove|discard|reset|clear)\b/i;

// Both regex sets are anchored at start (^) AND end ($) so only short,
// stand-alone yes/no utterances are treated as a confirmation or cancellation.
// Sentences that *start* with a yes/no token but then keep going ("cancel the
// meeting", "stop the music", "yes I want to go to lunch") fall through to
// `passthrough` so the LLM can answer the new request — matching the
// module's documented contract that ambiguous input means the user has
// moved on. Trailing punctuation is stripped before matching.
// Optional leading "ok/okay " filler is allowed in NEGATIVE_RE so that
// "okay cancel" / "okay never mind" are correctly classified as cancellations
// rather than being eaten by AFFIRM_RE's bare "ok/okay" branch. resolvePending
// also checks negative BEFORE affirmative as belt-and-suspenders for any
// future affirmative tokens that happen to share a prefix with a negative.
const AFFIRM_RE = /^(?:confirm|yes(?:[, ]+(?:do it|please|delete|remove|clear|reset|discard))?|do it|go ahead|proceed|continue|affirmative|ok(?:ay)?)$/i;
const NEGATIVE_RE = /^(?:(?:ok(?:ay)?[, ]+)?(?:no|cancel|stop|nope|never ?mind|don'?t|abort|negative))$/i;

// Strip wrapping quotes AND trailing punctuation in either order:
// `"confirm".` / `"confirm."` / `confirm.` / `yes,` / `cancel;` /
// `yes:` should all normalize to the bare token. STT engines (Whisper
// especially) frequently emit a trailing comma after a yes/no when the
// user takes a beat ("yes, … delete it"), so commas/colons/semicolons
// have to be stripped too — otherwise `yes,` falls through to
// passthrough and the pending destructive action is silently discarded.
// Running the pair twice handles cases where punctuation is outside the
// closing quote AND where it's inside.
const normalize = (text) => {
  let s = (text || '').trim();
  for (let i = 0; i < 2; i++) {
    s = s.replace(/^["']+|["']+$/g, '').replace(/[.!?,;:]+$/, '');
  }
  return s;
};

export const isDestructiveLabel = (label) => DESTRUCTIVE_LABEL_RE.test(label || '');

export const isAffirmative = (text) => AFFIRM_RE.test(normalize(text));
export const isNegative = (text) => NEGATIVE_RE.test(normalize(text));

// Build the pending record. Caller (tools.js / pipeline.js) is responsible
// for placing it on `state.pendingDestructive` AND for supplying `createdAt`
// (defaults to Date.now() for ergonomics, but tests inject a fixed clock to
// keep the module deterministic). Keeping the shape canonical here means
// the pipeline never has to know the internal fields.
export const buildPending = ({ tool, args, target, createdAt = Date.now() }) => ({
  tool,
  args,
  target, // resolved DOM target: { ref, label, kind }
  createdAt,
});

// Decide what to do with the user's next utterance given a pending record.
// Returns one of:
//   { action: 'execute', pending }   — affirmative: re-issue the side effect
//   { action: 'cancel',  pending }   — negative: drop pending, send a short
//                                      acknowledgement instead of LLM turn
//   { action: 'passthrough' }        — no pending or ambiguous: clear pending
//                                      and let the normal LLM turn run
//
// Ambiguous input is treated as cancellation OF THE PENDING (the user moved on),
// but a passthrough rather than a cancel — the LLM should answer the new
// utterance normally without speaking a "cancelled" confirmation.
export const resolvePending = (pending, userText) => {
  if (!pending) return { action: 'passthrough' };
  // Check negative BEFORE affirmative — `AFFIRM_RE` matches bare leading
  // "ok"/"okay", so "okay cancel" / "okay never mind" would otherwise
  // execute the destructive action. Safe-by-default: if the user uttered
  // any cancel word in the sentence-leading position, take the cancel.
  if (isNegative(userText)) return { action: 'cancel', pending };
  if (isAffirmative(userText)) return { action: 'execute', pending };
  return { action: 'passthrough' };
};

// Stale-pending GC: a confirmation that's been waiting more than this long
// is treated as expired so a forgotten "yes" two minutes later can't re-fire
// a destructive action the user has moved past.
export const PENDING_TTL_MS = 60_000;

export const isExpired = (pending, now = Date.now()) =>
  !!pending && (now - (pending.createdAt || 0)) > PENDING_TTL_MS;
