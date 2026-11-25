/**
 * Chunk-by-chunk parser for a headless (non-TUI) CLI agent's stdout and stderr, shared by the direct spawner and the cos-runner.
 *
 * Both hosts feed raw `data` chunks through `createCliAgentOutputParser` and keep their own I/O: the direct path
 * writes the transcript and batches state, the runner emits sockets and writes its completion receipt. The parser
 * is pure and stateful per run: per-stream ANSI stripping (an escape can split across chunks), Claude stream-json
 * line extraction, the Codex stderr formatter, known stderr noise, the `[stderr]` prefix rule, the capped raw
 * stream-json buffer kept for failure analysis, and the usage-limit / auth "stop the provider now" detector.
 *
 * It must stay free of `server/services` imports: the runner is a separate process and this module is in its closure.
 */

import { createStreamingAnsiStripper } from './ansiStrip.js';
import { createStreamJsonParser } from './streamJsonParser.js';
import { createCodexStderrFormatter } from './codexCliOutput.js';
import { isKnownCliStderrNoise } from './cliStderrNoise.js';
import { isCodexCommand } from './codex.js';
import { createImmediateFallbackSignalDetector } from './aiToolkit/errorDetection.js';

export const RAW_STREAM_BUFFER_CAP = 512 * 1024;

/**
 * Stream-json is decided by the provider's declared `streamFormat` when it states one, else by the argv the
 * child was launched with (the runner only receives argv).
 */
function resolveIsStreamJson(streamFormat, args) {
  if (typeof streamFormat === 'string' && streamFormat) return streamFormat === 'stream-json';
  return Array.isArray(args) && args.includes('stream-json');
}

/**
 * @param {object} params
 * @param {string} [params.command] - launch binary; a `codex` basename selects the Codex stderr formatter
 *   (so `codex-ollama` and `codex-lmstudio`, which run the same binary, get it too)
 * @param {string[]} [params.args] - launch argv, consulted for `stream-json` when `streamFormat` is not given
 * @param {string} [params.streamFormat] - the provider's declared stdout format
 * @param {string} [params.prompt] - the Codex formatter hides the echoed prompt
 * @returns {{
 *   stdout: (chunk: Buffer|string) => { lines: string[], text: string, fallbackSignal: object|null },
 *   stderr: (chunk: Buffer|string) => { lines: string[], text: string, fallbackSignal: object|null },
 *   flush: () => { lines: string[], finalResult: string|null, completionResult: string|null },
 *   rawStream: () => string,
 * }}
 *   `lines` are display lines to append with a newline each; `text` is verbatim display text (already carries
 *   its own newlines); both can be empty. `fallbackSignal` is returned once per run, the first time the detector
 *   matches, so a host acts on it exactly once.
 */
export function createCliAgentOutputParser({ command, args, streamFormat, prompt = '' } = {}) {
  const isStreamJson = resolveIsStreamJson(streamFormat, args);
  const streamParser = isStreamJson ? createStreamJsonParser() : null;
  const codexStderrFormatter = isCodexCommand(command) ? createCodexStderrFormatter(prompt) : null;
  // A headless CLI still colors its progress output (`opencode run` emits bare `\x1B[0m` resets around its status
  // line). Strip per stream — each stripper buffers an escape split across two chunks — BEFORE the fallback
  // detector, which matches provider text that color codes would otherwise break up. A stream-json stdout is
  // NDJSON, which escapes ESC into its six-character JSON form and never carries the raw byte, so it skips the scan.
  const stripStdoutAnsi = isStreamJson ? (text) => text : createStreamingAnsiStripper();
  const stripStderrAnsi = createStreamingAnsiStripper();
  const detectFallbackSignal = createImmediateFallbackSignalDetector();
  let rawStreamBuffer = '';
  let fallbackReported = false;

  const detect = (text) => {
    if (fallbackReported) return null;
    const signal = detectFallbackSignal(text);
    if (signal) fallbackReported = true;
    return signal;
  };

  const stdout = (chunk) => {
    const text = stripStdoutAnsi(chunk.toString());
    // Detected on the decolored text before any parsing, so the host can stop the provider before it does the
    // slower transcript work for this chunk.
    const fallbackSignal = detect(text);
    if (streamParser) {
      rawStreamBuffer += text;
      if (rawStreamBuffer.length > RAW_STREAM_BUFFER_CAP) rawStreamBuffer = rawStreamBuffer.slice(-RAW_STREAM_BUFFER_CAP);
      return { lines: streamParser.processChunk(text), text: '', fallbackSignal };
    }
    // Plain stdout is emitted as-is once decolored. Unlike stderr, whitespace is NOT dropped: a blank line is
    // legitimate formatting when it isn't wearing an `[stderr]` tag. A chunk that was purely terminal control
    // decolors to '' and has nothing left to show.
    return { lines: [], text, fallbackSignal };
  };

  const stderr = (chunk) => {
    const text = stripStderrAnsi(chunk.toString());
    // Codex stderr: show thinking + tool names, skip the config dump and command output. Codex echoes the
    // task prompt to stderr, so its signal is read from the formatted lines (prompt echo already removed)
    // rather than the raw stream: a prompt that quotes a usage-limit banner must not stop a healthy run.
    if (codexStderrFormatter) {
      const lines = codexStderrFormatter.processChunk(text);
      return { lines, text: '', fallbackSignal: lines.length ? detect(`[stderr] ${lines.join('\n')}\n`) : null };
    }
    const fallbackSignal = detect(`[stderr] ${text}`);
    // A chunk that decolors down to whitespace was pure terminal control (`opencode run` emits a bare reset per
    // progress redraw); tagging it would add one blank noise line to the tail per redraw.
    const trimmed = text.trim();
    if (!trimmed || isKnownCliStderrNoise(trimmed)) return { lines: [], text: '', fallbackSignal };
    return { lines: [], text: `[stderr] ${text}`, fallbackSignal };
  };

  /** Drain both parsers' unterminated tails; call once, after the last chunk. */
  const flush = () => {
    const lines = [];
    if (streamParser) lines.push(...streamParser.flush());
    if (codexStderrFormatter) lines.push(...codexStderrFormatter.flush());
    return {
      lines,
      // The parsed final result replaces the streamed progress as the persisted transcript when present.
      finalResult: streamParser?.getFinalResult() || null,
      // The result event's own text (no multi-turn stitching): what a card shows as the run summary.
      completionResult: streamParser?.getCompletionResult() ?? null,
    };
  };

  return { stdout, stderr, flush, rawStream: () => rawStreamBuffer };
}
