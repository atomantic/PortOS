/**
 * Replace PortOS's estimated per-run token counts with the CLI's own measured
 * counts, read from the transcripts the coding CLIs already write to disk.
 *
 * PortOS estimates output from captured stdout (a repainted ANSI screen for TUI
 * providers) and input from `promptLength` — the initial task description only,
 * which omits the per-turn context replay and prompt-cache traffic that dominate
 * real API cost. The result understated cost by orders of magnitude (#3124).
 * Claude Code and Codex both write real per-message counts locally, so the fix
 * is to read them: no provider call, no tokens spent, no network.
 *
 * Correlation has no shared identifier to work with — PortOS never captured the
 * CLI's own session id — so a run is matched to a transcript by
 * (a) working directory and (b) timestamp overlap with `[startTime, endTime]`:
 *
 *   Claude Code — the project directory name IS the slugified cwd, so the
 *     candidate set is exact; each session file is then windowed by timestamp.
 *   Codex — rollouts are filed by date, so we scan the run's date directories
 *     and keep sessions whose `session_meta.cwd` matches.
 *   Grok — sessions live under `encodeURIComponent(cwd)`, so that lookup is
 *     exact too; turns are windowed by the event stream's own timestamps.
 *   Antigravity — `history.jsonl` maps a workspace to a conversation id, and
 *     the brain transcript it names carries per-step timestamps.
 *
 * The scan is NOT limited to the run's own provider family. A CoS task that
 * ships a PR with `--review-with grok,antigravity` bash-launches those CLIs as
 * children of the parent agent: they leave a session on disk but never become a
 * PortOS run, so nothing else would ever account for that spend and the parent's
 * chars/4 estimate cannot see it. Every family's store is therefore searched in
 * the run's workspace and window, and each session is billed to ITS OWN
 * configured provider (#5831) — never folded into the parent's row.
 *
 * When nothing matches (a provider that writes no transcript, an unreadable
 * home directory, an ambiguous window) the caller falls back to the existing
 * estimate — `reconcileRunUsage` reports which happened via `source`, so the
 * report can mark measured rows apart from estimated ones. Reading a transcript
 * is best-effort by design: a failure here must never fail the run it describes.
 */

import { homedir } from 'os';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { atomicWrite, PATHS, readJSONFile, tryReadFile } from '../lib/fileUtils.js';
import { estimateTokens, estimateTokensFromChars } from '../lib/contextBudget.js';
import { isFreeModelId, resolveModelRates } from '../lib/modelPricing.js';
import {
  UNKNOWN_MODEL,
  claudeProjectSlug,
  decodeGrokSessionDir,
  parseAgyTranscript,
  parseClaudeTranscript,
  parseCodexRollout,
  parseAgyHistory,
  parseGrokChatHistory,
  parseGrokTurns,
  totalTranscriptTokens
} from '../lib/providerTranscriptUsage.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { markUsageRunReconciled, recordRunUsage } from './usage.js';

// Widen the correlation window past the recorded run bounds: the CLI writes its
// first line slightly before PortOS stamps startTime, and flushes its last
// after the process exits. A minute of slack captures both.
//
// The slack does NOT make attribution exclusive: PortOS runs are NOT serialized
// per cwd (the runner allows several concurrent), and measured against this
// install's run history there are 39 genuinely overlapping same-cwd run pairs —
// 144 once this slack is applied. Two overlapping runs would each fold the whole
// overlap and double-bill it, so exclusivity is enforced separately by the
// per-message claim below, not by the window.
const WINDOW_SLACK_MS = 60_000;

// Messages already billed to a run, keyed `<transcript-key>:<message-key>`.
// A transcript message must be counted exactly ONCE across every run that can
// see it: without this, two concurrent runs in the same cwd (or one run whose
// window overlaps a neighbour's through WINDOW_SLACK_MS) each fold the same
// tokens and the cost report doubles. Module-instance-local by design — the
// live completion path (this module, in the main thread) and the historical
// backfill worker (a SEPARATE module instance in a worker thread) each get
// their own copy of this Set, so `snapshotUsageClaims`/`mergeUsageClaims`
// hand claims across that boundary; see `usageBackfill.js`. A restart loses
// the ledger, but a run that already completed is never reconciled again.
const claimedMessages = new Set();

// The ABSOLUTE cumulative position of each Codex rollout that has already been
// billed, keyed by file path. Codex reports cumulative totals, so a rollout that
// grows between two runs would otherwise re-include the earlier run's tokens.
// Stored in absolute rollout units (not "tokens we billed") so the delta is a
// plain subtraction: a windowed parse already nets out the earlier snapshot, so
// mixing the two would double-subtract. Absolute totals are also immune to
// several snapshots sharing one epoch millisecond.
const codexHighWater = new Map();

/** Test-only: forget every claim so suites start from a clean ledger. */
export function __resetUsageClaims() {
  claimedMessages.clear();
  codexHighWater.clear();
}

/**
 * Snapshot the current ledger so it can be handed to a worker thread — which
 * gets its own empty copy of this module's state — and merged back once the
 * worker finishes. Without this, the historical-usage backfill worker
 * (`usageBackfillWorker.js`) and the live completion path (this module, run
 * in the main thread) never see each other's claims, so a transcript message
 * whose window overlaps a live run and a backfilled historical run could be
 * billed by both.
 */
export function snapshotUsageClaims() {
  return {
    claimedMessages: [...claimedMessages],
    codexHighWater: [...codexHighWater.entries()]
  };
}

/** Merge claims made elsewhere (a worker thread's ledger) into this one. */
export function mergeUsageClaims({ claimedMessages: claimed = [], codexHighWater: highWater = [] } = {}) {
  for (const key of claimed) claimedMessages.add(key);
  for (const [path, value] of highWater) {
    const existing = codexHighWater.get(path);
    codexHighWater.set(path, existing ? {
      messages: Math.max(existing.messages || 0, value.messages || 0),
      tokensIn: Math.max(existing.tokensIn || 0, value.tokensIn || 0),
      tokensOut: Math.max(existing.tokensOut || 0, value.tokensOut || 0),
      cacheReadTokens: Math.max(existing.cacheReadTokens || 0, value.cacheReadTokens || 0),
      cacheWriteTokens: Math.max(existing.cacheWriteTokens || 0, value.cacheWriteTokens || 0)
    } : value);
  }
}

// A run is attributed only to transcripts whose cwd matches. A CoS agent works
// in a git worktree under the install's data dir, so the worktree path — not the
// install root — is what the CLI records; matching is therefore exact on the
// recorded `workspacePath`, with a prefix allowance for a CLI invoked in a
// subdirectory of the workspace (`server/`, `client/`).
const cwdMatches = (transcriptCwd, workspacePath) => {
  if (!transcriptCwd || !workspacePath) return false;
  if (transcriptCwd === workspacePath) return true;
  return transcriptCwd.startsWith(`${workspacePath}/`);
};

/**
 * Does a session that ran `[startMs, endMs]` overlap the run window `[from, to]`?
 * Used only where a store has no per-message timestamps (grok's chat_history),
 * so the session is placed by its own summary. A session with no readable start
 * cannot be placed at all and is NOT billed — the same rule `inWindow` applies
 * to a timestamp-less message, for the same reason: attributing it would hand
 * the same tokens to every run that ever reads the file.
 */
const windowOverlaps = (startMs, endMs, from, to) => {
  if (!Number.isFinite(startMs)) return false;
  const end = Number.isFinite(endMs) ? Math.max(endMs, startMs) : startMs;
  if (from != null && end < from) return false;
  if (to != null && startMs > to) return false;
  return true;
};

const CLAUDE_ID = /claude/i;
const CODEX_ID = /codex/i;
const GROK_ID = /grok/i;
// `agy` is a three-letter binary name, so it needs word boundaries or it would
// match inside an unrelated id; `antigravity` is the long form of the same CLI.
const AGY_ID = /(^|[^a-z0-9])agy([^a-z0-9]|$)|antigravity/i;

/**
 * Which model id to record for a measured bucket.
 *
 * PortOS's own id is preferable when the two AGREE, because it carries the
 * provider's shape (a Bedrock prefix, a `[1m]` suffix) that the transcript
 * strips but the pricing table resolves. It must NOT win when they disagree:
 * a run launched as `claude-opus-5` that actually fell back to a local
 * `qwen3.6:35b` would otherwise be priced at Opus rates instead of $0.
 *
 * "Agree" is tested by resolving both through the rate table — that treats
 * `global.anthropic.claude-opus-5[1m]` and `claude-opus-5` as the same model
 * (both resolve to `claude-opus-5`) while catching a genuine substitution.
 * A model-less bucket (`UNKNOWN_MODEL`) resolves to null so the caller prices it
 * at the provider default — EXCEPT when it is the run's only bucket, where the
 * recorded model is used instead. That case is a deliberate choice, not an
 * oversight: with one bucket and no name in the transcript, PortOS's launch-time
 * model is real evidence of what ran, while the provider default is a guess that
 * is often a different model entirely (a Bedrock Opus run defaults to Sonnet
 * rates — $3/$15 instead of $5/$25, understating the very cost this feature
 * exists to measure). With SEVERAL buckets the unnamed one can't be pinned to
 * the recorded model (some other bucket already holds it), so it stays null.
 */
function attributedModel(recordedModel, transcriptModel, singleModel) {
  const fromTranscript = transcriptModel === UNKNOWN_MODEL ? null : transcriptModel;
  if (!singleModel || !recordedModel) return fromTranscript;
  if (!fromTranscript) return recordedModel;
  if (recordedModel === fromTranscript) return recordedModel;
  // A local model can never be an alias of a hosted one — always trust the
  // transcript there, or free inference gets billed at the launch model's rate.
  if (isFreeModelId(fromTranscript) !== isFreeModelId(recordedModel)) return fromTranscript;
  const recordedRate = resolveModelRates(null, recordedModel).rateModel;
  const transcriptRate = resolveModelRates(null, fromTranscript).rateModel;
  // A null rateModel means "nothing in the table recognized this id", and two
  // unrecognized ids are NOT thereby the same model — treating null === null as
  // agreement would keep the launch-time id for a genuine substitution between
  // two unknown models. Require a resolved family to claim they match.
  const sameFamily = recordedRate != null && recordedRate === transcriptRate;
  return sameFamily ? recordedModel : fromTranscript;
}


/**
 * Which transcript family a provider writes, or null for providers that write
 * none (ollama, LM Studio, any API provider). Keyed off the provider id and
 * command, mirroring `providerModels.js`'s predicates — but kept local so this
 * service stays reachable from the completion hook without pulling in the
 * provider graph.
 *
 * The ids match `lib/providerFamilies.js`'s family ids on purpose: a sibling
 * session found in a run's workspace is mapped back to an enabled provider
 * through `familyForProvider`, so the two vocabularies have to agree.
 * @param {{ providerId?: string|null, command?: string|null }} run
 * @returns {'claude'|'codex'|'grok'|'agy'|null}
 */
export function transcriptFamily({ providerId = null, command = null } = {}) {
  const haystack = `${providerId || ''} ${command || ''}`;
  // Order matters: a `claude-code` provider id contains neither codex nor grok,
  // but check codex first so a hypothetical `codex-claude` wrapper resolves to
  // the CLI that actually writes the rollout.
  if (CODEX_ID.test(haystack)) return 'codex';
  if (GROK_ID.test(haystack)) return 'grok';
  if (AGY_ID.test(haystack)) return 'agy';
  if (CLAUDE_ID.test(haystack)) return 'claude';
  return null;
}

/** Every family whose CLI writes a readable session store. */
export const TRANSCRIPT_FAMILIES = ['claude', 'codex', 'grok', 'agy'];

/** `reconcileRunUsage` returns one record or several — normalize to a list. */
const asRecordList = (records) => (Array.isArray(records) ? records : [records]);

/** List a directory, returning [] when it doesn't exist or can't be read. */
const listDir = async (dir) => readdir(dir).catch(() => []);

/**
 * Every date directory (`YYYY/MM/DD`) a run could have written a Codex rollout
 * into. A run spanning midnight (or a UTC/local boundary) touches two days, so
 * the window's start and end days are both included.
 */
function codexDateDirs(root, fromMs, toMs) {
  const days = new Set();
  const start = Number.isFinite(fromMs) ? fromMs : Date.now();
  const end = Number.isFinite(toMs) ? toMs : start;
  // Step a day at a time from start to end, plus a day either side for
  // timezone skew between the CLI's clock and ours.
  for (let ms = start - 86_400_000; ms <= end + 86_400_000; ms += 86_400_000) {
    const d = new Date(ms);
    days.add(join(
      root,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0')
    ));
    // The CLI files rollouts by LOCAL date; add that path too.
    days.add(join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ));
  }
  return [...days];
}

/**
 * Sum every transcript that overlaps a run's window in its working directory.
 * Returns null when no transcript could be attributed (so the caller keeps its
 * estimate rather than recording a measured zero).
 *
 * @param {object} run
 * @param {string} run.workspacePath cwd the run executed in
 * @param {string|null} run.startTime ISO
 * @param {string|null} run.endTime ISO
 * @param {'claude'|'codex'|'grok'|'agy'} run.family
 * @param {string} [run.home] override for tests
 * @returns {Promise<null|{ source: 'measured'|'estimate'|'mixed', family: string,
 *   sessions: number, model: string|null, messages: number, tokensIn: number,
 *   tokensOut: number, cacheReadTokens: number, cacheWriteTokens: number,
 *   byModel: object }>} `source` reflects what was actually read: grok is
 *   measured from a completed turn but estimated from chat history when a run
 *   died mid-turn, and Antigravity is always an estimate (it writes no token
 *   counts anywhere).
 */
export async function readMeasuredUsage({ workspacePath, startTime, endTime, family, home = homedir() } = {}) {
  if (!workspacePath || !family) return null;

  const startMs = Date.parse(startTime || '');
  const endMs = Date.parse(endTime || '');
  const from = Number.isNaN(startMs) ? null : startMs - WINDOW_SLACK_MS;
  const to = Number.isNaN(endMs) ? null : endMs + WINDOW_SLACK_MS;

  const totals = {
    source: 'measured',
    family,
    sessions: 0,
    model: null,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  };
  const modelCounts = new Map();
  // Per-model token buckets across every folded session, so a run that switched
  // models is priced at each model's own rate rather than billing the whole
  // aggregate at the majority model.
  const byModel = new Map();

  // How each folded session's counts were obtained. Grok can contribute both
  // (a completed turn is measured; a killed session's chat_history is chars/4),
  // and Antigravity is always an estimate — so the record's `source` is derived
  // from what actually landed rather than assumed.
  const sourcesSeen = new Set();

  const fold = (parsed, source = 'measured') => {
    if (!parsed || totalTranscriptTokens(parsed) === 0) return;
    sourcesSeen.add(source);
    totals.sessions += 1;
    totals.messages += parsed.messages || 0;
    totals.tokensIn += parsed.tokensIn || 0;
    totals.tokensOut += parsed.tokensOut || 0;
    totals.cacheReadTokens += parsed.cacheReadTokens || 0;
    totals.cacheWriteTokens += parsed.cacheWriteTokens || 0;
    for (const model of parsed.models?.length ? parsed.models : [parsed.model]) {
      if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    }
    for (const [model, bucket] of Object.entries(parsed.byModel || {})) {
      if (!byModel.has(model)) {
        byModel.set(model, { messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      }
      const target = byModel.get(model);
      target.messages += bucket.messages || 0;
      target.tokensIn += bucket.tokensIn || 0;
      target.tokensOut += bucket.tokensOut || 0;
      target.cacheReadTokens += bucket.cacheReadTokens || 0;
      target.cacheWriteTokens += bucket.cacheWriteTokens || 0;
    }
  };

  // Keys reserved by THIS call, so a failed/empty read can release them.
  const reserved = [];
  // Codex high-water marks advanced by this call, as [path, previousValue], so
  // an empty read restores the prior boundary instead of stranding it.
  const codexReserved = [];
  // Per-file view of the global ledger: a message key is only meaningful within
  // its own transcript, so scope the claim by file path to avoid a same-id
  // collision across two different sessions.
  const excludeFor = (fileKey) => {
    const prefix = `${fileKey}:`;
    return {
      has: (messageKey) => claimedMessages.has(prefix + messageKey)
    };
  };
  // Reserve IMMEDIATELY after each file is parsed, before the next `await`.
  // Deferring every claim to the end of the read would reopen the race the
  // ledger exists to close: this function awaits once per file, so two
  // overlapping runs could both parse file A, both see it unclaimed, and both
  // bill it. Reserving synchronously per file means the second run's read of
  // file A already sees the first run's claim.
  const reserveFrom = (fileKey, parsed) => {
    for (const key of parsed.countedKeys || []) {
      const claimKey = `${fileKey}:${key}`;
      claimedMessages.add(claimKey);
      reserved.push(claimKey);
    }
  };
  // Nothing was attributable after all — release so a later run can claim it.
  const releaseReserved = () => {
    for (const key of reserved) claimedMessages.delete(key);
    for (const [path, previous] of codexReserved) {
      if (previous == null) codexHighWater.delete(path);
      else codexHighWater.set(path, previous);
    }
  };

  if (family === 'claude') {
    // The project directory name is the slugified cwd — an exact lookup, with
    // no directory scan and no chance of picking up another repo's sessions.
    const projectDir = join(home, '.claude', 'projects', claudeProjectSlug(workspacePath));
    for (const file of await listDir(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(projectDir, file);
      const text = await tryReadFile(path);
      if (!text) continue;
      const parsed = parseClaudeTranscript(text, { from, to, exclude: excludeFor(path) });
      reserveFrom(path, parsed);
      fold(parsed);
    }
  } else if (family === 'grok') {
    // `~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/`. Decoding the
    // folder name is an exact cwd lookup with no summary read, so an unrelated
    // repo's sessions are never opened.
    const sessionsRoot = join(home, '.grok', 'sessions');
    for (const dirName of await listDir(sessionsRoot)) {
      if (!cwdMatches(decodeGrokSessionDir(dirName), workspacePath)) continue;
      const cwdDir = join(sessionsRoot, dirName);
      for (const sessionId of await listDir(cwdDir)) {
        const sessionDir = join(cwdDir, sessionId);
        const updatesPath = join(sessionDir, 'updates.jsonl');
        const updatesText = await tryReadFile(updatesPath);
        // Sentinel, not truthiness: `turns > 0` means the session DID record
        // billed turns, so it is measured even when this run's window share is
        // zero. Falling through to the chars/4 estimate there would bill the
        // same session twice, once per shape.
        const parsed = updatesText
          ? parseGrokTurns(updatesText, { from, to, exclude: excludeFor(updatesPath) })
          : null;
        if (parsed?.turns) {
          reserveFrom(updatesPath, parsed);
          fold(parsed, 'measured');
          continue;
        }

        // No `turn_completed` at all — a run killed or interrupted mid-turn.
        // chat_history.jsonl carries no timestamps, so the session is placed by
        // summary.json and billed whole or not at all; the session-level claim
        // is what stops two overlapping runs from each taking it.
        const summary = await readJSONFile(join(sessionDir, 'summary.json'), null);
        if (!summary) continue;
        const startedMs = Date.parse(summary.created_at || '');
        const endedMs = Date.parse(summary.last_active_at || summary.updated_at || summary.created_at || '');
        if (!windowOverlaps(startedMs, endedMs, from, to)) continue;
        const chatPath = join(sessionDir, 'chat_history.jsonl');
        const chatText = await tryReadFile(chatPath);
        if (!chatText) continue;
        const claimKey = `${chatPath}:session`;
        if (claimedMessages.has(claimKey)) continue;
        const chat = parseGrokChatHistory(chatText);
        const estimated = {
          messages: chat.messages,
          tokensIn: estimateTokensFromChars(chat.charsIn),
          tokensOut: estimateTokensFromChars(chat.charsOut),
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        };
        if (totalTranscriptTokens(estimated) === 0) continue;
        claimedMessages.add(claimKey);
        reserved.push(claimKey);
        const named = chat.model || summary.current_model_id || null;
        const modelKey = named ?? UNKNOWN_MODEL;
        fold({ ...estimated, models: named ? [named] : [], byModel: { [modelKey]: { ...estimated } } }, 'estimate');
      }
    }
  } else if (family === 'agy') {
    // Antigravity writes no token counts anywhere, so every row it produces is
    // an honest chars/4 estimate. `history.jsonl` is the only cwd-keyed index;
    // the brain transcript it points at carries the per-step timestamps that
    // place the work inside a run's window.
    const root = join(home, '.gemini', 'antigravity-cli');
    const historyText = await tryReadFile(join(root, 'history.jsonl'));
    for (const conversation of historyText ? parseAgyHistory(historyText) : []) {
      if (!cwdMatches(conversation.workspace, workspacePath)) continue;
      const transcriptPath = join(root, 'brain', conversation.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
      const text = await tryReadFile(transcriptPath);
      if (!text) continue;
      const parsed = parseAgyTranscript(text, { from, to, exclude: excludeFor(transcriptPath) });
      const estimated = {
        messages: parsed.messages,
        tokensIn: estimateTokensFromChars(parsed.charsIn),
        tokensOut: estimateTokensFromChars(parsed.charsOut),
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      };
      if (totalTranscriptTokens(estimated) === 0) continue;
      reserveFrom(transcriptPath, parsed);
      // No model is named anywhere in the transcript — the UNKNOWN_MODEL bucket
      // lets the caller attribute it to the provider's own configured model.
      fold({ ...estimated, models: [], byModel: { [UNKNOWN_MODEL]: { ...estimated } } }, 'estimate');
    }
  } else {
    const sessionsRoot = join(home, '.codex', 'sessions');
    for (const dir of codexDateDirs(sessionsRoot, from ?? Date.now(), to ?? from ?? Date.now())) {
      for (const file of await listDir(dir)) {
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const path = join(dir, file);
        const text = await tryReadFile(path);
        if (!text) continue;
        // A Codex rollout bills as a cumulative DELTA, so a timestamp claim is
        // not enough: a rollout that GROWS between two overlapping runs presents
        // a later snapshot under a different key, and its delta (measured from a
        // baseline before both runs) re-includes what the first run already
        // billed. Track the highest cumulative boundary billed per file and
        // re-parse from there, so each run charges only the genuinely new part.
        // Read the rollout's cumulative position AS OF THIS RUN'S WINDOW END —
        // absolute (no lower bound) so the watermark arithmetic below is a plain
        // subtraction, but capped at `to` so a run only ever bills through its
        // own end. Both halves are load-bearing:
        //   - Absolute (no `from`): a windowed parse already nets out the earlier
        //     snapshot as its baseline, so subtracting the watermark from it would
        //     double-subtract (measured: a later run billed 50, not 150). It also
        //     keeps the math immune to several snapshots sharing one epoch ms,
        //     which is why the timestamp boundary this replaced was unsound.
        //   - Capped at `to`: without it, an EARLY run reading the file after it
        //     grew would bill growth generated after its own window and advance
        //     the watermark past it, leaving the run that actually produced those
        //     tokens with nothing (measured: early run billed 250, late run 0).
        const absolute = parseCodexRollout(text, { to });
        if (!cwdMatches(absolute.cwd, workspacePath)) continue;
        // Require the run's own window to overlap this rollout at all, so a
        // rollout from an unrelated period isn't attributed to this run.
        if (totalTranscriptTokens(parseCodexRollout(text, { from, to })) === 0) continue;

        const billed = codexHighWater.get(path);
        const delta = (field) => Math.max(0, (absolute[field] || 0) - (billed?.[field] || 0));
        const net = {
          ...absolute,
          messages: delta('messages'),
          tokensIn: delta('tokensIn'),
          tokensOut: delta('tokensOut'),
          cacheReadTokens: delta('cacheReadTokens'),
          cacheWriteTokens: delta('cacheWriteTokens')
        };
        if (totalTranscriptTokens(net) === 0) continue;

        // Advance the mark to the absolute position just read, before the next
        // `await` — for the same reason the Claude claim reserves per file: two
        // overlapping runs must not both act on the pre-update value. `Math.max`
        // guards a rollout that was truncated/rewritten smaller, so the mark
        // never moves backwards and re-bills what it already charged.
        codexHighWater.set(path, {
          messages: Math.max(billed?.messages || 0, absolute.messages || 0),
          tokensIn: Math.max(billed?.tokensIn || 0, absolute.tokensIn || 0),
          tokensOut: Math.max(billed?.tokensOut || 0, absolute.tokensOut || 0),
          cacheReadTokens: Math.max(billed?.cacheReadTokens || 0, absolute.cacheReadTokens || 0),
          cacheWriteTokens: Math.max(billed?.cacheWriteTokens || 0, absolute.cacheWriteTokens || 0)
        });
        codexReserved.push([path, billed]);
        // Mirror the net into `byModel` — callers bill from the per-model records,
        // so leaving them at absolute totals would re-charge the billed portion.
        // Codex reports one model per rollout, so the whole net is that model's.
        const modelKey = Object.keys(absolute.byModel || {})[0];
        fold(modelKey
          ? { ...net, byModel: { [modelKey]: {
              messages: net.messages,
              tokensIn: net.tokensIn,
              tokensOut: net.tokensOut,
              cacheReadTokens: net.cacheReadTokens,
              cacheWriteTokens: net.cacheWriteTokens
            } } }
          : net);
      }
    }
  }

  if (totals.sessions === 0) {
    releaseReserved();
    return null;
  }
  totals.model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  totals.byModel = Object.fromEntries(byModel);
  totals.source = sourcesSeen.size === 1 ? [...sourcesSeen][0] : 'mixed';
  return totals;
}

/**
 * Turn a `readMeasuredUsage` result into the per-model usage records
 * `recordRunUsage` persists. `recordedModel` is what PortOS launched (or, for a
 * sibling family, that provider's configured default) — used to name a bucket
 * the transcript itself left unnamed.
 *
 * Returns an ARRAY when the transcript named models (one record per model, so
 * each is priced at its own rate) and a single record when it named none —
 * the shape `reconcileRunUsage` has always handed back, kept as-is so a caller
 * destructuring one form keeps working.
 *
 * `role` marks each record `parent` (the run's own provider) or `sibling` (a
 * nested CLI's session found in the same workspace and window). The historical
 * backfill needs that split — a parent record REPLACES an earlier estimate,
 * while a sibling record is a pure addition to a different provider's bucket —
 * and provider ids alone can't express it. `recordRunUsage` reads only the
 * count fields, so the marker never reaches usage.json.
 */
function recordsFromMeasured(providerId, recordedModel, measured, role) {
  // A family that mixed a measured session with an estimated one reports
  // `mixed` on every record it produced: the two shapes fold into the same
  // per-model buckets, so no record can honestly claim to be purely measured.
  const source = measured.source || 'measured';
  const perModel = Object.entries(measured.byModel || {});
  if (perModel.length > 0) {
    return perModel.map(([model, bucket]) => ({
      providerId,
      role,
      model: attributedModel(recordedModel ?? null, model, perModel.length === 1),
      messages: bucket.messages || 0,
      tokensIn: bucket.tokensIn,
      tokensOut: bucket.tokensOut,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
      source
    }));
  }
  return [{
    providerId,
    role,
    // Prefer the model PortOS recorded (it carries the provider's own id shape,
    // e.g. a Bedrock-prefixed id the pricing table resolves); fall back to the
    // transcript's when PortOS captured none.
    model: recordedModel ?? measured.model ?? null,
    messages: measured.messages || 1,
    tokensIn: measured.tokensIn,
    tokensOut: measured.tokensOut,
    cacheReadTokens: measured.cacheReadTokens,
    cacheWriteTokens: measured.cacheWriteTokens,
    source
  }];
}

/**
 * The enabled provider a sibling family's sessions should be billed to, or null
 * when this install has none configured for that family.
 *
 * Null is the right answer for "no match" — inventing an `unknown grok` bucket
 * would put spend on the cost report that no configured provider can explain.
 * A `cli` record is preferred over a `tui` one (both drive the same binary, and
 * a nested reviewer is always launched headless); `api` records are excluded
 * outright because an API provider writes no local session file. Among several,
 * the one whose configured model the transcript actually names wins, so an
 * install with a light and a heavy grok provider attributes to the right one.
 *
 * @param {Array<object>} providers the install's provider records (`listProviders()`)
 * @param {string} family a `TRANSCRIPT_FAMILIES` id
 * @param {object} measured the `readMeasuredUsage` result, for its model names
 */
export function resolveFamilyProvider(providers, family, measured = null) {
  const candidates = (providers || []).filter((provider) => (
    provider?.enabled !== false && familyForProvider(provider) === family
  ));
  const byType = (type) => candidates.filter((provider) => provider.type === type);
  const pool = byType('cli').length ? byType('cli') : byType('tui');
  if (pool.length === 0) return null;
  const named = new Set([measured?.model, ...Object.keys(measured?.byModel || {})]
    .filter((model) => model && model !== UNKNOWN_MODEL));
  return pool.find((provider) => named.has(provider.defaultModel)) ?? pool[0];
}

/**
 * Measured counts for a completed run, or the caller's estimate when no
 * transcript can be attributed. Always resolves — a transcript read must never
 * fail the run it describes — and always returns a usable record, so a run with
 * no transcript still contributes its estimate rather than recording nothing.
 *
 * **The scan is not limited to the run's own provider family.** A CoS task that
 * ships a PR with `--review-with grok,antigravity` bash-launches those CLIs as
 * CHILDREN of the parent agent — slashdo's review loop never becomes a PortOS
 * run of its own, so nothing else would ever record that spend, and the parent's
 * chars/4 estimate cannot see it either. Every family's session store is
 * therefore searched in the run's workspace and window, and each session is
 * attributed to ITS OWN provider (#5831). The per-message claim ledger stays
 * the exclusivity mechanism, so a nested session is billed exactly once no
 * matter how many overlapping runs can see it.
 *
 * @param {object} run PortOS run metadata (`providerId`, `model`,
 *   `workspacePath`, `startTime`, `endTime`)
 * @param {{ tokensIn: number, tokensOut: number }} estimate fallback counts
 * Returns a single record, or an ARRAY of them when the transcript names more
 * than one model (a mid-run `/model` switch or a fallback), or when a sibling
 * family's session was found — `recordRunUsage` accepts either, and splitting is
 * what keeps each model and each provider priced on its own row.
 *
 * @param {{ home?: string, providers?: Array<object>|null }} [opts] `providers`
 *   enables the sibling scan; omitting it reconciles the parent family only
 *   (which is what a caller with no access to the provider list should do).
 * @returns {Promise<object|Array<object>>}
 */
export async function reconcileRunUsage(run, estimate, { home = homedir(), providers = null } = {}) {
  const workspacePath = run?.workspacePath;
  const startTime = run?.startTime;
  const endTime = run?.endTime;

  // Best-effort: an unreadable home dir, a permissions error, or a CLI format
  // change must degrade to the estimate, never throw into the completion hook.
  const readFamily = (family) => readMeasuredUsage({ workspacePath, startTime, endTime, family, home })
    .catch((err) => {
      console.error(`❌ Usage reconcile failed for ${run?.providerId} (${family}): ${err.message}`);
      return null;
    });

  const family = transcriptFamily({ providerId: run?.providerId, command: run?.command });
  const measured = family ? await readFamily(family) : null;
  const parent = measured
    ? recordsFromMeasured(run?.providerId ?? null, run?.model ?? null, measured, 'parent')
    : {
      providerId: run?.providerId ?? null,
      role: 'parent',
      model: run?.model ?? null,
      messages: 1,
      tokensIn: Math.max(0, estimate?.tokensIn || 0),
      tokensOut: Math.max(0, estimate?.tokensOut || 0),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'estimate'
    };

  const siblings = [];
  for (const sibling of Array.isArray(providers) && providers.length ? TRANSCRIPT_FAMILIES : []) {
    if (sibling === family) continue;
    // Resolve BEFORE reading. No enabled provider for this family means the
    // session is skipped rather than opened as an `unknown` bucket the cost
    // report can't explain — and skipping it before the read matters: a read
    // CLAIMS the messages it folded, so reading first and discarding after
    // would strand those keys and stop a later, correctly-configured run from
    // ever billing them.
    if (!resolveFamilyProvider(providers, sibling)) continue;
    const siblingUsage = await readFamily(sibling);
    if (!siblingUsage) continue;
    // Re-resolve now that the transcript's model names can break a tie between
    // several configured providers of the same family.
    const provider = resolveFamilyProvider(providers, sibling, siblingUsage);
    if (!provider) continue;
    siblings.push(...asRecordList(recordsFromMeasured(provider.id, provider.defaultModel ?? null, siblingUsage, 'sibling')));
    console.log(`💸 Nested ${sibling} session billed to ${provider.id} for run ${run?.id || 'unknown'}`);
  }

  // The parent's shape is preserved when nothing nested was found, so a caller
  // that destructures a single record keeps working on every existing path.
  return siblings.length ? [...asRecordList(parent), ...siblings] : parent;
}

/**
 * The run-completion usage path, shared by the AI Toolkit hook
 * (`services/bootstrap.js`) and CoS agent runs
 * (`services/agentRunTracking.js`) so both record the same shape from the same
 * logic. Estimates tokens the legacy way, upgrades to the provider's measured
 * counts when a transcript can be found, and persists the result.
 *
 * Fire-and-forget by design — the callers invoke it from a completion hook, so
 * it owns its own error handling and never rejects into them. Runs with no
 * `providerId` are skipped rather than attributed to an `unknown` bucket.
 *
 * @param {object} metadata PortOS run metadata
 * @param {string} output captured stdout
 * @param {{ home?: string }} [opts] `home` overrides the transcript root (tests)
 * @returns {Promise<void>}
 */
export async function recordCompletedRunUsage(metadata, output, { home = homedir(), providers = null } = {}) {
  if (!metadata?.providerId) return;

  const estimate = {
    tokensOut: estimateTokens(output),
    tokensIn: estimateTokensFromChars(metadata.promptLength)
  };
  // The provider list enables the sibling-family scan (a nested `--review-with`
  // grok/agy pass leaves a session but no PortOS run). Imported lazily and
  // defensively: this module is also loaded inside the backfill worker thread,
  // where the toolkit singleton is never initialized — that path is handed its
  // providers through `workerData` instead, and must not drag the provider
  // graph in at import time.
  const resolved = providers ?? await import('./providers.js')
    .then((module) => module.listProviders())
    .catch(() => null);
  // One catch for the whole chain: whatever fails — reading a transcript or
  // persisting the record — usage accounting must not surface as a run failure.
  await reconcileRunUsage(metadata, estimate, { home, providers: resolved })
    .then(recordRunUsage)
    .then(async () => {
      if (!metadata?.id) return;
      await markUsageRunReconciled(metadata.id);
      const metadataPath = join(PATHS.runs, metadata.id, 'metadata.json');
      const persisted = await readJSONFile(metadataPath, null);
      if (!persisted) return;
      persisted.usageReconciled = true;
      persisted.usageReconciledAt = new Date().toISOString();
      await atomicWrite(metadataPath, persisted);
    })
    .catch((err) => {
      console.error(`❌ Failed to record usage: ${err.message}`);
    });
}
