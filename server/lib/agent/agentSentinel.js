/**
 * The `.agent-done` completion sentinel: shared naming + parser.
 *
 * A finishing agent writes it into its workspace, named per agent instance (`.agent-done-<agentId>`) because worktree-less
 * runs share one workspace. It holds a markdown summary or, for programmatic-I/O task types
 * (docs/plans/archive/2026-07-09-programmatic-io-scheduled-tasks.md), JSON `{ summary, payload }` consumed by a
 * `processTaskOutput` hook. `parseSentinelPayload` is pure: anything not a JSON object degrades to text so markdown is
 * never misread as structured.
 */

import { join } from 'path';
import { normalizeTaskOutcome } from './agentOutcome.js';

import { safeJSONParse } from '../fileUtils.js';
import { sanitizeFilename } from '../mimeTypes.js';

export const DONE_SENTINEL_NAME = '.agent-done';

/**
 * Heading of the briefing section printing this run's absolute sentinel path for a reasoning-only task
 * (`buildProgrammaticOutputCompletionSection`). A task-type hook renders its prompt BEFORE spawn and cannot know the
 * per-instance filename. Point POSITIVELY: a prompt warning against another filename teaches the agent it exists.
 */
export const PROGRAMMATIC_OUTPUT_COMPLETION_HEADING = 'Completion (Reasoning-Only Task)';

/**
 * The sentinel filename for one agent instance: `.agent-done-<agentId>`. Worktree-less agents share the primary checkout,
 * so a shared `.agent-done` would let concurrent agents finalize the *other* run. Bare name without a usable id.
 */
export function doneSentinelName(agentId) {
  const slug = typeof agentId === 'string' ? sanitizeFilename(agentId.trim()).slice(0, 64) : '';
  return slug ? `${DONE_SENTINEL_NAME}-${slug}` : DONE_SENTINEL_NAME;
}

/**
 * The names a run-scoped watcher may inspect, canonical first. The second is a narrow recovery for an agent id whose
 * final hex character a terminal copy dropped; consumers must still require a fresh, unambiguous file.
 */
export function doneSentinelCandidateNames(agentId) {
  const canonical = doneSentinelName(agentId);
  const normalizedId = typeof agentId === 'string' ? agentId.trim() : '';
  if (!/^agent-[0-9a-f]{8}$/.test(normalizedId)) return [canonical];

  const truncated = doneSentinelName(normalizedId.slice(0, -1));
  return truncated === canonical ? [canonical] : [canonical, truncated];
}

/**
 * The agent id encoded in a done-sentinel filename: the only inverse of `doneSentinelName`, so a sweep for leftover
 * `.agent-done-*` agrees with the producer and never deletes a live completion signal. Returns `''` for the bare
 * `.agent-done` (no run) and `null` when the name is not a sentinel.
 */
export function doneSentinelAgentId(name) {
  if (typeof name !== 'string') return null;
  if (name === DONE_SENTINEL_NAME) return '';
  const prefix = `${DONE_SENTINEL_NAME}-`;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null;
}

const STARTUP_SENTINEL_REASONS = new Set(['paste-not-rendered', 'tui-not-ready', 'command-not-found', 'prompt-not-submitted']);

/**
 * The operator line for a TUI that ended without its completion sentinel. A startup failure never received the prompt,
 * so the missing file is a consequence, not a second fault.
 */
export function missingSentinelLogMessage({ agentId, reason, sentinelPath, mergeGateReprompted = false, command, providerId }) {
  if (STARTUP_SENTINEL_REASONS.has(reason)) {
    // TUI identity separates one provider's handshake stall from another's in stderr fingerprints.
    const tui = [command && `tui=${command}`, providerId && `provider=${providerId}`].filter(Boolean).join(' ');
    return `${agentId} startup failed (${reason}${tui ? ` ${tui}` : ''}) before a completion sentinel could be written`;
  }
  if (mergeGateReprompted) {
    return `${agentId} finalized (${reason}) without re-writing its sentinel after the merge-gate nudge — expected ${sentinelPath}`;
  }
  return `${agentId} finalized (${reason}) with no completion sentinel — expected ${sentinelPath}`;
}

/**
 * The one canonical sentinel path for this run (`null` without a workspace), shared by the prompt, TUI watcher, CLI exit
 * check and output-hook read.
 */
export function doneSentinelPath(workspacePath, agentId) {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  return join(workspacePath, doneSentinelName(agentId));
}

/** Parse `.agent-done` contents into `{ summary, payload }`; `payload` is null without a JSON object. Pure; `contents` may be null. */
export function parseSentinelPayload(contents) {
  const trimmed = typeof contents === 'string' ? contents.trim() : '';
  if (!trimmed) return { summary: '', payload: null };

  // `safeJSONParse` with allowArray:false still parses a bare scalar, so also require an object or the
  // `'payload' in parsed` check below would throw on a legacy lone number/string/bool sentinel.
  const parsed = safeJSONParse(trimmed, null, { allowArray: false });
  if (parsed && typeof parsed === 'object') {
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const payload = 'payload' in parsed ? parsed.payload : null;
    const taskOutcome = normalizeTaskOutcome(parsed.taskOutcome);
    return { summary, payload, ...(taskOutcome ? { taskOutcome } : {}) };
  }

  return { summary: trimmed, payload: null };
}

/**
 * Lenient fallback for a STRUCTURED sentinel the strict parser couldn't read: weaker models emit almost-valid envelopes
 * (code fences, trailing prose, raw newlines) that `JSON.parse` rejects. Surfaces a payload ONLY when `extractJson`
 * recovers the `{ ..., "payload": ... }` envelope, so a markdown sentinel containing a `{...}` block stays text. Lazy
 * jsonExtract import so the barrel doesn't pull its services chain into every lib consumer. Second tier after
 * `parseSentinelPayload` returns a null payload (agentLifecycle's dispatchTaskOutputHook).
 *
 * @param {string|null|undefined} contents — raw `.agent-done` contents
 * @returns {Promise<{ summary: string, payload: unknown }>}
 */
export async function salvageSentinelPayload(contents) {
  const trimmed = typeof contents === 'string' ? contents.trim() : '';
  if (!trimmed || !trimmed.includes('{')) return { summary: trimmed, payload: null };

  // The documented sentinel envelope: a plain object carrying a `payload` key.
  const isEnvelope = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'payload' in v;

  // skipInnerFence: `payload.proposal.body` is markdown with its own code fences, which would otherwise
  // capture extractJson's inner-fence heuristic and discard the envelope.
  const { extractJson } = await import('../jsonExtract.js');
  const { value } = extractJson(trimmed, { shapePredicate: isEnvelope, skipInnerFence: true });
  // extractJson falls back to the first block that merely parsed, so re-verify the shape.
  if (!isEnvelope(value)) return { summary: trimmed, payload: null };

  const summary = typeof value.summary === 'string' ? value.summary : '';
  return { summary, payload: value.payload };
}

/**
 * Last-resort rescue for a programmatic-I/O deliverable the agent PRINTED into its terminal instead of writing to
 * `.agent-done`. Scoped to programmatic-I/O callers: elsewhere the sentinel is a COMPLETION SIGNAL and scraping a
 * transcript would treat an agent that merely *discussed* finishing as finished. `isPayload` is the owning hook's shape
 * check (`getTaskOutputPayloadPredicate`), so chatter or partial JSON yields nothing.
 *
 * Blocks are walked in REVERSE closing order so the final answer beats an earlier prompt echo of the schema and an
 * enclosing object beats its children. `tryParseWithRepair` is used because for a tool-free stage the print IS the
 * deliverable; its repairs are conservative and string-aware. Lazy imports as in `salvageSentinelPayload`.
 *
 * @param {string|null|undefined} transcript — ANSI-bearing raw PTY text
 * @param {(payload:unknown)=>boolean} isPayload — the hook's shape predicate
 * @returns {Promise<{ summary: string, payload: unknown }>}
 */
export async function extractSentinelPayloadFromTranscript(transcript, isPayload) {
  const none = { summary: '', payload: null };
  if (typeof transcript !== 'string' || !transcript.includes('{')) return none;
  if (typeof isPayload !== 'function') return none;

  const { stripAnsi } = await import('../ansiStrip.js');
  const { findAllBalancedBlocks, tryParseWithRepair } = await import('../jsonExtract.js');
  const blocks = findAllBalancedBlocks(stripAnsi(transcript));

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const { value: parsed, error } = tryParseWithRepair(blocks[i]);
    // `typeof` guard: the `in` check below throws on a primitive, and salvage must never break finalize.
    if (error || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    // Either the `{ summary, payload }` envelope or a BARE payload. Unwrap only when the inner value is
    // itself a valid payload, or a bare deliverable carrying a `payload` key would be discarded.
    const unwrap = 'payload' in parsed && isPayload(parsed.payload);
    const candidate = unwrap ? parsed.payload : parsed;
    if (!isPayload(candidate)) continue;
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    return { summary, payload: candidate };
  }
  return none;
}
