// Voice fast-resolution cascade. A spoken/typed turn is triaged CLIENT-SIDE
// through three tiers so common turns never wait on the (slow) server LLM:
//
//   tier 1  trigger  — deterministic nav/command matching (instant, offline).
//                      "go to tasks" → navigate, no LLM at all.
//   tier 2  nano     — Chrome's on-device "Gemini Nano" answers simple/chatty
//                      turns in the browser (fast, private). It can also reply
//                      ESCALATE to punt a turn it shouldn't handle.
//   tier 3  server   — the existing pipeline (recommend Ollama) handles every
//                      tool/action turn, retrieval, and anything the fast tiers
//                      decline or can't run.
//
// This module is the pure DECISION layer: given a transcript + context it
// returns a `{ tier, ... }` decision. The caller (VoiceWidget) executes it —
// navigate + speak for trigger, speak for nano, send-to-server for server.
// Kept side-effect-free (aside from the injected Nano call) so the routing
// rules are unit-testable.

import { promptNano, nanoAvailability, NANO_AVAILABILITY } from './browserLlm';

export const TIER = Object.freeze({ TRIGGER: 'trigger', NANO: 'nano', SERVER: 'server' });

// ─── Tier 1: trigger nav ───────────────────────────────────────────────────
// Only fire on an explicit navigation verb ("go to X", "open X") so a
// conversational turn that merely mentions a page name doesn't teleport the
// user. The remainder after the verb is matched against the palette nav
// manifest (same entries ⌘K uses), so this stays in sync with real routes.
const NAV_LEAD_IN = /^\s*(?:go\s+to|open(?:\s+up)?|take\s+me\s+to|show\s+me|navigate\s+to|switch\s+to|bring\s+up|jump\s+to|pull\s+up|let'?s\s+go\s+to)\s+(?:the\s+|my\s+|our\s+)?(.+?)\s*$/i;
const NAV_TRAILING = /\s+(?:page|tab|screen|view|section)\s*$/i;

// Normalize a label / alias / spoken target to a comparable form: lowercase,
// with every run of non-alphanumerics (hyphens, underscores, punctuation,
// spaces) collapsed to a single space. This is what lets the spoken "voice
// settings" match the hyphenated alias "voice-settings" as an EXACT hit —
// without it the phrase fell through to a loose substring match on the generic
// "settings" and navigated to the wrong page.
const normNav = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Resolve a spoken/typed phrase to a nav entry by WORD OVERLAP against each
// entry's label + aliases (keywords are deliberately ignored — too broad).
// Word-set matching is what makes "catalog settings" beat the generic
// "settings": the Catalog page shares BOTH words ("catalog" + "settings") via
// its `settings-catalog` alias, while the generic Settings page shares only
// "settings" — regardless of word order or hyphenation.
//
// Acceptance is deliberately high-precision (better to fall through to the
// server than navigate somewhere wrong):
//   • an EXACT alias/label match, or
//   • an entry whose names cover ALL the spoken words.
// A nav lead-in ("go to X") isn't required — a terse "database settings" also
// resolves — but WITHOUT a lead-in we additionally require ≥2 spoken words (and
// ≤5) so ordinary one-word chatter and long sentences never teleport.
export const resolveNavIntent = (text, navEntries = []) => {
  const m = String(text || '').match(NAV_LEAD_IN);
  const hadLeadIn = !!m;
  const target = (hadLeadIn ? normNav(m[1]) : normNav(text)).replace(NAV_TRAILING, '').trim();
  if (!target || !Array.isArray(navEntries)) return null;
  const targetWords = target.split(' ').filter(Boolean);
  const targetSet = new Set(targetWords);
  const targetCompact = target.replace(/\s+/g, '');
  const isExact = (n) => n === target || n.replace(/\s+/g, '') === targetCompact;

  let best = null;
  for (const e of navEntries) {
    if (!e || typeof e.path !== 'string') continue;
    const label = normNav(e.label);
    const aliases = (Array.isArray(e.aliases) ? e.aliases : []).map(normNav).filter(Boolean);
    const words = new Set();
    let exactAlias = false;
    let exactLabel = false;
    if (label) { if (isExact(label)) exactLabel = true; for (const w of label.split(' ')) if (w) words.add(w); }
    for (const a of aliases) { if (isExact(a)) exactAlias = true; for (const w of a.split(' ')) if (w) words.add(w); }
    let shared = 0;
    for (const w of targetSet) if (words.has(w)) shared += 1;
    const coversAll = shared > 0 && shared === targetSet.size;
    // An explicit alias hit outranks an incidental label hit ("settings" as an
    // alias of General beats the MeatSpace page that merely has the label
    // "Settings"). Full word-coverage beats partial; tighter entries (fewer
    // extra words) break ties.
    let score;
    if (exactAlias) score = 1000 - words.size;
    else if (exactLabel) score = 990 - words.size;
    else if (coversAll) score = 500 + shared * 10 - words.size;
    else score = shared * 100 - words.size; // partial: ranked, but gated out below
    if (score > (best?.score ?? -Infinity)) {
      best = { path: e.path, label: e.label || label, exact: exactAlias || exactLabel, coversAll, score };
    }
  }
  if (!best || !(best.exact || best.coversAll)) return null;
  if (!hadLeadIn && (targetWords.length < 2 || targetWords.length > 5)) return null;
  return { path: best.path, label: best.label };
};

// ─── Escalation gate: clear action/tool intents ─────────────────────────────
// Turns that need the server's tool pipeline (capture, dictation, UI-driving,
// personal-data retrieval, system control, timers, goals). Deliberately BROAD
// and biased toward escalation: over-escalating just forgoes a latency win
// (server still answers correctly), while under-escalating would let Nano give
// a chatty non-action reply to a turn that needed a tool.
const ACTION_INTENT = /\b(save|capture|remember|note (this|that|down)|jot|file (this|that|it)|add (a |an |the )?(note|task|reminder|event|goal|entry|item)|create (a |an |the )|make (a |an )?(note|task|list|log|entry|goal)|dictate|dictation|record (my|the) (log|journal)|log (this|that|it|today)|append|delete|remove|rename|restart|reboot|shut ?down|kill|pm2|(update|log).{0,20}\bgoal\b|set (a |an )?(timer|reminder|alarm)|remind me|what did i|when did i|have i|do i (prefer|usually|normally|like|tend)|my (goals?|tasks?|notes?|schedule|calendar|inbox|preferences|journal|log)|read (this|the page|it aloud|to me)|fill (in|out|the)|type .* (in|into)|click (the|on)|select .* from|check the|uncheck)\b/i;

export const isActionIntent = (text) => ACTION_INTENT.test(String(text || '').toLowerCase());

// Meta / capability questions ("what can you do", "what tools do you have",
// "what are my options"). The on-device Nano tier has no knowledge of the
// server's tools, so if it answered it would wrongly say "I don't have any
// tools." Route these to the server, which knows its real tool set + persona.
const CAPABILITY_QUERY = /\bwhat (?:can|do) you (?:do|help|assist|offer)\b|\bwhat (?:tools|capabilities|abilities|options|features|commands)\b|\bwhich tools\b|\byour (?:tools|capabilities|abilities)\b|\bwhat can i (?:ask|say|do|tell)\b|\bwhat are (?:my|your) (?:options|tools|capabilities|features)\b/i;

export const isCapabilityQuery = (text) => CAPABILITY_QUERY.test(String(text || '').toLowerCase());

// ─── Server-only follow-ups (confirmation / bare yes-no) ────────────────────
// A destructive-action confirmation gate lives server-side; the "yes"/"cancel"
// that answers it MUST reach the server, not Nano. Detect it two ways: the
// prior assistant line looked like the gate prompt, or the utterance is a bare
// affirmation/denial (rare as genuine chat, safe to route server-side).
const CONFIRM_PROMPT_RE = /confirm by saying|say ["']?yes["']? or ["']?cancel["']?|looks destructive/i;
const BARE_CONFIRM_RE = /^(yes|yeah|yep|yup|sure|confirm|confirmed|do it|go ahead|okay do|no|nope|cancel|nevermind|never mind)\b[.!\s]*$/i;

export const looksLikeConfirmationFollowup = (text, lastAssistantReply) =>
  CONFIRM_PROMPT_RE.test(String(lastAssistantReply || '')) || BARE_CONFIRM_RE.test(String(text || '').trim());

// ─── Tier 2: Nano routing prompt + reply hygiene ────────────────────────────
export const buildRouterSystemPrompt = (personality = {}) => {
  const name = personality?.name || 'the assistant';
  const style = personality?.speechStyle ? ` Speak in a ${personality.speechStyle} tone.` : '';
  return [
    `You are ${name}, a fast voice assistant. Your replies are spoken aloud, so keep them to one or two short plain-prose sentences — no markdown, lists, or headings.${style}`,
    'You can ONLY chat and answer general questions. You CANNOT take actions in the app.',
    'If the user asks you to DO something in the app — open or go to a page, save/capture/remember a note, dictate, add a task or reminder, check their personal data, control apps or services, set a timer, or run any tool — reply with EXACTLY the single word ESCALATE and nothing else.',
    "Also reply with EXACTLY ESCALATE if the request is about the user's own past, notes, preferences, goals, schedule, or files — you don't have access to those.",
    'Otherwise answer briefly.',
  ].join(' ');
};

// Escalate when the reply leads with ESCALATE, or is a short reply that is
// essentially just the ESCALATE token (models sometimes wrap it in quotes or
// add a trailing period).
export const isEscalate = (raw) => {
  const s = String(raw || '').trim();
  if (/^["'`]*\s*escalate\b/i.test(s)) return true;
  return s.length < 40 && /\bescalate\b/i.test(s);
};

// Trim Nano's reply to something speakable: drop wrapping quotes, keep at most
// two sentences, cap length (Nano over-talks past a "1–2 sentences" prompt).
export const cleanNanoReply = (raw) => {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  const sentences = s.match(/[^.!?]+[.!?]+/g);
  const trimmed = sentences ? sentences.slice(0, 2).map((x) => x.trim()).join(' ') : s;
  return trimmed.slice(0, 300);
};

/**
 * Triage one turn. Returns a decision the caller executes.
 *   { tier:'trigger', kind:'navigate', path, label }
 *   { tier:'nano',    reply }
 *   { tier:'server',  reason }
 *
 * @param {string} transcript
 * @param {object} ctx
 * @param {object} ctx.fastPath          cfg.llm.fastPath ({ triggers, browserLlm, browser })
 * @param {object} [ctx.personality]     cfg.llm.personality (name/speechStyle for Nano)
 * @param {Array}  [ctx.navEntries]      palette nav manifest entries
 * @param {boolean}[ctx.dictationActive] server dictation in progress → always server
 * @param {string} [ctx.lastAssistantReply] prior assistant line (confirmation detection)
 * @param {AbortSignal} [ctx.signal]
 */
export const resolveTurn = async (transcript, {
  fastPath = {},
  personality = {},
  navEntries = [],
  dictationActive = false,
  lastAssistantReply = '',
  signal,
} = {}) => {
  const text = String(transcript || '').trim();
  if (!text) return { tier: TIER.SERVER, reason: 'empty' };

  // State the server owns — never intercept these.
  if (dictationActive) return { tier: TIER.SERVER, reason: 'dictation' };
  if (looksLikeConfirmationFollowup(text, lastAssistantReply)) return { tier: TIER.SERVER, reason: 'confirm-followup' };

  // Tier 1 — deterministic trigger nav.
  if (fastPath.triggers) {
    const nav = resolveNavIntent(text, navEntries);
    if (nav) return { tier: TIER.TRIGGER, kind: 'navigate', path: nav.path, label: nav.label };
  }

  // Clear action/tool intents need the server tool pipeline — skip Nano.
  if (isActionIntent(text)) return { tier: TIER.SERVER, reason: 'action-intent' };
  // Capability/meta questions must be answered by the server (Nano doesn't know
  // the CoS tool set and would falsely claim it has none).
  if (isCapabilityQuery(text)) return { tier: TIER.SERVER, reason: 'capability-query' };

  // Tier 2 — on-device Nano for conversational turns.
  if (fastPath.browserLlm) {
    const avail = await nanoAvailability();
    if (avail !== NANO_AVAILABILITY.AVAILABLE) return { tier: TIER.SERVER, reason: `nano-${avail}` };
    const browser = fastPath.browser || {};
    let raw;
    try {
      raw = await promptNano(text, {
        systemPrompt: buildRouterSystemPrompt(personality),
        temperature: browser.temperature ?? 0.7,
        topK: browser.topK ?? 3,
        timeoutMs: 8000,
        signal,
      });
    } catch (err) {
      return { tier: TIER.SERVER, reason: `nano-error:${err.message}` };
    }
    if (isEscalate(raw)) return { tier: TIER.SERVER, reason: 'nano-escalate' };
    const reply = cleanNanoReply(raw);
    if (!reply) return { tier: TIER.SERVER, reason: 'nano-empty' };
    return { tier: TIER.NANO, reply };
  }

  return { tier: TIER.SERVER, reason: 'no-fast-tier' };
};
