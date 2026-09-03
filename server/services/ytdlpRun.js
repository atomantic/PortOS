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
import { createLineReader } from '../lib/streamLines.js';

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
 * Spawn yt-dlp, stream its markers to `onProgress`, and classify the exit.
 *
 * @param {object}   opts
 * @param {string}   opts.ytDlp           yt-dlp binary path.
 * @param {string[]} opts.args            Fully-built argv (marker args included).
 * @param {function} opts.onProgress      ({ percent, stage }) => void — SSE-agnostic.
 * @param {function} opts.registerProcess (proc|null) => void — lets the caller wire cancel.
 * @returns {Promise<{ canceled:boolean, code:number|null, signal:string|null, reason:string|null, title:string }>}
 *   `canceled` is true when the child died on SIGTERM/SIGKILL. `reason` carries
 *   the spawn-failure message when the binary never started, else null.
 */
export async function runYtDlp({ ytDlp, args, onProgress, registerProcess }) {
  const proc = spawn(ytDlp, args, safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
  registerProcess(proc);

  let title = '';
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
    }
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
    // callback right before the caller reports the cancellation.
    return { canceled: true, code: exit.code ?? null, signal: exit.signal, reason: null, title };
  }
  // Flush any final line the child wrote without a trailing newline before exit.
  stdoutReader.flush();
  stderrReader.flush();

  return {
    canceled: false,
    code: exit.code ?? null,
    signal: exit.signal ?? null,
    reason: exit.reason ?? null,
    title,
  };
}
