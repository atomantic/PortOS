// Destructive-action confirmation gate.
//
// A `ui_click` whose resolved label looks destructive (delete / remove / discard /
// reset / clear) stashes a `pendingDestructive` record on session state and asks
// the LLM to prompt for spoken confirmation. The user's NEXT turn is intercepted
// by the voice pipeline (before the LLM) and routed through resolvePending():
// affirmative re-issues the click, negative drops it with a short acknowledgement,
// anything else clears it and falls through to the normal LLM turn.
//
// Pure module (no I/O, no socket emits; the clock is injectable via `createdAt` / `now`).

// Conservative on purpose: a false-negative is a normal click, a false-positive is
// mildly annoying but safe. Word-boundary anchored ("Cleared" doesn't trip it).
export const DESTRUCTIVE_LABEL_RE = /\b(delete|remove|discard|reset|clear)\b/i;

// Both regex sets are anchored at start AND end so only short stand-alone yes/no
// utterances count; "cancel the meeting" falls through to `passthrough`.
// NEGATIVE_RE allows a leading "ok/okay" so "okay cancel" isn't eaten by AFFIRM_RE.
const AFFIRM_RE = /^(?:confirm|yes(?:[, ]+(?:do it|please|delete|remove|clear|reset|discard))?|do it|go ahead|proceed|continue|affirmative|ok(?:ay)?)$/i;
const NEGATIVE_RE = /^(?:(?:ok(?:ay)?[, ]+)?(?:no|cancel|stop|nope|never ?mind|don'?t|abort|negative))$/i;

// Strip wrapping quotes AND trailing punctuation in either order (twice, since
// punctuation may sit inside or outside the quote). STT engines often emit
// `yes,` after a beat; without stripping it would fall through to passthrough
// and silently discard the pending action.
const normalize = (text) => {
  let s = (text || '').trim();
  for (let i = 0; i < 2; i++) {
    s = s.replace(/^["']+|["']+$/g, '').replace(/[.!?,;:]+$/, '');
  }
  return s;
};

export const isDestructiveLabel = (label) => DESTRUCTIVE_LABEL_RE.test(label || '');

// The label heuristic is a backstop: `data-voice-guard="confirm"` (client/src/services/
// domIndex.js) gates a control whose effect its label doesn't name, however it is
// relabeled. `entry` is a UI index entry carrying `guard` only when annotated.
export const requiresConfirmation = (entry) =>
  entry?.guard === 'confirm' || isDestructiveLabel(entry?.label);

export const isAffirmative = (text) => AFFIRM_RE.test(normalize(text));
export const isNegative = (text) => NEGATIVE_RE.test(normalize(text));

// Build the pending record. The caller places it on `state.pendingDestructive`
// and may inject `createdAt` (tests use a fixed clock).
export const buildPending = ({ tool, args, target, createdAt = Date.now() }) => ({
  tool,
  args,
  target, // resolved DOM target: { ref, label, kind }
  createdAt,
});

// Decide what to do with the next utterance given a pending record:
//   { action: 'execute', pending }  — affirmative: re-issue the side effect
//   { action: 'cancel',  pending }  — negative: drop pending, short acknowledgement
//   { action: 'passthrough' }       — none or ambiguous: clear pending, normal LLM turn
export const resolvePending = (pending, userText) => {
  if (!pending) return { action: 'passthrough' };
  // Negative BEFORE affirmative: AFFIRM_RE matches bare leading "ok", so "okay cancel" must not execute.
  if (isNegative(userText)) return { action: 'cancel', pending };
  if (isAffirmative(userText)) return { action: 'execute', pending };
  return { action: 'passthrough' };
};

// A pending confirmation older than this is expired so a forgotten "yes" can't re-fire it.
export const PENDING_TTL_MS = 60_000;

export const isExpired = (pending, now = Date.now()) =>
  !!pending && (now - (pending.createdAt || 0)) > PENDING_TTL_MS;
