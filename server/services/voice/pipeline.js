// One conversational turn: audio → STT → streaming LLM (with tool-calling
// loop) → sentence-boundary TTS. If the model emits tool_calls, each is
// executed server-side, the result is appended to the message list, and the
// LLM is called again — up to cfg.llm.tools.maxIterations rounds.
// Caller supplies an `emit` callback (sockets/voice.js passes socket.emit)
// and an AbortSignal; aborting tears down the LLM stream and skips pending
// sentences.

import { transcribe } from './stt.js';
import { synthesize } from './tts.js';
import { streamChat } from './llm.js';
import { getVoiceConfig } from './config.js';
import { getToolSpecsForIntent, classifyIntent, dispatchTool, getAllToolNames, UI_KINDS } from './tools.js';
import { isEchoOfRecentTts, rememberTtsSentence } from './echo.js';
import { appendJournal, getToday } from '../brainJournal.js';

// Compact per-page UI summary the LLM uses to drive ui_* tools. Keep it
// short — every turn pays the token cost. Groups elements by kind and shows
// label only; full state (values, options) is still available through
// ui_list_interactables if the LLM needs more detail.
const UI_SUMMARY_MAX_CHARS = 4000;
const KIND_HEADINGS = {
  tab: 'Tabs (* = active)',
  button: 'Buttons',
  link: 'Links',
  input: 'Inputs',
  textarea: 'Textareas',
  select: 'Selects',
  checkbox: 'Checkboxes',
  radio: 'Radios',
};
const summarizeUi = (ui) => {
  if (!ui || !Array.isArray(ui.elements) || !ui.elements.length) return null;
  const groups = Object.fromEntries(UI_KINDS.map((k) => [k, []]));
  for (const e of ui.elements) {
    const g = groups[e.kind];
    if (!g) continue;
    let s = e.label;
    if (e.kind === 'tab' && e.active) s = `${s}*`;
    else if (e.kind === 'input' || e.kind === 'textarea') {
      const type = e.type && e.type !== 'text' ? `:${e.type}` : '';
      s = `${s}${type}`;
    } else if (e.kind === 'select' && Array.isArray(e.options)) {
      const opts = e.options.slice(0, 6).join('|');
      s = `${s}[${opts}${e.options.length > 6 ? '…' : ''}]`;
    } else if (e.kind === 'checkbox' || e.kind === 'radio') {
      s = `${s}${e.checked ? '(✓)' : ''}`;
    }
    g.push(s);
  }
  const parts = [];
  if (ui.title) parts.push(`Page: ${ui.title}${ui.path ? ` (${ui.path})` : ''}.`);
  for (const k of UI_KINDS) {
    if (groups[k].length) parts.push(`${KIND_HEADINGS[k]}: ${groups[k].slice(0, 40).join(', ')}.`);
  }
  const out = parts.join(' ');
  // Hard cap so a page with hundreds of long labels can't blow past the
  // LLM's practical context budget.
  return out.length > UI_SUMMARY_MAX_CHARS ? `${out.slice(0, UI_SUMMARY_MAX_CHARS - 1)}…` : out;
};

// Only inject the per-turn UI summary when the user is plausibly trying to
// drive the UI. Most voice turns ("what time", "how am I doing") don't need
// the 2–4 KB page snapshot, and the LLM can still call ui_list_interactables
// as an explicit fallback. Takes the pre-computed active group set so the
// same regex doesn't run twice per turn.
const shouldIncludeUi = (userText, activeGroups) => !userText || activeGroups?.has('ui');

// After a ui_* side effect fires, pause briefly for the client to push a
// fresh voice:ui:index so the next LLM iteration sees the post-action DOM
// (e.g., a modal that just opened). Resolves with the new ui snapshot or
// null on timeout/abort. Safe to call with no waiter infrastructure in
// state (e.g., in tests) — just times out.
const waitForUiRefresh = (state, timeoutMs, signal) => new Promise((resolve) => {
  if (!state) { resolve(null); return; }
  if (!Array.isArray(state.uiWaiters)) state.uiWaiters = [];
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    // Remove self from the pending list so timed-out/aborted waiters don't
    // accumulate across turns. Next voice:ui:index would fire them as
    // no-ops, but the array grows unbounded without this.
    const i = state.uiWaiters.indexOf(finish);
    if (i !== -1) state.uiWaiters.splice(i, 1);
    resolve(value);
  };
  const onAbort = () => finish(null);
  const timer = setTimeout(() => finish(null), timeoutMs);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  state.uiWaiters.push(finish);
});

export { summarizeUi, shouldIncludeUi };

const buildSystemPrompt = (cfg) => {
  if (!cfg.llm.usePersonality) return cfg.llm.systemPrompt;
  const p = cfg.llm.personality || {};
  const name = p.name || 'your Chief of Staff';
  const role = p.role || 'Chief of Staff';
  const lines = [
    `You are ${name}, ${role} for the user.`,
    'Your replies are spoken aloud — keep them short and use plain prose. No markdown, no lists, no headings, no code fences.',
  ];
  if (p.speechStyle) lines.push(`Speech style: ${p.speechStyle}.`);
  if (Array.isArray(p.traits) && p.traits.length) lines.push(`Personality: ${p.traits.join(', ')}.`);
  if (cfg.llm.tools?.enabled) {
    // Critical: with tools on, the model must ACTUALLY call them, not just
    // speak as if it did. Small models (Qwen3-4B etc.) frequently *narrate*
    // the action — they say "Opening your daily log" without ever issuing
    // the tool_call. Be explicit about navigation/dictation verbs in
    // addition to the original capture/save verbs, and tell the model not
    // to echo or paraphrase the user's request as its own reply.
    lines.push(
      'You have tools for acting on the user\'s behalf. ' +
      'You MUST call the matching tool whenever the user requests an action — ' +
      'never describe the action in words instead of calling the tool. ' +
      'Trigger phrases that REQUIRE a tool call: ' +
      '"open"/"go to"/"take me to"/"show me"/"navigate to" X → call ui_navigate with page=X. "Take me to tasks" → ui_navigate page="tasks". "Chief of staff agents" → ui_navigate page="agents". "Open calendar" → ui_navigate page="calendar". "Take me to the daily log" → ui_navigate page="daily log". Pick daily_log_open INSTEAD of ui_navigate only when the user clearly wants to WRITE/DICTATE — phrases like "start a new daily log", "let\'s make a log entry", "new daily log", "let me dictate to my log". Plain navigation to the daily log goes through ui_navigate. ' +
      '"Select X tab"/"switch to the X tab"/"click X"/"press the X button"/"pick Y from the Z dropdown"/"fill X with Y"/"check/uncheck X" — the LLM receives a compact "Current UI state" summary at the start of UI-driving turns listing Tabs, Buttons, Links, Inputs, Selects, Checkboxes. Use ui_click for tabs/buttons/links, ui_fill for text inputs, ui_select for dropdowns, ui_check for checkboxes. Pass the EXACT label shown in the UI summary. Prefer the `kind` argument when you have it (tab vs button). If the label isn\'t in the current UI summary, call ui_list_interactables OR ui_navigate first — do NOT guess. Active tab is marked with * in the summary; don\'t click it again. ' +
      'FORM FILL vs CAPTURE — CRITICAL: When the user directs content INTO a visible field ("fill description with X", "type X in the name field", "put X in the body", "enter X into title", "set the subject to X"), the target is the FIELD and X is the new value. ALWAYS call ui_fill with label=<field> and value=<X>. NEVER call brain_capture or daily_log_append for these turns — even when X contains words like "remember", "note", "save", or "jot", those are field content, not a request to capture to the inbox. Only use brain_capture when the user captures without referring to a page field ("remember to buy milk", "add this to my brain inbox", "save that for later"). ' +
      'CHAINED UI FLOWS: after a ui_navigate / ui_click / ui_fill / ui_select / ui_check succeeds, its tool result includes a `ui` field with the FRESH page state (a new page has loaded, a modal may have opened, a tab may have switched, new fields may be visible). Always re-read this `ui` field before choosing the next action — don\'t rely on the original per-turn UI summary after an action has fired. For multi-step flows like "create a task called Foo with description Bar": ui_click New Task → read result.ui → ui_fill Name=Foo → read result.ui → ui_fill Description=Bar → ui_click Save. Do it all in ONE turn, not one action per turn. Same for cross-page flows like "go to tasks and add a task called Foo": ui_navigate page="tasks" → read result.ui → ui_click New Task → read result.ui → ui_fill Name=Foo → ui_click Save, all in ONE turn. ' +
      'INTENT TO CREATE / WRITE in the daily log — phrases like "let\'s make a daily log", "let\'s make a new daily log", "start a daily log", "I want to make a log entry", "let me log something today", "new daily log", "let me add to my log" → call daily_log_open with startDictation=true. After this single tool call, STOP TALKING and let the user dictate freely — the dictation system handles every following utterance automatically without you. Do NOT say "I\'ll append it" or "what would you like to add" — the user already knows. Just confirm in one short sentence ("Daily log open, dictating now.") and stay quiet. ' +
      'When the user is asking you to write something specific into the daily log right now — phrases like "add to my daily log: X", "note in today\'s log that X", "write in my log: X", "log this in my daily log: X", "for my daily log: X" — you MUST call daily_log_append with the exact X text (everything AFTER the leading "add … to my log" / "note that" / "for my log" phrasing). NEVER reply with just a paraphrased "add to my daily log: …" line — that\'s narration; CALL daily_log_append. ' +
      'Empty-content intent — phrases that announce the user is about to dictate a note WITHOUT yet providing the note text — "add a note to my daily log" / "add another note to my daily log" / "add this other note to my daily log" / "I want to add to my log" / "let me add a note" — call daily_log_start_dictation (NOT daily_log_append, because there\'s no content to append yet). The user\'s next utterance will be captured by the dictation system. ' +
      'When the user describes a daily-life event in first person ("I did X today", "X happened today", "set up Y for Z today", "I had a nice walk", "the dishwasher broke") AND no specific tool fits better, the right tool is daily_log_append (NOT goal_log_note unless they explicitly named a goal). goal_log_note is ONLY for "log progress on my <goal-name> goal" / "update my <goal-name> goal with X" — there must be a real goal title in the user\'s words. Random life events like "set up the cat litter box" are daily_log_append, not goals. ' +
      '"save"/"capture"/"add"/"remember"/"note"/"file"/"log it" → matching capture tool (e.g., brain_capture, meatspace_log_*, daily_log_append, goal_log_note). ' +
      '"start dictation"/"dictate"/"record my log" → daily_log_start_dictation. ' +
      '"what time"/"what day"/"what date" → time_now. ' +
      '"what are my goals"/"my goals" → goal_list. ' +
      '"is anything crashed"/"pm2 status"/"are services up" → pm2_status. ' +
      'NEVER reply with just the user\'s request echoed back (e.g., user says "open my daily log" — do NOT reply "open my daily log"; CALL daily_log_open). ' +
      'NEVER paraphrase the action as your reply ("Sure, opening your daily log now") without first calling the actual tool. ' +
      'After the tool runs, confirm briefly in one short sentence. ' +
      'If you reference the brain inbox, call it "brain inbox" (not "green inbox").'
    );
  } else {
    // Prevent hallucinated actions when tools are disabled.
    lines.push('You cannot take actions right now — no tools are enabled. If the user asks you to save, add, or remember something, acknowledge the request and honestly say you can\'t file it yourself yet. Do not claim to have done anything.');
  }
  if (p.customPrompt) lines.push(p.customPrompt);
  return lines.join(' ');
};

const SENTENCE_RE = /[.!?\n](?:\s+|$)/;

// Exported for unit testing — the sentence-boundary logic is too central to
// leave untested.
export const splitSentences = (buffer) => {
  const out = [];
  let rest = buffer;
  while (true) {
    const m = rest.match(SENTENCE_RE);
    if (!m || m.index === undefined) break;
    const end = m.index + m[0].length;
    const sentence = rest.slice(0, end).trim();
    if (sentence) out.push(sentence);
    rest = rest.slice(end);
  }
  return { sentences: out, remainder: rest };
};

/**
 * Run one turn.
 *
 * @param {object} args
 * @param {Buffer} args.audio        — utterance audio bytes
 * @param {string} args.mimeType     — e.g. 'audio/webm', 'audio/wav'
 * @param {Array}  args.history      — prior conversation messages
 * @param {(event:string, payload:any) => void} args.emit
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ transcript: string, reply: string }>}
 */
// Whisper tags non-speech as bracketed markers like [BLANK_AUDIO], [MUSIC],
// [LAUGHTER], [INAUDIBLE]. Treat those as empty so we don't waste an LLM turn.
export const isNonSpeechMarker = (text) => /^\s*\[[A-Z_ ]+\]\s*$/i.test(text);

// Recognize spoken phrases that should end dictation without going through the
// LLM. Intentionally narrow — "I'm done writing" shouldn't match.
const STOP_DICTATION_RE = /^(stop|end|exit|cancel|pause)\s+(dictation|dictating|logging|recording)[\.\!\s]*$/i;

// Detect the narrate-instead-of-call failure: the LLM replied with text that
// claims it just performed an action ("I opened your daily log", "Navigating
// to tasks now", "Added that to your inbox") but no tool actually fired.
// Small tool-use models (Qwen3-4B / Hermes-3-8B class) still leak this
// occasionally even with the strong system-prompt biasing in buildSystemPrompt.
// The user hears a confident confirmation but nothing changed.
//
// Deliberately narrow: only fires on first-person action-claim phrasings, so
// conversational replies that happen to mention the same verbs ("I saved a
// file last year") don't false-positive. Exported for unit testing.
const ACTION_CLAIM_RE = /\b(?:I(?:'ve| have| just| already)?\s+(?:open(?:ed|ing)?|navigat(?:ed|ing)|sav(?:ed|ing)|add(?:ed|ing)|not(?:ed|ing)|captur(?:ed|ing)|remember(?:ed|ing)?|fill(?:ed|ing)|click(?:ed|ing)|select(?:ed|ing)|switch(?:ed|ing)|set|filed|logg(?:ed|ing))|(?:opening|navigating|saving|adding|noting|capturing|filing|logging|filling|clicking|selecting|switching)\s+(?:to\s+|your|the|that|this|it))\b/i;

// Catches the second narrate-without-call failure mode: the model emits the
// literal tool name as plain text ("ui_navigate page=\"daily_log\"",
// "I'll call daily_log_open"). Different shape from ACTION_CLAIM_RE — the
// model isn't claiming the action happened, it's writing the tool call out
// loud as if dictating to itself. Only fires when no tool actually ran.
//
// Built from the canonical tool list so it can't drift behind new tools.
const TOOL_NAME_AS_TEXT_RE = new RegExp(`\\b(?:${getAllToolNames().join('|')})\\b`, 'i');

export const detectNarrationWithoutCall = ({ finalText, toolRuns }) =>
  toolRuns?.length === 0 && !!finalText?.trim()
  && (ACTION_CLAIM_RE.test(finalText) || TOOL_NAME_AS_TEXT_RE.test(finalText));

// Short correlation id so overlapping turns in the logs can be told apart
// (user interrupts, late-arriving retries). 5 chars of base36 randomness is
// plenty for single-user PortOS.
const shortId = () => Math.random().toString(36).slice(2, 7);

export const runTurn = async ({ audio, text, mimeType, source, history = [], emit, signal, state }) => {
  const cfg = await getVoiceConfig();
  if (signal?.aborted) return { transcript: '', reply: '' };

  const turnStart = Date.now();
  const turnId = shortId();
  const elapsed = () => Date.now() - turnStart;
  const tlog = (msg) => console.log(`🎙️ [${turnId}] ${msg} +${elapsed()}ms`);

  tlog(`turn.start source=${text ? 'text' : 'audio'} ${text ? `chars=${String(text).length}` : `bytes=${audio?.byteLength || audio?.length || 0} mime=${mimeType || '—'}`}`);

  let userText = text;
  let sttLatencyMs = 0;
  if (!userText) {
    tlog(`stt.start`);
    const stt = await transcribe(audio, { mimeType, signal });
    sttLatencyMs = stt.latencyMs;
    userText = isNonSpeechMarker(stt.text) ? '' : stt.text;
    tlog(`stt.done ${sttLatencyMs}ms chars=${userText.length} text="${userText.slice(0, 80)}${userText.length > 80 ? '…' : ''}"`);
    emit('voice:transcript', { text: userText, latencyMs: stt.latencyMs });
  } else {
    // VoiceWidget treats transcripts with source !== 'text' as server-STT
    // output and appends them to the chat log. Web Speech already appended
    // the user's words locally on onFinal, so reclassifying this echo as
    // 'voice' would duplicate the message. Keep `source` stable and expose
    // the caller's routing hint separately so dictation/Origin-aware code
    // can still distinguish typed vs spoken without breaking chat history.
    tlog(`input.text chars=${userText.length} source=${source || 'text'} text="${userText.slice(0, 80)}${userText.length > 80 ? '…' : ''}"`);
    emit('voice:transcript', {
      text: userText,
      latencyMs: 0,
      source: 'text',
      inputSource: source || 'text',
    });
  }

  if (!userText) {
    tlog(`done empty-input stt=${sttLatencyMs}ms`);
    emit('voice:idle', { reason: 'empty-transcript' });
    return { transcript: '', reply: '' };
  }
  if (signal?.aborted) return { transcript: userText, reply: '' };

  // Echo gate: if the transcript looks like the bot's own TTS being picked
  // up by a laptop mic (built-in mic + speakers, no headphones), drop the
  // turn rather than feeding it to the LLM. Without this gate the bot
  // replies to its own voice and runs in a feedback loop.
  //
  // Only applies to spoken input — typed text never echoes. The detector is
  // length-gated (< 4 words always passes) so short barge-ins like "wait"
  // and "stop" still interrupt even if those words appear in TTS.
  if (state?.recentTts?.length && (!text || source === 'voice')) {
    if (isEchoOfRecentTts(userText, state.recentTts)) {
      console.warn(`🔇 [${turnId}] dropping TTS echo "${userText.slice(0, 80)}"`);
      emit('voice:idle', { reason: 'echo-suppressed' });
      return { transcript: userText, reply: '' };
    }
  }

  // Dictation mode short-circuits the LLM: the user's speech goes straight
  // into the daily-log entry unless they say the stop phrase, which ends
  // dictation and falls through to a normal confirmation turn.
  //
  // Only applies to spoken input. Typed input (the "Read back" button,
  // assistant-issued sendText, manual typing) bypasses dictation so the
  // user can still drive the app while dictation is live. Web Speech mode
  // hands transcripts over as voice:text with source='voice', so we honor
  // that hint in addition to the no-text case.
  const isSpokenInput = !text || source === 'voice';
  if (isSpokenInput && state?.dictation?.enabled) {
    const trimmed = userText.trim();
    // STT can return whitespace-only transcripts (Whisper on silent audio,
    // trailing partials). Don't fire a bogus append event with { entry: null };
    // just go idle and wait for the next utterance.
    if (!trimmed) {
      emit('voice:idle', { reason: 'empty-transcript' });
      return { transcript: userText, reply: '' };
    }
    if (STOP_DICTATION_RE.test(trimmed)) {
      state.dictation = { enabled: false, date: null };
      emit('voice:dictation', { enabled: false });
      const reply = 'Dictation off.';
      const { wav, latencyMs } = await synthesize(reply, { signal });
      // Report the real synth latency so the client's TTS timing stats
      // reflect actual work, not a hardcoded zero.
      if (!signal?.aborted) emit('voice:tts:audio', { sentence: reply, wav, latencyMs });
      emit('voice:llm:delta', { delta: reply });
      emit('voice:llm:done', { text: reply });
      emit('voice:idle', { reason: 'turn-complete' });
      return { transcript: userText, reply };
    }
    // Defensive: dictation can be enabled without a date (e.g. UI toggle
    // without a date, or tool side-effect missing one). Default to today so
    // we never throw here and kill the user's dictation turn.
    let date = state.dictation.date;
    if (!date) {
      date = await getToday();
      state.dictation.date = date;
      console.warn(`🎙️  dictation missing date; defaulting to ${date}`);
      emit('voice:dictation', { enabled: true, date });
    }
    const entry = await appendJournal(date, trimmed, { source: 'voice' });
    // Ship only the delta (new segment + metadata) rather than the full
    // entry. `entry.content` and `entry.segments` grow over the day, so
    // emitting the whole record per utterance would push socket payload
    // size and serialization cost toward O(n²) during long dictation
    // sessions. The client patches local state from these fields.
    const segments = Array.isArray(entry?.segments) ? entry.segments : [];
    const segment = segments.length ? segments[segments.length - 1] : null;
    emit('voice:dailyLog:appended', {
      date,
      text: trimmed,
      segment,
      segmentCount: segments.length,
      updatedAt: entry?.updatedAt,
    });
    console.log(`🎙️  dictation → journal[${date}] +${trimmed.length} chars`);
    emit('voice:idle', { reason: 'dictation-appended' });
    return { transcript: userText, reply: '' };
  }

  const toolsEnabled = !!cfg.llm.tools?.enabled;
  const intent = toolsEnabled ? getToolSpecsForIntent(userText) : { specs: undefined, activeGroups: classifyIntent(userText) };
  const toolSpecs = intent.specs;

  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
  ];
  if (shouldIncludeUi(userText, intent.activeGroups)) {
    const uiSummary = summarizeUi(state?.ui);
    if (uiSummary) {
      messages.push({
        role: 'system',
        content: `Current UI state — use ui_click / ui_fill / ui_select / ui_check to drive these. Names shown are the exact labels; pass them as the "label" argument. ${uiSummary}`,
      });
    }
  }
  messages.push(...history, { role: 'user', content: userText });
  const maxIterations = Math.max(1, cfg.llm.tools?.maxIterations ?? 3);

  let pending = '';
  const ttsTimings = [];
  let ttsIdx = 0;
  const speak = async (sentence) => {
    if (signal?.aborted || !sentence) return;
    const i = ++ttsIdx;
    const t0 = Date.now();
    tlog(`tts.start #${i} chars=${sentence.length}`);
    const { wav, latencyMs } = await synthesize(sentence, { signal });
    if (signal?.aborted) return;
    ttsTimings.push(latencyMs);
    tlog(`tts.done  #${i} ${latencyMs}ms synth+queue=${Date.now() - t0}ms`);
    // Track what we just said so the next inbound transcript can be checked
    // for echo. Done before emit so an immediately-arriving STT result on
    // the next event-loop tick already sees this sentence in the buffer.
    if (state?.recentTts) rememberTtsSentence(state.recentTts, sentence);
    emit('voice:tts:audio', { sentence, wav, latencyMs });
  };

  let synthQueue = Promise.resolve();
  const flushSentence = (delta) => {
    pending += delta;
    const { sentences, remainder } = splitSentences(pending);
    pending = remainder;
    for (const s of sentences) {
      synthQueue = synthQueue.then(() => speak(s)).catch((err) => {
        // Barge-in aborts the turn mid-synthesis — Kokoro throws Error('aborted')
        // and Piper rejects 'piper synthesis aborted'. That's expected, not a
        // real failure, so don't surface it as voice:error.
        if (signal?.aborted || /aborted/i.test(err?.message || '')) return;
        emit('voice:error', { stage: 'tts', message: err.message });
      });
    }
  };

  let firstLlm = null;
  let lastLlm = null;
  let finalText = '';
  const toolRuns = []; // [{ name, ok, ms, error }]

  for (let iter = 0; iter < maxIterations; iter++) {
    if (signal?.aborted) break;

    const iterStart = Date.now();
    let firstDeltaAt = null;
    let deltaChars = 0;
    tlog(`llm.start iter=${iter + 1}/${maxIterations} model=${cfg.llm.model} tools=${toolSpecs?.length || 0} msgs=${messages.length}`);
    const llm = await streamChat(messages, {
      model: cfg.llm.model,
      signal,
      tools: toolSpecs,
      tag: turnId,
      onDelta: (delta) => {
        if (firstDeltaAt === null) {
          firstDeltaAt = Date.now();
          tlog(`llm.ttft  iter=${iter + 1} ${firstDeltaAt - iterStart}ms model=${lastLlm?.model || cfg.llm.model}`);
        }
        deltaChars += delta.length;
        emit('voice:llm:delta', { delta });
        flushSentence(delta);
      },
    });
    if (!firstLlm) firstLlm = llm;
    lastLlm = llm;
    tlog(`llm.done  iter=${iter + 1} ${Date.now() - iterStart}ms model=${llm.model} text=${(llm.text || '').length}c spoken=${deltaChars}c tool_calls=${llm.toolCalls?.length || 0} finish=${llm.finishReason ?? '—'}`);
    // Accumulate spoken text across tool-calling iterations. The old single-
    // assignment version dropped every earlier segment, so the persisted
    // `reply` (and next turn's history) diverged from what the user actually
    // heard when the model spoke before/between tool calls.
    if (llm.text) finalText += (finalText ? ' ' : '') + llm.text;

    if (!llm.toolCalls?.length) break;

    // Assign stable IDs up-front so the assistant's tool_calls[].id and each
    // tool response's tool_call_id are guaranteed to match, even when the
    // upstream stream omitted tc.id. Previously the fallback `call_<index>`
    // was computed only at the tool-response side, so the assistant entry
    // could carry a different id and the next LLM iteration wouldn't pair
    // the result with the call.
    const callsWithIds = llm.toolCalls.map((tc, i) => ({
      ...tc,
      resolvedId: tc.id || `call_${iter}_${tc.index ?? i}`,
    }));

    // Persist the assistant's tool-call turn, then execute each call and
    // feed the result back as a 'tool' message for the next iteration.
    messages.push({
      role: 'assistant',
      content: llm.text || null,
      tool_calls: callsWithIds.map((tc) => ({
        id: tc.resolvedId,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    for (const tc of callsWithIds) {
      if (signal?.aborted) break;
      const t0 = Date.now();
      let result;
      let args = {};
      const ctx = { sideEffects: [], state, signal };
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        const argSummary = Object.keys(args).length ? Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`).join(' ') : '—';
        tlog(`tool.start ${tc.function.name} ${argSummary}`);
        result = await dispatchTool(tc.function.name, args, ctx);
        const ms = Date.now() - t0;
        toolRuns.push({ name: tc.function.name, ok: true, ms });
        tlog(`tool.done  ${tc.function.name} ok ${ms}ms`);
      } catch (err) {
        const ms = Date.now() - t0;
        result = { ok: false, error: err.message };
        toolRuns.push({ name: tc.function.name, ok: false, ms, error: err.message });
        tlog(`tool.fail  ${tc.function.name} ${ms}ms err="${err.message}"`);
      }
      // Apply server-side side-effects (dictation state) and forward
      // client-facing side-effects (navigation) over the socket.
      for (const fx of ctx.sideEffects) {
        if (fx.type === 'dictation' && state) {
          // When disabling dictation, clear the date so it can't leak to the
          // UI or be picked up by the next enable. A stale date is worse than
          // null — it can cause surprising "jumped back to April 17" behavior.
          const enabled = !!fx.enabled;
          state.dictation = {
            enabled,
            date: enabled ? (fx.date || state.dictation?.date || null) : null,
          };
          emit('voice:dictation', { enabled: state.dictation.enabled, date: state.dictation.date });
        } else if (fx.type === 'navigate') {
          emit('voice:navigate', { path: fx.path });
        } else if (fx.type === 'ui:click') {
          emit('voice:ui:click', { target: fx.target });
        } else if (fx.type === 'ui:fill') {
          emit('voice:ui:fill', { target: fx.target, value: fx.value });
        } else if (fx.type === 'ui:select') {
          emit('voice:ui:select', { target: fx.target, option: fx.option });
        } else if (fx.type === 'ui:check') {
          emit('voice:ui:check', { target: fx.target, checked: fx.checked });
        }
      }
      // If the tool mutated the UI (including client-side navigation), pause
      // for the client's follow-up index push and attach the fresh summary to
      // the tool result so the next LLM iteration can chain the next action
      // against the new page state (e.g. click New Task → see the modal →
      // fill Name → click Save, all in one turn; or ui_navigate → see the
      // tasks page → click Add Task). Navigation involves a full React route
      // change and a 250ms INITIAL_DELAY_MS before the client flushes its
      // index, so give it a longer timeout than the ~120ms post-click push.
      const hasUiEffect = ctx.sideEffects.some((fx) => typeof fx.type === 'string' && fx.type.startsWith('ui:'));
      const hasNavigate = ctx.sideEffects.some((fx) => fx.type === 'navigate');
      if ((hasUiEffect || hasNavigate) && !signal?.aborted) {
        const tRefresh = Date.now();
        const timeoutMs = hasNavigate ? 1500 : 800;
        const refreshed = await waitForUiRefresh(state, timeoutMs, signal);
        tlog(`tool.refresh ${tc.function.name} ${refreshed ? 'ok' : 'timeout'} ${Date.now() - tRefresh}ms`);
        if (refreshed) {
          const summary = summarizeUi(refreshed);
          if (summary) result = { ...result, ui: summary };
        }
      }
      emit('voice:tool', { name: tc.function.name, args, result });
      messages.push({
        role: 'tool',
        tool_call_id: tc.resolvedId,
        content: JSON.stringify(result),
      });
    }
  }

  if (pending.trim()) synthQueue = synthQueue.then(() => speak(pending.trim()));
  await synthQueue;

  const totalMs = Date.now() - turnStart;
  const ttsTotal = ttsTimings.reduce((a, b) => a + b, 0);
  const inputKind = text ? 'text' : 'voice';
  const toolSummary = toolRuns.length
    ? ` · tools=${toolRuns.map((r) => `${r.name}(${r.ok ? `${r.ms}ms` : 'err'})`).join(',')}`
    : '';
  console.log(
    `🎙️ [${turnId}] turn.summary ${inputKind} ${totalMs}ms — ` +
    `stt=${sttLatencyMs}ms · ` +
    `llm[${lastLlm?.model}] ttft=${firstLlm?.ttfbMs ?? '—'}ms total=${lastLlm?.totalMs}ms finish=${lastLlm?.finishReason ?? '—'} · ` +
    `tts=${ttsTotal}ms (${ttsTimings.length} sentences)` +
    toolSummary
  );

  // Surface the silent-empty-reply case — most commonly caused by picking a
  // model that doesn't speak the OpenAI tool-calling API (e.g., IBM Granite,
  // which emits `<tool_call>[...]</tool_call>` inline in content), especially
  // when many tools are attached and the model bails with a zero-length
  // stream. Without this the user sees their transcript, then silence.
  if (!signal?.aborted && !finalText.trim() && toolRuns.length === 0) {
    const hint = toolsEnabled
      ? `Model ${lastLlm?.model || cfg.llm.model} returned no response. It may not support OpenAI tool-calling with ${toolSpecs?.length || 0} tools — try a tool-use model (Qwen2.5-Instruct, Hermes-3, Mistral) or disable voice tools in Settings.`
      : `Model ${lastLlm?.model || cfg.llm.model} returned no response.`;
    console.warn(`🎙️  empty LLM output — ${hint}`);
    emit('voice:error', { stage: 'llm', message: hint });
  } else if (!signal?.aborted && toolsEnabled && detectNarrationWithoutCall({ finalText, toolRuns })) {
    // Narrate-instead-of-call: the model claimed to do something but never
    // invoked a tool. User already heard the narration via TTS; surface a
    // toast so they know the action didn't actually happen and can rephrase.
    console.warn(`🎙️ [${turnId}] narrate-without-call user="${userText.slice(0, 80)}" reply="${finalText.slice(0, 120)}"`);
    emit('voice:error', {
      stage: 'llm',
      message: "I said I'd do that but didn't actually call the tool. Try rephrasing — e.g. \"open my daily log\" or \"go to tasks\".",
    });
  }

  emit('voice:llm:done', { text: finalText, model: lastLlm?.model, ttfbMs: firstLlm?.ttfbMs });
  emit('voice:idle', { reason: 'turn-complete' });
  return { transcript: userText, reply: finalText };
};
