/**
 * The yt-dlp invocation core shared by the audio and video importers.
 *
 * `ytdlpAudioImport.js` and `ytdlpVideoImport.js` are mirror images: they build
 * different argv (audio extraction vs. video merge/remux) and discover their
 * output differently, but the middle — spawn, per-stream line reading, the
 * `PORTOS_*` marker protocol, the exit promise, the cancel-without-flush branch
 * — was duplicated verbatim in both. A yt-dlp release that renames a
 * `--progress-template` key or changes signal behaviour then had to be fixed
 * twice. This module owns that middle so it is fixed once.
 *
 * It deliberately does NOT touch the filesystem: creating the destination,
 * probing for the produced file, and deleting partials stay with the caller,
 * which is what lets the two importers keep their different output-discovery
 * strategies.
 *
 * Runs outside the Express request lifecycle (child-process event handlers), so
 * it never throws for a yt-dlp runtime failure — it classifies the exit and
 * RETURNS it. The caller turns that into an outcome and user-facing prose.
 */

import { spawn } from '../lib/childProcess.js';
import { safeChildProcessOptions } from '../lib/processEnv.js';
import { createLineReader, createOutputTail } from '../lib/streamLines.js';
import { isYoutubeVideoUrl } from '../lib/youtubeUrl.js';

/**
 * The wire protocol between our `--progress-template`/`--print` flags and the
 * parser below. Custom markers rather than scraping the human-readable
 * `[download] NN%` / `[ExtractAudio]` console lines — a stable machine
 * interface (mirrors ffmpeg's `-progress pipe:2` key=value protocol used by
 * render.js) that a yt-dlp text-format change can't silently break.
 */
export const YTDLP_MARKERS = {
  TITLE: 'PORTOS_TITLE:',
  PROGRESS: 'PORTOS_PROGRESS:',
  STAGE: 'PORTOS_STAGE:',
};

/**
 * The argv fragment that emits the markers `runYtDlp` parses. Shared because it
 * IS the protocol; the format-selection flags around it stay with each importer,
 * since those are the actual domain difference.
 *
 * `--print` has two side effects that would otherwise break the job (confirmed
 * against a real download): it implies `--simulate` (skips the actual
 * download/postprocess entirely, so `--no-simulate` is required to force the
 * real run), AND it suppresses ALL of yt-dlp's normal progress/postprocessor
 * reporting — so `--progress` plus the two `--progress-template`s are required
 * to get stable, machine-readable progress/stage markers back alongside the
 * printed title in one invocation.
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
 * YouTube gates its media URLs behind a player-client / PO-token handshake that
 * yt-dlp tracks release-to-release, so a binary only weeks out of date reports a
 * video the browser plays fine as a flat `HTTP Error 403: Forbidden`. That is
 * the most common cause of a failed download here and it is invisible from the
 * message alone, so name the remedy rather than leaving the user to re-try.
 *
 * Every alternative below must be diagnostic of THAT class, or the hint sends
 * the user to the one action that cannot help. Excluded for that reason: `Sign
 * in to confirm`, YouTube's bot check, whose remedy is cookies rather than an
 * upgrade.
 *
 * The message alone is NOT enough to decide, though — these importers also pull
 * from x.com/Twitter (login-walled and rate-limited posts return a plain 403)
 * and, on the reference-audio path, from any public URL. So the hint is gated on
 * the SOURCE as well: `describeYtDlpFailure` applies it only when the URL is a
 * YouTube video. A caller that passes no URL gets no hint — silence beats
 * pointing the user at an upgrade that cannot help.
 */
const STALE_YTDLP_SIGNATURE = /HTTP Error 403|PO Token|nsig|Failed to extract any player response/i;

const STALE_YTDLP_HINT = 'the installed yt-dlp is likely out of date for YouTube\'s current player — update it (`yt-dlp -U`, or `brew upgrade yt-dlp`) and retry';

/**
 * Compose the user-facing reason for a failed yt-dlp run.
 *
 * Exported because both importers need it for the case the runner cannot
 * describe — a clean exit that produced no file — and because the prose is
 * worth pinning by a unit test rather than only through a spawn.
 *
 * @param {number|null} code       Exit code (null when the binary never started).
 * @param {string}      output     Recent yt-dlp output (the tail).
 * @param {string}     [o.fallback] The caller's own account of the failure, for
 *   a run that exited 0 and still produced nothing: only the caller knows which
 *   of its bounds was tripped. yt-dlp's own words outrank a guess, so they are
 *   appended to it whenever there are any.
 * @param {string}     [o.url]      The source URL, which decides whether the
 *   stale-player hint applies at all (see `STALE_YTDLP_SIGNATURE`). Omit it and
 *   the hint is never added.
 */
export function describeYtDlpFailure(code, output, { fallback, url } = {}) {
  const said = (output || '').trim();
  const base = fallback
    ? [fallback, said].filter(Boolean).join(' — yt-dlp said: ')
    : (said ? `yt-dlp failed: ${said}` : `yt-dlp exited ${code}`);
  const stalePlayer = isYoutubeVideoUrl(url) && STALE_YTDLP_SIGNATURE.test(said);
  return stalePlayer ? `${base} — ${STALE_YTDLP_HINT}` : base;
}

/**
 * Spawn yt-dlp, stream its markers to `onProgress`, and classify the exit.
 *
 * @param {object}   opts
 * @param {string}   opts.ytDlp           yt-dlp binary path.
 * @param {string[]} opts.args            Fully-built argv (marker args included).
 * @param {string}   [opts.url]          The source URL, forwarded to
 *   `describeYtDlpFailure` so a YouTube-only remedy is never suggested for a
 *   failure from another site. Omitting it only costs the hint.
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
  const proc = spawn(ytDlp, args, safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
  registerProcess(proc);

  let title = '';
  // Recent non-marker output, kept so a non-zero exit reports what yt-dlp said
  // instead of just its exit code. Marker lines are our own protocol and each
  // branch below returns, so progress spam never evicts the `ERROR:` line from
  // the tail's budget.
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
  // Separate readers per stream — stdout and stderr chunks arrive
  // independently, so a shared buffer can complete a partial line from one
  // stream with a chunk from the other, corrupting a marker line.
  const stdoutReader = createLineReader(onLine);
  const stderrReader = createLineReader(onLine);
  proc.stdout.on('data', stdoutReader.push);
  proc.stderr.on('data', stderrReader.push); // yt-dlp writes some progress/info lines to stderr too

  const exit = await new Promise((resolve) => {
    proc.on('error', (err) => resolve({ code: null, reason: `spawn failed: ${err.message}` }));
    proc.on('close', (code, signal) => resolve({ code, signal }));
  });
  registerProcess(null);

  if (exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL') {
    // Don't flush on cancel — a SIGKILL'd child leaves only a partial marker
    // line in the carry, and emitting it would fire a stray progress/stage
    // callback right before the caller reports the cancellation. `output` is
    // still reported (minus that unflushed carry) so every return from this
    // function has the one shape its callers can rely on.
    return { canceled: true, code: exit.code ?? null, signal: exit.signal, reason: null, title, output: tail.text() };
  }
  // Flush any final line the child wrote without a trailing newline before exit.
  // yt-dlp's `ERROR:` line is often exactly that last line, so flushing has to
  // happen BEFORE the tail is read or the failure reason loses its cause.
  stdoutReader.flush();
  stderrReader.flush();

  const code = exit.code ?? null;
  const output = tail.text();
  // Exit 0 keeps `reason: null` — the caller owns the "exited 0 but produced
  // nothing" case, where the bound that was tripped is knowable only to it. A
  // spawn failure has no output to explain it, so its own message stands.
  const reason = code === 0 ? null : (exit.reason ?? describeYtDlpFailure(code, output, { url }));

  return { canceled: false, code, signal: exit.signal ?? null, reason, title, output };
}
