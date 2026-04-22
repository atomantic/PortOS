// LM Studio streaming chat — SSE parser yielding token deltas via onDelta callback.

const LM_STUDIO_BASE = () => (process.env.LM_STUDIO_URL || 'http://localhost:1234')
  .replace(/\/+$/, '').replace(/\/v1$/, '');

// Approximate parameter count from LM Studio model id so 'auto' avoids a 70B
// when smaller, faster models are available. Returns Infinity for non-matches
// and utility models so they sort last rather than silently winning ties.
// Accepts "7B", "7 B", "7b", "1.5B" plus MoE ids like "8x7B" (ranked by total
// experts × per-expert size; checked first so the naive `\d+\s*b\b` match
// doesn't silently rank "8x7B" as 7B). Utility-model filter runs first and is
// case-insensitive so "BAAI/bge-embed" / "Cohere/rerank" are excluded even
// when they happen to contain a size token.
const sizeRank = (id) => {
  const normalized = String(id).toLowerCase();
  if (/embed|rerank/.test(normalized)) return Infinity;
  const moe = normalized.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/);
  if (moe) return parseFloat(moe[1]) * parseFloat(moe[2]);
  const m = normalized.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (m) return parseFloat(m[1]);
  return Infinity;
};

// Models known to speak OpenAI's structured `tool_calls` SSE fragments. When
// tools are attached, prefer one of these over a model that would either emit
// its own inline format (Granite's `<tool_call>[...]</tool_call>`) or silently
// bail on large tool schemas. Match against lowercased model id — vendor
// prefix (`lmstudio-community/`, `mistralai/`, `nousresearch/`, etc.) is
// routinely present and varies, so anchor on the model family token.
export const TOOL_CAPABLE_PATTERNS = [
  /qwen2\.5.*instruct/,
  /qwen3.*instruct/,
  /qwen3(\.\d+)?-?\d+b-2507/,    // Qwen3 / 3.5 / 3.6 non-thinking dated variants
  /qwen3\.5/,                     // Qwen3.5 family (e.g., qwen3.5-9b)
  /qwen3\.6/,                     // Qwen3.6 family
  /hermes-?3/,
  /mistral-small/,
  /mistral.*instruct-v0\.[3-9]/,
  /ministral.*instruct/,
  /ministral.*reasoning/,
  /devstral/,
  /llama-?3\.[1-9].*instruct/,
  /llama-?3\.[1-9].*tool/,
  /command-r(\+|-plus)?/,
  /functionary/,
];

// Explicit block-list for model families that do NOT emit OpenAI-format
// tool_calls even when LM Studio accepts the `tools` argument. Extracted from
// empirical testing; add new entries as they're observed. Still usable in
// no-tools mode — just filter them out when we need tool calling.
export const TOOL_INCOMPATIBLE_PATTERNS = [
  /granite-?3/,         // emits `<tool_call>[...]</tool_call>` inline content (parsed below)
  /gemma-?[23].*\b\d+m\b/, // small non-instruct gemmas
];

// Reasoning models burn 10–30s on internal `<think>` tokens before emitting
// the spoken reply. For a voice agent that's death — even short answers feel
// like the assistant froze. We try to suppress thinking via prompt directives
// and chat-template kwargs (see `streamChat`), but the only reliable speedup
// is to PREFER non-reasoning models when both kinds are installed.
export const REASONING_PATTERNS = [
  /reasoning/,
  /\br1\b/,
  /\bqwq\b/,
  /thinking/,
  /\bo1\b/,
  /deepseek-r1/,
];

export const isReasoningModel = (id) => {
  const n = String(id).toLowerCase();
  return REASONING_PATTERNS.some((re) => re.test(n));
};

export const isToolCapable = (id) => {
  const n = String(id).toLowerCase();
  if (TOOL_CAPABLE_PATTERNS.some((re) => re.test(n))) return true;
  return false;
};

const isToolIncompatible = (id) => {
  const n = String(id).toLowerCase();
  return TOOL_INCOMPATIBLE_PATTERNS.some((re) => re.test(n));
};

// Multi-key sort: non-reasoning before reasoning, then smaller before larger.
// Sort is stable in V8, so equal keys keep input order — list inputs in a
// preferred order if you want a tiebreaker beyond size.
const rankForSpeed = (id) => [isReasoningModel(id) ? 1 : 0, sizeRank(id)];
const sortBySpeed = (list) => list.slice().sort((a, b) => {
  const [ar, as] = rankForSpeed(a);
  const [br, bs] = rankForSpeed(b);
  if (ar !== br) return ar - br;
  return as - bs;
});

const resolveModel = async (requested, { requireTools = false } = {}) => {
  const res = await fetch(`${LM_STUDIO_BASE()}/v1/models`).catch(() => null);
  if (!res || !res.ok) return requested && requested !== 'auto' ? requested : null;
  const body = await res.json();
  const ids = (body?.data || []).map((m) => m.id);
  if (requested && requested !== 'auto') {
    return ids.includes(requested) ? requested : ids[0] || null;
  }
  // 'auto' selection priority for voice latency:
  //   1. tool-capable + non-reasoning, smallest first  (the sweet spot)
  //   2. tool-capable + reasoning, smallest first      (slow but works)
  //   3. anything not known-incompatible, smallest     (fallback)
  // Reasoning models are deprioritized because they pre-generate a
  // `<think>` block before any spoken token — fatal for voice TTFT even
  // when the final reply is short.
  if (requireTools) {
    const capable = ids.filter(isToolCapable);
    const sorted = sortBySpeed(capable);
    if (sorted[0]) return sorted[0];
    const safe = sortBySpeed(ids.filter((id) => !isToolIncompatible(id)));
    return safe[0] || ids[0] || null;
  }
  return sortBySpeed(ids)[0] || null;
};

// Parse IBM Granite / Llama-3 tool-use formats that are emitted as
// `delta.content` rather than structured `delta.tool_calls`. Granite 3.2 in
// practice emits BOTH `<tool_call>...</tool_call>` and `<tool_request>...`
// (bare, unclosed) forms — observed varying between requests against the same
// model with the same prompt. We handle: (a) the XML-tagged closed form, (b)
// the unclosed form, (c) either tag spelling.
const TOOL_TAG_SPELLINGS = ['tool_call', 'tool_request'];
const TOOL_CALL_CLOSED_RE = /<(tool_call|tool_request)>\s*(\[[\s\S]*?\])\s*<\/\1>/g;

const pushParsedCalls = (raw, toolCalls) => {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  let pushed = 0;
  for (const c of arr) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string') continue;
    toolCalls.push({
      index: toolCalls.length,
      id: `call_inline_${toolCalls.length}`,
      type: 'function',
      function: {
        name: c.name,
        arguments: JSON.stringify(c.arguments ?? c.parameters ?? {}),
      },
    });
    pushed++;
  }
  return pushed > 0;
};

// Walk `text` starting at `start` to find a balanced top-level JSON array.
// Returns [jsonText, endIdx] or null. Respects string quoting so a `]`
// inside a string literal doesn't prematurely close. Cheaper than pulling a
// full JSON parser just for boundary detection.
const scanBalancedArray = (text, start) => {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return [text.slice(start, i + 1).trim(), i + 1];
    }
  }
  return null;
};

export const extractInlineToolCalls = (text) => {
  if (!text) return { text: '', toolCalls: [] };
  const toolCalls = [];
  let cleaned = text;

  // 1) Closed-form tags: strip each matched block (matches either spelling).
  TOOL_CALL_CLOSED_RE.lastIndex = 0;
  let m;
  while ((m = TOOL_CALL_CLOSED_RE.exec(text)) !== null) {
    if (pushParsedCalls(m[2], toolCalls)) {
      cleaned = cleaned.split(m[0]).join('');
    }
  }

  // 2) Unclosed tag: `<tool_call>[...]` or `<tool_request>[...]` with no
  //    matching close. Granite often stops generating before closing.
  //    Try each spelling in order; scan from the opener position.
  for (const spelling of TOOL_TAG_SPELLINGS) {
    const open = `<${spelling}>`;
    const openAt = cleaned.indexOf(open);
    if (openAt === -1) continue;
    const arrStart = openAt + open.length;
    const arr = scanBalancedArray(cleaned, arrStart);
    if (arr && pushParsedCalls(arr[0], toolCalls)) {
      const close = new RegExp(`</${spelling}>\\s*`, 'g');
      cleaned = (cleaned.slice(0, openAt) + cleaned.slice(arr[1])).replace(close, '');
    }
  }

  return { text: cleaned.trim(), toolCalls };
};

/**
 * Stream an LM Studio chat completion. Text deltas are forwarded via onDelta
 * for TTS; tool_call fragments are buffered per-index and returned at the end
 * so the pipeline can execute them and loop.
 *
 * @param {Array<object>} messages
 * @param {object} opts
 * @param {string} [opts.model='auto']
 * @param {AbortSignal} [opts.signal]
 * @param {(delta: string) => void} [opts.onDelta]
 * @param {Array<object>} [opts.tools]  OpenAI-format tool specs (optional)
 * @returns {Promise<{ text: string, toolCalls: Array<object>, model: string|null, ttfbMs: number|null, totalMs: number, finishReason: string|null }>}
 */
export const streamChat = async (messages, opts = {}) => {
  const resolveStart = Date.now();
  const model = await resolveModel(opts.model, { requireTools: !!opts.tools?.length });
  const resolveMs = Date.now() - resolveStart;
  if (!model) throw new Error('No LM Studio model available');
  // Surface resolution time — non-trivial when LM Studio is warming up a new
  // model, and invisible otherwise because we only logged once the stream
  // finished. opts.tag lets the pipeline inject its turn id for correlation.
  const tag = opts.tag ? `[${opts.tag}] ` : '';
  console.log(`🤖 ${tag}lmstudio.resolve requested=${opts.model || 'auto'} → ${model} in ${resolveMs}ms`);

  const started = Date.now();
  // When the resolved model has a reasoning mode, try every known disable
  // switch — different model families honor different ones and unknown fields
  // are silently ignored by LM Studio:
  //   - Qwen3:    `/no_think` directive appended to last system message
  //   - Granite:  `chat_template_kwargs: { thinking: false }`
  //   - vLLM:     `chat_template_kwargs: { enable_thinking: false }`
  //   - generic:  `extra_body.thinking = false`, `reasoning_effort = "minimal"`
  // None of these are guaranteed to work — some models (DeepSeek-R1, native
  // o1) emit `<think>` unconditionally. The deprioritization in resolveModel
  // is the durable fix; this is best-effort speedup for the rare case where
  // a reasoning model is the only tool-capable option.
  const reasoning = isReasoningModel(model);
  const sentMessages = reasoning ? messages.map((m, i, arr) => {
    if (m.role !== 'system' || i !== arr.findLastIndex((x) => x.role === 'system')) return m;
    const directive = (m.content || '').includes('/no_think') ? '' : '\n/no_think';
    return { ...m, content: (m.content || '') + directive };
  }) : messages;

  const body = {
    model,
    messages: sentMessages,
    stream: true,
    temperature: 0.5,
    max_tokens: opts.maxTokens ?? 180,
  };
  if (reasoning) {
    body.chat_template_kwargs = { thinking: false, enable_thinking: false };
    body.reasoning_effort = 'minimal';
  }
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }

  const reqStart = Date.now();
  const res = await fetch(`${LM_STUDIO_BASE()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  console.log(`🤖 ${tag}lmstudio.headers ${res.status} in ${Date.now() - reqStart}ms`);
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`LM Studio chat failed: ${res.status} ${errBody.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  let text = '';
  let ttfbMs = null;
  let finishReason = null;
  // Tool calls stream as fragments keyed by index; accumulate until [DONE].
  const toolCallFrags = new Map();

  // Streaming tool-call stripper: when a model emits Granite-style inline
  // `<tool_call>[...]</tool_call>` or `<tool_request>[...]` in `delta.content`,
  // we must NOT forward those chunks to onDelta — the pipeline feeds deltas to
  // TTS and would speak the raw JSON. Reasoning models likewise emit `<think>`
  // blocks that should be hidden even when our disable directives don't take.
  // We still accumulate everything into `text` so the post-stream parser can
  // hoist into structured `toolCalls`. Tail characters that could be a partial
  // open/close tag are held across chunks. All tag spellings handled in parallel.
  const STRIP_TAGS = [...TOOL_TAG_SPELLINGS, 'think', 'thinking', 'reasoning'];
  const OPEN_TAGS = STRIP_TAGS.map((s) => `<${s}>`);
  const CLOSE_TAGS = STRIP_TAGS.map((s) => `</${s}>`);
  let activeClose = null; // set when we entered a tool block
  let tailHold = '';
  // Find the earliest match of any candidate in `data`, starting at 0.
  const earliestIndex = (data, candidates) => {
    let best = -1;
    let bestLen = 0;
    for (const c of candidates) {
      const i = data.indexOf(c);
      if (i !== -1 && (best === -1 || i < best)) { best = i; bestLen = c.length; }
    }
    return best === -1 ? null : [best, bestLen];
  };
  // Longest suffix of `data` that is a prefix of any candidate — characters we
  // must withhold because they might begin a real tag once more data arrives.
  const longestPrefixHold = (data, candidates) => {
    const max = Math.max(...candidates.map((c) => c.length - 1));
    const limit = Math.min(data.length, max);
    for (let k = limit; k > 0; k--) {
      const tail = data.slice(data.length - k);
      if (candidates.some((c) => c.startsWith(tail))) return k;
    }
    return 0;
  };
  const forwardClean = (chunk) => {
    let data = tailHold + chunk;
    tailHold = '';
    let out = '';
    while (data.length) {
      if (!activeClose) {
        const hit = earliestIndex(data, OPEN_TAGS);
        if (hit) {
          out += data.slice(0, hit[0]);
          const spelling = data.slice(hit[0] + 1, hit[0] + hit[1] - 1); // strip '<' and '>'
          activeClose = `</${spelling}>`;
          data = data.slice(hit[0] + hit[1]);
          continue;
        }
        const hold = longestPrefixHold(data, OPEN_TAGS);
        if (hold) {
          out += data.slice(0, data.length - hold);
          tailHold = data.slice(data.length - hold);
        } else {
          out += data;
        }
        data = '';
      } else {
        const i = data.indexOf(activeClose);
        if (i !== -1) {
          data = data.slice(i + activeClose.length);
          activeClose = null;
          continue;
        }
        const hold = longestPrefixHold(data, [activeClose]);
        if (hold) tailHold = data.slice(data.length - hold);
        data = '';
      }
    }
    if (out) opts.onDelta?.(out);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        return finalizeReturn();
      }
      // Malformed SSE frames (proxy keep-alive, truncated write) would otherwise
      // abort the whole turn; skip the line and keep streaming.
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const choice = obj?.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta || {};
      if (delta.content) {
        if (ttfbMs === null) ttfbMs = Date.now() - started;
        text += delta.content;
        forwardClean(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const frag = toolCallFrags.get(tc.index) || {
          index: tc.index,
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (tc.id) frag.id = tc.id;
        if (tc.type) frag.type = tc.type;
        // `name` is sent once per tool call per the OpenAI spec; set-once
        // rather than concatenate so a split fragment can't produce garbage.
        if (tc.function?.name && !frag.function.name) frag.function.name = tc.function.name;
        if (tc.function?.arguments) frag.function.arguments += tc.function.arguments;
        toolCallFrags.set(tc.index, frag);
      }
    }
  }
  return finalizeReturn();

  function finalizeReturn() {
    const streamed = [...toolCallFrags.values()].sort((a, b) => a.index - b.index);
    // Post-stream: if the model emitted no structured tool_calls but wrote
    // Granite-style `<tool_call>[...]</tool_call>` in content, extract them
    // and clean the visible text. No-ops when the regex doesn't match.
    const { text: cleanedText, toolCalls: inlineCalls } = streamed.length
      ? { text, toolCalls: [] }
      : extractInlineToolCalls(text);
    const toolCalls = streamed.length ? streamed : inlineCalls;
    // Strip any `<think>...`/`<reasoning>...` blocks from the canonical text
    // too — the streaming stripper kept them out of TTS, but they'd still
    // pollute conversation history and the assistant.content we persist.
    const finalText = stripReasoningTags(cleanedText);
    return {
      text: finalText,
      toolCalls,
      model,
      ttfbMs,
      totalMs: Date.now() - started,
      finishReason,
    };
  }
};

const REASONING_TAG_RE = /<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi;
const stripReasoningTags = (text) => (text || '').replace(REASONING_TAG_RE, '').replace(/\s+/g, ' ').trim();
