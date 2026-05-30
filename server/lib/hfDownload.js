// Pre-download a HuggingFace repo snapshot into the local HF cache, with
// SSE-friendly progress events. Used by the inline "Download" badge on
// the image + video gen forms so users don't discover a multi-GB pull
// the first time they hit Render.
//
// Picks a Python venv that has `huggingface_hub` installed. The FLUX.2 venv
// is the preferred choice (always installed when image gen is set up); the
// mflux/legacy pythonPath is the fallback for installs that use only mflux.
//
// Wire protocol parses the stdout/stderr lines from scripts/hf_download_repo.py:
//   STAGE:list                                  -> { type: 'stage', stage: 'list' }
//   STAGE:download:<n>/<total>:<file>           -> stage + progress n/total
//   STAGE:complete:<bytes>                      -> { type: 'complete', sizeBytes }
//   USER_ERROR:<kind>:<detail>                  -> typed-error capture; <detail>
//                                                  is the repo id for list/auth
//                                                  failures and the filename
//                                                  for per-file download errors
//   ❌ <prose>                                   -> errorMessage
// Unknown lines fall through as raw `{ type: 'log', message }`.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveFlux2Python, isFlux2VenvHealthy } from './pythonSetup.js';
import { PATHS } from './fileUtils.js';
import { getHfTokenInfo } from './hfToken.js';
import { safeChildProcessEnv } from './processEnv.js';
import { getSettings } from '../services/settings.js';

const HELPER_SCRIPT = join(PATHS.root, 'scripts', 'hf_download_repo.py');

// Resolve a Python interpreter with huggingface_hub installed. Order: FLUX.2
// venv (the modern path; always has hf_hub via diffusers), then the
// settings.imageGen.local.pythonPath (mflux installs). Returns null if
// neither is available — the caller surfaces a user-facing error rather
// than silently failing the download.
//
// Health-gate the FLUX.2 venv: an interrupted install leaves the binary in
// place but no packages, and resolveFlux2Python() alone would still return
// that broken interpreter. Every download would then fail on the broken
// venv before reaching the working mflux pythonPath.
export async function resolveHfDownloadPython() {
  const flux2 = resolveFlux2Python();
  if (flux2 && await isFlux2VenvHealthy()) return flux2;
  const settings = await getSettings();
  return settings?.imageGen?.local?.pythonPath || null;
}

// Returns `{ promise, kill }`. The promise resolves with `{ ok, sizeBytes,
// errorKind, errorMessage }`. `kill()` SIGTERMs the python child so the
// SSE handler can stop the download when the EventSource client closes.
export function downloadHfRepo({ repo, revision = null, onEvent }) {
  let proc = null;
  let killed = false;
  let errorKind = null;
  let errorMessage = null;
  let sizeBytes = 0;

  const promise = (async () => {
    const pythonPath = await resolveHfDownloadPython();
    // Cancel-before-spawn check. resolveHfDownloadPython runs an
    // isFlux2VenvHealthy() probe (several hundred ms cold) and getHfTokenInfo
    // does file I/O; a kill() landing inside either await otherwise still
    // lets the spawn fire below, leaving a multi-GB HF download running with
    // no SSE client to consume progress and holding the inFlight slot until
    // the whole snapshot finishes.
    if (killed) return { ok: false, errorKind: 'cancelled', errorMessage: 'Cancelled' };
    if (!pythonPath) {
      const msg = 'No Python venv with huggingface_hub found. Install the FLUX.2 venv from Image Gen settings first.';
      onEvent({ type: 'error', message: msg, kind: 'venv_missing' });
      return { ok: false, errorKind: 'venv_missing', errorMessage: msg };
    }
    const { token } = await getHfTokenInfo();
    if (killed) return { ok: false, errorKind: 'cancelled', errorMessage: 'Cancelled' };
    const env = safeChildProcessEnv();
    // The Python helper looks up the token by env-var name so we don't have
    // to pass secrets on argv. Strip any stale value when the user has
    // explicitly cleared their stored token.
    if (token) env.HF_TOKEN = token;
    else delete env.HF_TOKEN;

    const args = [HELPER_SCRIPT, '--repo', repo, '--token-env', 'HF_TOKEN'];
    if (revision) args.push('--revision', revision);

    onEvent({ type: 'stage', stage: 'starting', message: `Downloading ${repo}…` });

    return new Promise((resolve) => {
      proc = spawn(pythonPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      // Window: kill() could have fired between the second `if (killed)`
      // check and the spawn returning the proc handle. Re-check now that we
      // own a proc — if it raced, kill it immediately.
      if (killed) proc.kill('SIGTERM');

      const handleLine = (raw) => {
        const line = raw.trim();
        if (!line) return;
        if (line.startsWith('STAGE:')) {
          // STAGE:<name>[:rest]. Special-case the file-progress + complete
          // shapes so the UI can render a real progress bar; everything
          // else falls through as a generic stage event.
          const body = line.slice('STAGE:'.length);
          const colon = body.indexOf(':');
          const stage = colon === -1 ? body : body.slice(0, colon);
          const detail = colon === -1 ? '' : body.slice(colon + 1);
          if (stage === 'download') {
            // detail looks like `3/47:model-00003-of-00047.safetensors`
            const m = detail.match(/^(\d+)\/(\d+):(.+)$/);
            if (m) {
              const step = parseInt(m[1], 10);
              const total = parseInt(m[2], 10);
              onEvent({
                type: 'progress',
                progress: total > 0 ? step / total : 0,
                step,
                total,
                file: m[3],
              });
              return;
            }
          }
          if (stage === 'complete') {
            const bytes = parseInt(detail, 10);
            if (Number.isFinite(bytes)) sizeBytes = bytes;
            // Don't emit a `complete` event here — wait for the close
            // handler so a successful exit code is required.
            return;
          }
          onEvent({ type: 'stage', stage, detail });
          return;
        }
        if (line.startsWith('USER_ERROR:')) {
          const body = line.slice('USER_ERROR:'.length);
          const colon = body.indexOf(':');
          errorKind = colon === -1 ? body : body.slice(0, colon);
          return;
        }
        if (line.startsWith('❌')) {
          errorMessage = line.replace(/^❌\s*/, '');
          return;
        }
        if (line.startsWith('DOWNLOAD:')) return; // mirrored by STAGE:download
        onEvent({ type: 'log', message: line });
      };

      // Line-buffer across chunks so a STAGE:/USER_ERROR: marker split across
      // pipe boundaries isn't truncated and routed to the generic log path
      // (which loses the typed-error / progress wire shape).
      let stdoutBuf = '';
      let stderrBuf = '';
      const flushChunk = (chunk, key) => {
        const buf = (key === 'stdout' ? stdoutBuf : stderrBuf) + chunk.toString();
        const lines = buf.split(/\r?\n/);
        const trailing = lines.pop();
        if (key === 'stdout') stdoutBuf = trailing;
        else stderrBuf = trailing;
        for (const l of lines) handleLine(l);
      };
      proc.stderr.on('data', (chunk) => flushChunk(chunk, 'stderr'));
      proc.stdout.on('data', (chunk) => flushChunk(chunk, 'stdout'));
      proc.on('error', (err) => {
        const msg = `Failed to spawn python: ${err.message}`;
        onEvent({ type: 'error', message: msg, kind: 'spawn_failed' });
        resolve({ ok: false, errorKind: 'spawn_failed', errorMessage: msg });
      });
      proc.on('close', (code, signal) => {
        // Flush any trailing partial line the python helper emitted without a
        // newline before exit (rare with line-buffered stderr but possible
        // when the process is SIGKILL'd mid-write).
        if (stdoutBuf) { handleLine(stdoutBuf); stdoutBuf = ''; }
        if (stderrBuf) { handleLine(stderrBuf); stderrBuf = ''; }
        if (killed) {
          onEvent({ type: 'error', message: 'Cancelled', kind: 'cancelled' });
          return resolve({ ok: false, errorKind: 'cancelled', errorMessage: 'Cancelled' });
        }
        if (code === 0) {
          onEvent({ type: 'complete', sizeBytes, repo });
          return resolve({ ok: true, sizeBytes });
        }
        const msg = errorMessage || (signal ? `Killed by ${signal}` : `Exit code ${code}`);
        onEvent({ type: 'error', message: msg, kind: errorKind, repo });
        return resolve({ ok: false, errorKind, errorMessage: msg });
      });
    });
  })();

  return {
    promise,
    kill: () => {
      killed = true;
      if (proc && !proc.killed) proc.kill('SIGTERM');
    },
  };
}
