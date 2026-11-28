/**
 * yt-dlp invocation core shared by the audio and video importers: spawn, per-stream
 * line reading, the `PORTOS_*` marker protocol, the exit promise and the
 * cancel-without-flush branch. Does NOT touch the filesystem; destination, output
 * discovery and partial cleanup stay with the caller.
 *
 * Runs in child-process event handlers, so it never throws for a yt-dlp runtime
 * failure: it classifies the exit and RETURNS it.
 */

import { spawn } from '../lib/childProcess.js';
import { safeChildProcessOptions, withoutServerSecretsEnv } from '../lib/processEnv.js';
import { createLineReader, createOutputTail } from '../lib/streamLines.js';
import { isYoutubeVideoUrl } from '../lib/youtubeUrl.js';

/**
 * Wire protocol between our `--progress-template`/`--print` flags and the parser
 * below; custom markers rather than scraping human-readable console lines.
 */
export const YTDLP_MARKERS = {
  TITLE: 'PORTOS_TITLE:',
  PROGRESS: 'PORTOS_PROGRESS:',
  STAGE: 'PORTOS_STAGE:',
};

/**
 * The argv fragment that emits the markers `runYtDlp` parses.
 *
 * `--print` implies `--simulate` (hence `--no-simulate`) and suppresses all normal
 * progress reporting (hence `--progress` plus the two `--progress-template`s).
 *
 * @param {string} postprocessStage Stage label reported once postprocessing
 *   starts ('extracting' for audio, 'merging' for video).
 */
export const ytdlpMarkerArgs = (postprocessStage) => [
  '--newline',
  '--print', `${YTDLP_MARKERS.TITLE}%(title)s`,
  '--progress-template', `download:${YTDLP_MARKERS.PROGRESS}%(progress._percent_str)s`,
  '--progress-template', `postprocess:${YTDLP_MARKERS.STAGE}${postprocessStage}`,
  '--no-simulate',
  '--progress',
];

/**
 * An out-of-date yt-dlp reports a video the browser plays fine as a flat
 * `HTTP Error 403: Forbidden` (YouTube player-client / PO-token handshake).
 * Every alternative must be diagnostic of THAT class: `Sign in to confirm` (bot
 * check, remedy is cookies) is excluded. The hint is also gated on the SOURCE
 * (`describeYtDlpFailure` applies it only to YouTube video URLs), since x.com and
 * other sites return plain 403s an upgrade cannot fix.
 */
const STALE_YTDLP_SIGNATURE = /HTTP Error 403|PO Token|nsig|Failed to extract any player response/i;

const STALE_YTDLP_HINT = 'the installed yt-dlp is likely out of date for YouTube\'s current player — update it (`yt-dlp -U`, or `brew upgrade yt-dlp`) and retry';

/**
 * `connect()` failing with EBADF is how a macOS outbound filter (Little Snitch or
 * another NetworkExtension) reports a DENIED connection, not a network fault; an
 * upgrade cannot fix it, so it gets its own source-agnostic remedy.
 */
const BLOCKED_CONNECT_SIGNATURE = /Failed to establish a new connection: \[Errno 9\] Bad file descriptor/i;

const BLOCKED_CONNECT_HINT = 'the connection was blocked on this machine, which usually means an outbound network filter (e.g. Little Snitch) denied yt-dlp — check that the filter is running and allows yt-dlp and its Python, then retry';

/**
 * Compose the user-facing reason for a failed yt-dlp run. Exported for the case
 * the runner cannot describe: a clean exit that produced no file.
 *
 * @param {number|null} code       Exit code (null when the binary never started).
 * @param {string}      output     Recent yt-dlp output (the tail).
 * @param {string}     [o.fallback] The caller's own account of the failure; yt-dlp's
 *   own words are appended to it whenever there are any.
 * @param {string}     [o.url]      Source URL; omit it and the stale-player hint is
 *   never added.
 */
export function describeYtDlpFailure(code, output, { fallback, url } = {}) {
  const said = (output || '').trim();
  const base = fallback
    ? [fallback, said].filter(Boolean).join(' — yt-dlp said: ')
    : (said ? `yt-dlp failed: ${said}` : `yt-dlp exited ${code}`);
  if (BLOCKED_CONNECT_SIGNATURE.test(said)) return `${base} — ${BLOCKED_CONNECT_HINT}`;
  const stalePlayer = isYoutubeVideoUrl(url) && STALE_YTDLP_SIGNATURE.test(said);
  return stalePlayer ? `${base} — ${STALE_YTDLP_HINT}` : base;
}

/**
 * Spawn yt-dlp, stream its markers to `onProgress`, and classify the exit.
 *
 * @param {object}   opts
 * @param {string}   opts.ytDlp           yt-dlp binary path.
 * @param {string[]} opts.args            Fully-built argv (marker args included).
 * @param {string}   [opts.url]          Source URL, forwarded to `describeYtDlpFailure`.
 * @param {function} opts.onProgress      ({ percent, stage }) => void — SSE-agnostic.
 * @param {function} opts.registerProcess (proc|null) => void — lets the caller wire cancel.
 * @returns {Promise<{ canceled:boolean, code:number|null, signal:string|null, reason:string|null, title:string, output:string }>}
 *   `canceled` is true when the child died on SIGTERM/SIGKILL. `reason` is the
 *   user-facing failure prose for any non-zero exit — the spawn-failure message
 *   when the binary never started, else what yt-dlp printed (see
 *   `describeYtDlpFailure`) — and null on a clean exit. `output` is the raw tail
 *   of non-marker output, for callers that compose their own reason.
 */
export async function runYtDlp({ ytDlp, args, url, onProgress, registerProcess }) {
  const proc = spawn(ytDlp, args, safeChildProcessOptions({
    env: withoutServerSecretsEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
  }));
  registerProcess(proc);

  let title = '';
  // Marker lines return early so progress spam never evicts the `ERROR:` line
  // from the tail's budget.
  const tail = createOutputTail();
  const onLine = (line) => {
    if (line.startsWith(YTDLP_MARKERS.TITLE)) {
      title = line.slice(YTDLP_MARKERS.TITLE.length).trim();
      return;
    }
    if (line.startsWith(YTDLP_MARKERS.PROGRESS)) {
      const percent = parseFloat(line.slice(YTDLP_MARKERS.PROGRESS.length));
      if (Number.isFinite(percent)) onProgress({ percent });
      return;
    }
    if (line.startsWith(YTDLP_MARKERS.STAGE)) {
      onProgress({ percent: 100, stage: line.slice(YTDLP_MARKERS.STAGE.length) });
      return;
    }
    tail.remember(line);
  };
  // Separate readers per stream: a shared buffer could splice a partial line
  // from one stream with a chunk from the other, corrupting a marker line.
  const stdoutReader = createLineReader(onLine);
  const stderrReader = createLineReader(onLine);
  proc.stdout.on('data', stdoutReader.push);
  proc.stderr.on('data', stderrReader.push);

  const exit = await new Promise((resolve) => {
    proc.on('error', (err) => resolve({ code: null, reason: `spawn failed: ${err.message}` }));
    proc.on('close', (code, signal) => resolve({ code, signal }));
  });
  registerProcess(null);

  if (exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL') {
    // No flush on cancel: a SIGKILL'd child leaves a partial marker line that
    // would fire a stray progress callback before the cancellation is reported.
    return { canceled: true, code: exit.code ?? null, signal: exit.signal, reason: null, title, output: tail.text() };
  }
  // yt-dlp's `ERROR:` line is often an unterminated last line: flush BEFORE reading the tail.
  stdoutReader.flush();
  stderrReader.flush();

  const code = exit.code ?? null;
  const output = tail.text();
  // Exit 0 keeps `reason: null`: the caller owns the "exited 0 but produced nothing" case.
  const reason = code === 0 ? null : (exit.reason ?? describeYtDlpFailure(code, output, { url }));

  return { canceled: false, code, signal: exit.signal ?? null, reason, title, output };
}
