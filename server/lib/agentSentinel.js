/**
 * The `.agent-done` completion sentinel — shared naming + parser.
 *
 * A finishing agent writes this file into its workspace to signal completion
 * (see agentTuiSpawning's sentinel watcher). The file is named per agent instance
 * (`.agent-done-<agentId>`, see `doneSentinelName`) because worktree-less runs
 * share one workspace and would otherwise clobber each other's signal.
 *
 * Historically it held a plain-markdown
 * task summary that gets appended to the agent's output. Programmatic-I/O task
 * types (see docs/plans/2026-07-09-programmatic-io-scheduled-tasks.md) also need
 * a STRUCTURED result back — e.g. Layered Intelligence's reasoner JSON — so the
 * sentinel may instead be a JSON object `{ summary, payload }` where `payload`
 * is the machine-readable result a `processTaskOutput` hook consumes.
 *
 * `parseSentinelPayload` is pure and back-compat: a plain-text sentinel yields
 * `{ summary: <text>, payload: null }`; a JSON object yields its `summary`
 * (string, if present) plus its `payload`. Anything that fails to shape up
 * (empty, non-object JSON like a bare array/number) degrades to text so an
 * existing markdown sentinel is never misread as structured.
 */

import { join } from 'path';

import { safeJSONParse, sanitizeFilename } from './fileUtils.js';

export const DONE_SENTINEL_NAME = '.agent-done';

/**
 * Heading of the briefing section that prints this run's absolute sentinel path
 * for a reasoning-only (programmatic-output) task — see
 * `buildProgrammaticOutputCompletionSection` in agentPromptBuilder.
 *
 * A task-type hook renders its prompt BEFORE spawn, so it cannot know the
 * per-instance filename (`.agent-done-<agentId>`) and must point the agent at
 * the briefing instead. That pointer only works if both sides agree on the
 * heading, hence one exported constant rather than the string typed twice.
 * Pointing POSITIVELY at this section is also the whole contract: a prompt that
 * warns against some other filename is the only place the agent would learn
 * that filename exists.
 */
export const PROGRAMMATIC_OUTPUT_COMPLETION_HEADING = 'Completion (Reasoning-Only Task)';

/**
 * The sentinel filename for one agent instance: `.agent-done-<agentId>`.
 *
 * Agents that run WITHOUT a worktree (`useWorktree: false` — e.g. the
 * issue-filing and reasoning task types) all share the primary checkout as
 * their workspace, so a single shared `.agent-done` is a cross-run hazard: two
 * concurrent agents overwrite each other's summary, and whichever poll fires
 * first finalizes the *other* agent's run on a sentinel it never wrote. Scoping
 * the filename to the agent id keeps each run's done-signal its own file.
 *
 * The id goes through the shared `sanitizeFilename` (not a private charset
 * regex) so this filename answers "is this token safe on disk" the same way the
 * rest of the repo does. Falls back to the bare name when no usable id is
 * available, so a caller without one still resolves to something readable.
 */
export function doneSentinelName(agentId) {
  const slug = typeof agentId === 'string' ? sanitizeFilename(agentId.trim()).slice(0, 64) : '';
  return slug ? `${DONE_SENTINEL_NAME}-${slug}` : DONE_SENTINEL_NAME;
}

/**
 * The one path this run's sentinel lives at — `null` without a workspace.
 *
 * Every producer and consumer resolves it here: the prompt the agent is given
 * (agentPromptBuilder), the sentinel watchers and the durable runner's watch
 * (agentTuiSpawning), the CLI exit check (agentCliSpawning), and the
 * output-hook payload read (agentFinalization). One path, not a candidate list:
 * a second accepted name would give those pollers different answers to "did
 * this run finish", which is the failure the scoped name exists to remove.
 *
 * Pure: callers do their own `existsSync` / read.
 */
export function doneSentinelPath(workspacePath, agentId) {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  return join(workspacePath, doneSentinelName(agentId));
}

/**
 * Parse `.agent-done` contents into `{ summary, payload }`.
 *   - `summary`: human-readable text for the agent output/card (never null;
 *     falls back to the raw trimmed contents).
 *   - `payload`: the structured result for a task-type output hook, or null
 *     when the sentinel carried no JSON object (the common legacy case).
 * Pure — no I/O. `contents` may be null/undefined (missing file).
 */
export function parseSentinelPayload(contents) {
  const trimmed = typeof contents === 'string' ? contents.trim() : '';
  if (!trimmed) return { summary: '', payload: null };

  // Only a JSON OBJECT counts as structured. `safeJSONParse` with allowArray:false
  // rejects a root array and returns null for malformed content, but still parses
  // a bare scalar (`"42"`, `"true"`) — so guard for a genuine object here too, or
  // a legacy sentinel that happens to be a lone number/string/bool would crash on
  // the `'payload' in parsed` check below instead of round-tripping as text.
  const parsed = safeJSONParse(trimmed, null, { allowArray: false });
  if (parsed && typeof parsed === 'object') {
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const payload = 'payload' in parsed ? parsed.payload : null;
    return { summary, payload };
  }

  return { summary: trimmed, payload: null };
}

/**
 * Lenient fallback for a STRUCTURED sentinel that the strict
 * `parseSentinelPayload` couldn't read. A less-capable model (notably a local
 * one) commonly emits an almost-valid `{ summary, payload }` envelope — wrapped
 * in ```json fences, trailed by prose, or with raw newlines/tabs pasted into
 * the long markdown `body` string — which `JSON.parse` rejects, silently
 * dropping a real proposal as "unparseable-response". This runs the shared
 * robust LLM-JSON extractor (`jsonExtract.extractJson`: strips fences, walks
 * balanced blocks, repairs trailing commas / orphan braces / raw control
 * chars) over the raw contents and, ONLY when it recovers the documented
 * envelope shape (a `{ ..., "payload": ... }` object), surfaces its payload.
 *
 * Deliberately narrow: it requires the `payload` key so a legacy plain-markdown
 * sentinel that merely happens to contain a `{...}` block is never misread as
 * structured — that stays text (payload null). Async + a LAZY import of
 * jsonExtract so the barrel re-export of this module doesn't statically pull
 * jsonExtract's transitive services chain into every lib consumer / mocked
 * suite. Callers use it as a second tier after `parseSentinelPayload` returns a
 * null payload (see agentLifecycle's dispatchTaskOutputHook).
 *
 * @param {string|null|undefined} contents — raw `.agent-done` contents
 * @returns {Promise<{ summary: string, payload: unknown }>}
 */
export async function salvageSentinelPayload(contents) {
  const trimmed = typeof contents === 'string' ? contents.trim() : '';
  if (!trimmed || !trimmed.includes('{')) return { summary: trimmed, payload: null };

  // The documented sentinel envelope: a plain object carrying a `payload` key.
  const isEnvelope = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'payload' in v;

  // skipInnerFence: the reasoner's `payload.proposal.body` is markdown that
  // routinely contains its own ```code``` fence; without this, extractJson's
  // inner-fence heuristic would lock onto that body fence and discard the whole
  // envelope. Balanced-block walking is string-aware, so a fence inside the
  // JSON string value can't derail it.
  const { extractJson } = await import('./jsonExtract.js');
  const { value } = extractJson(trimmed, { shapePredicate: isEnvelope, skipInnerFence: true });
  // Re-verify the shape: extractJson falls back to the first block that merely
  // PARSED (ignoring the predicate) when none matched, so an incidental
  // non-envelope object must not be adopted as a payload.
  if (!isEnvelope(value)) return { summary: trimmed, payload: null };

  const summary = typeof value.summary === 'string' ? value.summary : '';
  return { summary, payload: value.payload };
}

/**
 * Last-resort rescue for a programmatic-I/O deliverable the agent PRINTED into
 * its terminal instead of writing to `.agent-done` (#3640).
 *
 * For these task types the sentinel JSON *is* the product of the run — a
 * Layered Intelligence proposal becomes a filed tracker issue. A weaker model
 * (typically a local one) commonly answers in the TUI rather than through the
 * tool call, and the run is then discarded with `payload: undefined` even
 * though the reasoning completed. Scanning the transcript recovers it.
 *
 * Deliberately predicate-gated and scoped to programmatic-I/O callers: for
 * every other task type the sentinel is a COMPLETION SIGNAL, not a deliverable,
 * and scraping a transcript for one would let an agent that merely *discussed*
 * finishing be treated as finished. `isPayload` is the owning hook's own shape
 * check (see taskTypeHooks' `getTaskOutputPayloadPredicate`), so a transcript
 * that only contains chatter, a schema example, or partial JSON yields nothing
 * rather than a garbage payload.
 *
 * Blocks are walked in REVERSE closing order — the model's final answer wins
 * over an earlier prompt echo of the same schema, and an enclosing object wins
 * over its own nested children. Strict `safeJSONParse` per block (no lenient
 * repair): a transcript is not a file the agent committed to, so "almost JSON"
 * there stays a miss.
 *
 * Async + LAZY imports for the same reason as `salvageSentinelPayload` — the
 * barrel re-export of this module must not statically pull jsonExtract's
 * transitive chain into every lib consumer / mocked suite.
 *
 * @param {string|null|undefined} transcript — ANSI-bearing raw PTY text
 * @param {(payload:unknown)=>boolean} isPayload — the hook's shape predicate
 * @returns {Promise<{ summary: string, payload: unknown }>}
 */
export async function extractSentinelPayloadFromTranscript(transcript, isPayload) {
  const none = { summary: '', payload: null };
  if (typeof transcript !== 'string' || !transcript.includes('{')) return none;
  if (typeof isPayload !== 'function') return none;

  const { stripAnsi } = await import('./ansiStrip.js');
  const { findAllBalancedBlocks } = await import('./jsonExtract.js');
  const blocks = findAllBalancedBlocks(stripAnsi(transcript));

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const parsed = safeJSONParse(blocks[i], null, { allowArray: false });
    // `typeof` guard, not just truthiness: the `in` check below throws on a
    // primitive, and a best-effort salvage must never be the thing that breaks
    // finalize.
    if (!parsed || typeof parsed !== 'object') continue;
    // Two shapes reach a transcript: the documented `{ summary, payload }`
    // envelope the agent should have written to the sentinel, and the BARE
    // payload object — what a model answering in the terminal actually prints.
    // Unwrap only when the inner value is ITSELF a valid payload: a bare
    // deliverable that merely happens to carry a `payload` key would otherwise
    // be discarded in favour of a nested value the hook can't use.
    const unwrap = 'payload' in parsed && isPayload(parsed.payload);
    const candidate = unwrap ? parsed.payload : parsed;
    if (!isPayload(candidate)) continue;
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    return { summary, payload: candidate };
  }
  return none;
}
