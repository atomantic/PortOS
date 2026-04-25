/**
 * Ask Service
 *
 * Powers the "Ask Yourself" page — a retrieval-augmented chat with the user's
 * own digital twin. For each question:
 *
 *   1. Fan-out retrieval in parallel across memory (hybrid BM25 + vector),
 *      brain notes, autobiography stories, goals, and calendar events.
 *   2. Rerank + cap each source, then dedupe across sources.
 *   3. Assemble a persona-flavored prompt (twin tone + life context).
 *   4. Stream the completion through the active AI provider.
 *
 * The function exported here returns an async iterable of stream events:
 *   { type: 'sources', sources: Source[] }
 *   { type: 'delta', text: string }
 *   { type: 'done', usage?: {...} }
 *   { type: 'error', error: string }
 *
 * Routes consume this and forward as Server-Sent Events.
 */

import { getActiveProvider, getProviderById } from './providers.js';
import { hybridSearchMemories, getMemory } from './memoryBackend.js';
import { generateQueryEmbedding } from './memoryEmbeddings.js';
import { getInboxLog, getProjects, getIdeas } from './brainStorage.js';
import { getStories } from './autobiography.js';
import { getGoals } from './identity.js';
import { getCharacter } from './character.js';
import { getEvents as getCalendarEvents } from './calendarSync.js';
import { tokenize as bm25Tokenize, STOP_WORDS } from '../lib/bm25.js';

export const VALID_MODES = new Set(['ask', 'advise', 'draft']);
export const SOURCE_KINDS = ['memory', 'brain-note', 'autobiography', 'goal', 'calendar'];

const PER_SOURCE_LIMIT = {
  memory: 6,
  'brain-note': 5,
  autobiography: 3,
  goal: 5,
  calendar: 6,
};

// Truncation caps for prompt assembly. Source snippets are short summaries;
// transcript turns are previous chat turns trimmed so multi-turn history
// can't blow the token budget alone.
const SNIPPET_MAX_CHARS = 600;
const HISTORY_TURN_MAX_CHARS = 1500;
// Autobiography stories grow over time — cap how many we score per question
// so a user with hundreds of stories doesn't make every Ask quadratic.
const AUTOBIO_SCAN_LIMIT = 50;
// Calendar window default + cap. ±7 days covers the ambient "what do I have
// going on" case; the per-source cap on the result list does the rest.
const CALENDAR_DEFAULT_DAYS = 7;
const CALENDAR_FETCH_LIMIT = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PERSONA_FALLBACK = `You are the user's digital twin — speak in the first person, in their voice and with their values. Be direct, specific, and practical.`;

// =============================================================================
// PARALLEL RETRIEVAL
// =============================================================================

// `gatherSources` wraps every retriever in `Promise.allSettled`, so a thrown
// error here surfaces as `status: 'rejected'` rather than killing the answer
// — that's why these functions don't carry their own try/catch.

async function retrieveMemories(question) {
  const queryEmbedding = await generateQueryEmbedding(question);
  if (!queryEmbedding) return [];
  const result = await hybridSearchMemories(question, queryEmbedding, {
    limit: PER_SOURCE_LIMIT.memory,
    ftsWeight: 0.4,
    vectorWeight: 0.6,
  });
  const hits = result?.memories || [];
  // Single missing record shouldn't drop the whole batch — allSettled per id.
  const fetched = await Promise.allSettled(hits.map((h) => getMemory(h.id)));
  const sources = [];
  for (let i = 0; i < hits.length; i++) {
    const settled = fetched[i];
    const mem = settled.status === 'fulfilled' ? settled.value : null;
    if (!mem) continue;
    sources.push({
      kind: 'memory',
      id: `memory:${mem.id}`,
      title: mem.summary || mem.type || 'Memory',
      snippet: mem.content || '',
      relevance: hits[i].rrfScore || hits[i].similarity || 0.5,
      href: `/brain/memory?id=${encodeURIComponent(mem.id)}`,
      meta: { type: mem.type, importance: mem.importance, updatedAt: mem.updatedAt },
    });
  }
  return sources;
}

// askService scores by query-term overlap, not BM25 — but the tokenizer
// (lowercase, stopword-strip, punctuation-strip) is identical, so we share
// it with the BM25 module to keep stopword lists in lockstep.
function tokenize(text) {
  return bm25Tokenize(text).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function lexicalScore(text, queryTokens) {
  if (!queryTokens.length) return 0;
  const docTokens = tokenize(text);
  if (!docTokens.length) return 0;
  const docSet = new Set(docTokens);
  let hits = 0;
  for (const q of queryTokens) {
    if (docSet.has(q)) hits++;
  }
  return hits / queryTokens.length;
}

function rankAndCap(candidates, kind) {
  return candidates
    .filter((c) => c.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, PER_SOURCE_LIMIT[kind]);
}

async function retrieveBrainNotes(question, queryTokens) {
  if (!queryTokens.length) return [];
  // Memory already covers free-form thoughts via the brain→memory bridge;
  // this layer catches the structured records (ideas/projects/inbox) the
  // user is more likely to call by name.
  const [ideasArr, projectsArr, inbox] = await Promise.all([
    getIdeas(),
    getProjects(),
    getInboxLog({ limit: 200 }),
  ]);

  const candidates = [];
  for (const idea of ideasArr || []) {
    const text = `${idea.title || ''} ${idea.description || ''}`.trim();
    candidates.push({ kind: 'brain-note', subkind: 'idea', recordId: idea.id, title: idea.title || '(idea)', snippet: text, href: `/brain/memory?type=ideas&id=${encodeURIComponent(idea.id)}`, updatedAt: idea.updatedAt || idea.createdAt });
  }
  for (const proj of projectsArr || []) {
    const text = `${proj.title || ''} ${proj.description || ''}`.trim();
    candidates.push({ kind: 'brain-note', subkind: 'project', recordId: proj.id, title: proj.title || '(project)', snippet: text, href: `/brain/memory?type=projects&id=${encodeURIComponent(proj.id)}`, updatedAt: proj.updatedAt || proj.createdAt });
  }
  for (const entry of inbox || []) {
    const text = entry.text || entry.summary || '';
    if (!text) continue;
    candidates.push({ kind: 'brain-note', subkind: 'inbox', recordId: entry.id, title: text.slice(0, 80), snippet: text, href: '/brain/inbox', updatedAt: entry.timestamp || entry.createdAt });
  }

  for (const c of candidates) {
    c.relevance = lexicalScore(`${c.title} ${c.snippet}`, queryTokens);
    c.id = `brain-note:${c.subkind}:${c.recordId}`;
  }
  return rankAndCap(candidates, 'brain-note');
}

async function retrieveAutobiography(queryTokens) {
  if (!queryTokens.length) return [];
  const stories = await getStories();
  // Stories accumulate over time; scoring everything is wasteful when only
  // the per-source cap survives. Trim to the most recent slice first —
  // getStories already sorts newest-first.
  const recent = (stories || []).slice(0, AUTOBIO_SCAN_LIMIT);
  const ranked = recent.map((s) => ({
    kind: 'autobiography',
    id: `autobiography:${s.id}`,
    title: s.themeId ? `${s.themeId} — ${(s.promptText || '').slice(0, 60)}` : (s.promptText || 'Autobiography'),
    snippet: s.content || '',
    href: '/digital-twin/autobiography',
    relevance: lexicalScore(`${s.promptText || ''} ${s.content || ''}`, queryTokens),
    meta: { themeId: s.themeId, createdAt: s.createdAt },
  }));
  return rankAndCap(ranked, 'autobiography');
}

async function retrieveGoals(queryTokens) {
  const goalsData = await getGoals();
  const goals = goalsData?.goals || [];
  // Active goals get a small floor so they surface even on weak lexical
  // matches — your in-flight goals are nearly always relevant context.
  const ranked = goals.map((g) => ({
    kind: 'goal',
    id: `goal:${g.id}`,
    title: g.title || '(goal)',
    snippet: [g.description, g.horizon ? `horizon: ${g.horizon}` : '', g.status ? `status: ${g.status}` : ''].filter(Boolean).join(' · '),
    href: `/digital-twin/goals?id=${encodeURIComponent(g.id)}`,
    relevance: lexicalScore(`${g.title || ''} ${g.description || ''} ${(g.tags || []).join(' ')}`, queryTokens) + (g.status === 'active' ? 0.05 : 0),
    meta: { status: g.status, horizon: g.horizon, category: g.category },
  }));
  return rankAndCap(ranked, 'goal');
}

async function retrieveCalendar(question, queryTokens, timeWindow) {
  if (!queryTokens.length) return [];
  const now = Date.now();
  const days = Number(timeWindow?.days) || CALENDAR_DEFAULT_DAYS;
  const startDate = timeWindow?.startDate || new Date(now - days * MS_PER_DAY).toISOString();
  const endDate = timeWindow?.endDate || new Date(now + days * MS_PER_DAY).toISOString();
  const result = await getCalendarEvents({ startDate, endDate, limit: CALENDAR_FETCH_LIMIT });
  const events = result?.events || [];
  const ranked = events.map((e) => {
    const text = `${e.title || ''} ${e.description || ''} ${e.location || ''}`.trim();
    // Emit raw ISO startTime (or whatever the calendar gave us) — formatting
    // via toLocaleString() would silently apply the *server* TZ/locale,
    // baking inconsistent timestamps into prompts when the server and user
    // disagree on timezone.
    return {
      kind: 'calendar',
      id: `calendar:${e.id || `${e.startTime}-${e.title}`}`,
      title: e.title || '(event)',
      snippet: [e.startTime || '', e.location || '', (e.description || '').slice(0, 200)].filter(Boolean).join(' · '),
      href: `/calendar/agenda?date=${encodeURIComponent(e.startTime || '')}`,
      relevance: lexicalScore(text, queryTokens),
      meta: { startTime: e.startTime, endTime: e.endTime, accountId: e.accountId },
    };
  });
  return rankAndCap(ranked, 'calendar');
}

// =============================================================================
// AGGREGATION
// =============================================================================

export async function gatherSources(question, { timeWindow, maxSources = 12 } = {}) {
  const queryTokens = tokenize(question);

  // Fan out — each retriever is independently failable, so allSettled keeps
  // a single-source outage from killing the answer.
  const [memSettled, brainSettled, autoSettled, goalSettled, calSettled] = await Promise.allSettled([
    retrieveMemories(question),
    retrieveBrainNotes(question, queryTokens),
    retrieveAutobiography(queryTokens),
    retrieveGoals(queryTokens),
    retrieveCalendar(question, queryTokens, timeWindow),
  ]);

  const all = [
    ...(memSettled.status === 'fulfilled' ? memSettled.value : []),
    ...(brainSettled.status === 'fulfilled' ? brainSettled.value : []),
    ...(autoSettled.status === 'fulfilled' ? autoSettled.value : []),
    ...(goalSettled.status === 'fulfilled' ? goalSettled.value : []),
    ...(calSettled.status === 'fulfilled' ? calSettled.value : []),
  ];

  // Dedupe by id (parallel retrievers can occasionally surface the same
  // record via the brain→memory bridge).
  const seen = new Set();
  const deduped = [];
  for (const s of all) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    deduped.push(s);
  }

  // Source-weighted final ranking — memory and goals are the highest-signal
  // PortOS surfaces; calendar wins time-bounded questions; autobiography is
  // long-form so it ranks last unless lexical match is very strong.
  const KIND_WEIGHT = { memory: 1.0, goal: 0.95, 'brain-note': 0.85, calendar: 0.85, autobiography: 0.7 };
  deduped.sort((a, b) => (b.relevance * (KIND_WEIGHT[b.kind] || 0.5)) - (a.relevance * (KIND_WEIGHT[a.kind] || 0.5)));

  return deduped.slice(0, Math.max(1, Math.min(50, maxSources)));
}

// =============================================================================
// PROMPT ASSEMBLY
// =============================================================================

const MODE_DIRECTIVES = {
  ask: `Answer the question as the user would answer it themselves, drawing on their notes, memories, and goals below. If the sources don't contain the answer, say so plainly — don't fabricate.`,
  advise: `You are advising the user. Use the sources to ground the advice in their own life: their goals, their constraints, what they've already decided. Push back where their stated goals contradict the question.`,
  draft: `Draft text in the user's voice for the recipient/platform they specified. Keep it tight and authentic to the tone in the sources. Return only the drafted text — no preamble, no commentary.`,
};

export async function buildPersonaPreamble() {
  const character = await getCharacter().catch(() => null);
  // The character sheet is the closest thing to a persona surface today.
  // Autobiography stories carry the voice; we sample the most recent one
  // separately in the source pipeline. Keep this preamble small.
  if (!character?.name && !character?.class) return PERSONA_FALLBACK;
  const name = character?.name || 'the user';
  return `You are ${name}'s digital twin. Speak in the first person, in their voice. Be direct, specific, and grounded in the sources below. Where the user's perspective is unclear, say so explicitly rather than guessing.`;
}

function formatSourcesForPrompt(sources) {
  if (!sources?.length) return 'No retrieved sources for this question.';
  const lines = ['## Retrieved Sources', ''];
  sources.forEach((s, i) => {
    const tag = `[${i + 1}]`;
    const snippet = (s.snippet || '').replace(/\s+/g, ' ').slice(0, SNIPPET_MAX_CHARS);
    lines.push(`${tag} ${s.kind} — ${s.title}`);
    if (snippet) lines.push(`    ${snippet}`);
  });
  return lines.join('\n');
}

function formatTranscriptForPrompt(history = []) {
  if (!history.length) return '';
  const lines = ['## Conversation so far'];
  for (const turn of history) {
    const who = turn.role === 'assistant' ? 'You (twin)' : 'User';
    lines.push(`${who}: ${(turn.content || '').slice(0, HISTORY_TURN_MAX_CHARS)}`);
  }
  return lines.join('\n');
}

export async function buildPrompt({ question, mode = 'ask', sources = [], history = [] }) {
  const persona = await buildPersonaPreamble();
  const directive = MODE_DIRECTIVES[mode] || MODE_DIRECTIVES.ask;
  const transcript = formatTranscriptForPrompt(history);
  return [
    persona,
    '',
    directive,
    '',
    'Cite sources inline using their bracket numbers, e.g. [1] [3]. Only cite sources you actually relied on.',
    '',
    formatSourcesForPrompt(sources),
    '',
    transcript,
    '',
    `## Question`,
    question,
  ].join('\n');
}

// =============================================================================
// PROVIDER STREAMING
// =============================================================================

async function pickProvider(providerId) {
  if (providerId) {
    const p = await getProviderById(providerId).catch(() => null);
    if (p?.enabled) return p;
  }
  const active = await getActiveProvider().catch(() => null);
  if (active?.enabled) return active;
  throw new Error('No AI provider available');
}

/**
 * Stream a completion from an API-style provider. Yields text chunks.
 * Falls back to a single-shot call for non-streaming providers (CLI).
 *
 * `signal` (optional) is an external AbortSignal — when the caller aborts
 * (e.g. SSE client disconnects), the provider fetch / child process is
 * cancelled so we stop wasting tokens/CPU on a stream nobody's reading.
 */
async function* streamCompletion(provider, model, prompt, signal) {
  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
    // Combine the per-provider timeout with the caller's abort signal so
    // either one tearing down propagates to the upstream fetch.
    const timeoutSignal = AbortSignal.timeout(provider.timeout || 300000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        stream: true,
      }),
      signal: fetchSignal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`AI API error: ${response.status} - ${text.slice(0, 500)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!frame.startsWith('data:')) continue;
        const payload = frame.slice(5).trim();
        if (payload === '[DONE]') return;
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
    return;
  }

  // CLI providers can't stream chunked text out of a child process without
  // a lot more wiring; fall back to a single-shot call via the shared
  // brain-style invocation pattern.
  const { spawn } = await import('child_process');
  const args = [...(provider.args || [])];
  if (provider.headlessArgs?.length) args.push(...provider.headlessArgs);
  if (provider.id === 'gemini-cli') {
    if (!args.includes('--output-format') && !args.includes('-o')) args.push('--output-format', 'text');
    if (model) args.push('--model', model);
    args.push('--prompt', prompt);
  } else {
    if (model) args.push('--model', model);
    args.push(prompt);
  }
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    const child = spawn(provider.command, args, {
      env: (() => { const e = { ...process.env, ...provider.envVars }; delete e.CLAUDECODE; return e; })(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    child.stdout.on('data', (d) => { buf += d.toString(); });
    child.stderr.on('data', (d) => { buf += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')); }, provider.timeout || 300000);
    const onAbort = () => { child.kill('SIGKILL'); reject(new Error('aborted')); };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(buf);
      else reject(new Error(`CLI exited ${code}: ${buf.slice(0, 500)}`));
    });
    child.on('error', (err) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err); });
  });
  yield out;
}

// =============================================================================
// PUBLIC ENTRY
// =============================================================================

/**
 * Run an Ask turn end-to-end. Returns an async iterable of stream events.
 *
 * @param {Object} opts
 * @param {string} opts.question - The user's question.
 * @param {'ask'|'advise'|'draft'} [opts.mode]
 * @param {Array} [opts.history] - Prior turns for multi-turn context.
 * @param {Object} [opts.timeWindow] - { days?, startDate?, endDate? } for calendar.
 * @param {number} [opts.maxSources]
 * @param {string} [opts.providerId]
 * @param {string} [opts.model]
 * @param {AbortSignal} [opts.signal] - Aborts retrieval/provider stream when
 *   the caller (e.g. SSE client) disconnects, so we don't keep generating
 *   tokens for a closed connection.
 */
export async function* runAsk({
  question,
  mode = 'ask',
  history = [],
  timeWindow,
  maxSources = 12,
  providerId,
  model,
  signal,
}) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    yield { type: 'error', error: 'question is required' };
    return;
  }
  if (!VALID_MODES.has(mode)) {
    yield { type: 'error', error: `invalid mode: ${mode}` };
    return;
  }

  let sources;
  try {
    sources = await gatherSources(question, { timeWindow, maxSources });
  } catch (err) {
    yield { type: 'error', error: `Source retrieval failed: ${err.message}` };
    return;
  }

  if (signal?.aborted) return;
  yield { type: 'sources', sources };

  let provider;
  try {
    provider = await pickProvider(providerId);
  } catch (err) {
    yield { type: 'error', error: err.message };
    return;
  }
  const effectiveModel = model || provider.defaultModel;
  const prompt = await buildPrompt({ question, mode, sources, history });

  const startedAt = Date.now();
  console.log(`🪞 Ask start: ${provider.id}/${effectiveModel} mode=${mode} sources=${sources.length}`);

  // Stream errors are caught here (rather than letting them bubble) so the
  // route can flush a terminal SSE 'error' frame to the client — once the
  // stream has started, we can't change to a 5xx response any longer.
  let answer = '';
  try {
    for await (const chunk of streamCompletion(provider, effectiveModel, prompt, signal)) {
      if (signal?.aborted) return;
      if (!chunk) continue;
      answer += chunk;
      yield { type: 'delta', text: chunk };
    }
  } catch (err) {
    if (signal?.aborted) return;
    yield { type: 'error', error: `Provider stream failed: ${err.message}` };
    return;
  }

  console.log(`✅ Ask complete: ${provider.id}/${effectiveModel} ${Date.now() - startedAt}ms ${answer.length} chars`);

  yield {
    type: 'done',
    answer,
    sources,
    providerId: provider.id,
    model: effectiveModel,
  };
}
