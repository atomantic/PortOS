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
//   STAGE:download:<n>/<total>:<file>           -> progress at the START of file n
//   STAGE:bytes:<n>/<total>:<got>/<size>:<file> -> byte progress for file n
//   STAGE:verify:<n>/<total>:<file>             -> transfer done; committing/hashing
//   STAGE:complete:<bytes>                      -> { type: 'complete', sizeBytes }
//   USER_ERROR:<kind>:<detail>                  -> typed-error capture; <detail>
//                                                  is the repo id for list/auth
//                                                  failures and the filename
//                                                  for per-file download errors
//   ❌ <prose>                                   -> errorMessage
// Unknown lines fall through as raw `{ type: 'log', message }`.
//
// parseHfDownloadLine is the single decoder — downloadHfRepo and the tests
// share it so a wire-shape change cannot drift between them.

import { spawn } from './childProcess.js';
import { join } from 'node:path';
import {
  resolveFlux2Python, isFlux2VenvHealthy, HF_HUB_PYTHON_RESOLVERS,
} from './pythonSetup.js';
import { PATHS } from './fileUtils.js';
import { getHfTokenInfo } from './hfToken.js';
import { safeChildProcessEnv, safeChildProcessOptions } from './processEnv.js';
import { createLineReader } from './streamLines.js';
import { getSettings } from '../services/settings.js';

const HELPER_SCRIPT = join(PATHS.root, 'scripts', 'hf_download_repo.py');

/**
 * Decode one helper stdout/stderr line into a typed action.
 *
 *   { type: 'event', event }         — emit via onEvent
 *   { type: 'complete', sizeBytes }  — record resident bytes; do not emit yet
 *   { type: 'user_error', errorKind }
 *   { type: 'error_message', message }
 *   { type: 'ignore' }
 */
export function parseHfDownloadLine(raw) {
  const line = String(raw).trim();
  if (!line) return { type: 'ignore' };

  if (line.startsWith('STAGE:')) {
    const body = line.slice('STAGE:'.length);
    const colon = body.indexOf(':');
    const stage = colon === -1 ? body : body.slice(0, colon);
    const detail = colon === -1 ? '' : body.slice(colon + 1);

    if (stage === 'download') {
      // `3/47:model-00003-of-00047.safetensors` — this fires when a file
      // STARTS, so the bar sits at the beginning of that file. Using
      // step/total here made a 1-file 50 GB pull report 100% for the entire
      // transfer.
      const m = detail.match(/^(\d+)\/(\d+):(.+)$/);
      if (m) {
        const step = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        return {
          type: 'event',
          event: {
            type: 'progress',
            stage: 'download',
            progress: total > 0 ? (step - 1) / total : 0,
            step,
            total,
            file: m[3],
          },
        };
      }
    }

    if (stage === 'bytes') {
      // `1/1:26843545600/51506295440:qwen3vl_….safetensors`
      const m = detail.match(/^(\d+)\/(\d+):(\d+)\/(\d+):(.+)$/);
      if (m) {
        const step = parseInt(m[1], 10);
        const files = parseInt(m[2], 10);
        const downloaded = parseInt(m[3], 10);
        const totalBytes = parseInt(m[4], 10);
        const fileFrac = totalBytes > 0 ? Math.min(1, downloaded / totalBytes) : 0;
        return {
          type: 'event',
          event: {
            type: 'progress',
            stage: 'download',
            progress: files > 0 ? ((step - 1) + fileFrac) / files : fileFrac,
            step,
            total: files,
            downloaded,
            totalBytes,
            file: m[5],
          },
        };
      }
    }

    if (stage === 'verify') {
      const m = detail.match(/^(\d+)\/(\d+):(.+)$/);
      if (m) {
        const step = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        return {
          type: 'event',
          event: {
            type: 'progress',
            stage: 'verify',
            progress: total > 0 ? step / total : 1,
            step,
            total,
            file: m[3],
          },
        };
      }
    }

    if (stage === 'complete') {
      const bytes = parseInt(detail, 10);
      return { type: 'complete', sizeBytes: Number.isFinite(bytes) ? bytes : 0 };
    }

    return { type: 'event', event: { type: 'stage', stage, detail } };
  }

  if (line.startsWith('USER_ERROR:')) {
    const body = line.slice('USER_ERROR:'.length);
    const colon = body.indexOf(':');
    return { type: 'user_error', errorKind: colon === -1 ? body : body.slice(0, colon) };
  }

  if (line.startsWith('❌')) {
    return { type: 'error_message', message: line.replace(/^❌\s*/, '') };
  }

  // Mirrored by STAGE:download — the helper prints both so older regexes still match.
  if (line.startsWith('DOWNLOAD:')) return { type: 'ignore' };

  return { type: 'event', event: { type: 'log', message: line } };
}

// Resolve a Python interpreter with huggingface_hub installed. Order: FLUX.2
// venv (the modern path; always has hf_hub via diffusers), then the
// settings.imageGen.local.pythonPath (mflux installs), then any provisioned
// MUSIC venv (acestep/audioldm2/musicgen all install huggingface_hub) so the
// Track editor's "Install model" button works in a MUSIC-ONLY setup with no
// image-gen configured. Returns null if none is available — the caller
// surfaces a user-facing error rather than silently failing the download.
//
// Health-gate the FLUX.2 venv: an interrupted install leaves the binary in
// place but no packages, and resolveFlux2Python() alone would still return
// that broken interpreter. Every download would then fail on the broken
// venv before reaching the working fallback.
export async function resolveHfDownloadPython(preferredPython = null) {
  if (preferredPython) return preferredPython;
  const flux2 = resolveFlux2Python();
  if (flux2 && await isFlux2VenvHealthy()) return flux2;
  const settings = await getSettings();
  if (settings?.imageGen?.local?.pythonPath) return settings.imageGen.local.pythonPath;
  // Any provisioned music venv is a valid hf_hub host — used when only music
  // gen is set up. pythonSetup owns the list so it can't drift out of step with
  // the resolvers themselves (see HF_HUB_PYTHON_RESOLVERS).
  for (const resolve of HF_HUB_PYTHON_RESOLVERS) {
    const found = resolve();
    if (found) return found;
  }
  return null;
}

// Argv for scripts/hf_download_repo.py. Pure and exported so the flag contract
// is unit-tested without spawning python — the same split as buildSidecarArgs in
// services/pipeline/musicGen.js. Returns `onlyFiles` too because the caller
// branches its progress copy on single-file mode.
export function buildHfDownloadArgs({ repo, revision = null, only = null, ignore = null, tokenEnv = 'HF_TOKEN' }) {
  const globList = (v) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && f.length > 0) : []);
  const args = [HELPER_SCRIPT, '--repo', repo, '--token-env', tokenEnv];
  if (revision) args.push('--revision', revision);
  const onlyFiles = globList(only);
  for (const f of onlyFiles) args.push('--only', f);
  // The helper hard-errors on --only with --ignore (single-file mode never
  // enumerates the repo, so there is nothing to filter). Single-file mode wins.
  if (!onlyFiles.length) for (const pat of globList(ignore)) args.push('--ignore', pat);
  return { args, onlyFiles };
}

// Returns `{ promise, kill }`. The promise resolves with `{ ok, sizeBytes,
// errorKind, errorMessage }`. `kill()` SIGTERMs the python child so the
// SSE handler can stop the download when the EventSource client closes.
//
// `only` is an array of exact repo-relative filenames. When set, the helper
// runs in SINGLE-FILE mode: it never enumerates the repo and fetches only those
// files. This is MANDATORY for aggregate repos — `DeepBeepMeep/LTX-2` mirrors
// every LTX weight in one ~708 GB repo, so a snapshot would fill the user's
// disk to pull one 1.3 GB IC-LoRA (see server/lib/icLoraWeights.js).
//
// `ignore` is an array of fnmatch globs dropped from the enumerated file list —
// the inverse tool, for repos that ship extra checkpoint formats the runtime
// never loads (MiniMax Music 3 carries a 20 GB captioning model and 10 GB of
// original-format .pth beside the 29 GB the diffusers pipeline actually reads).
// It is ignored in single-file mode, where the helper never enumerates at all.
export function downloadHfRepo({ repo, revision = null, only = null, ignore = null, pythonPath: preferredPython = null, onEvent }) {
  let proc = null;
  let killed = false;
  let errorKind = null;
  let errorMessage = null;
  let sizeBytes = 0;

  const promise = (async () => {
    const pythonPath = await resolveHfDownloadPython(preferredPython);
    // Cancel-before-spawn check. resolveHfDownloadPython runs an
    // isFlux2VenvHealthy() probe (several hundred ms cold) and getHfTokenInfo
    // does file I/O; a kill() landing inside either await otherwise still
    // lets the spawn fire below, leaving a multi-GB HF download running with
    // no SSE client to consume progress and holding the inFlight slot until
    // the whole snapshot finishes.
    if (killed) return { ok: false, errorKind: 'cancelled', errorMessage: 'Cancelled' };
    if (!pythonPath) {
      const msg = 'No Python runtime with huggingface_hub is ready. Install or repair the selected runtime from the model setup panel.';
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

    const { args, onlyFiles } = buildHfDownloadArgs({ repo, revision, only, ignore });

    onEvent({
      type: 'stage',
      stage: 'starting',
      message: onlyFiles.length
        ? `Downloading ${onlyFiles.join(', ')} from ${repo}…`
        : `Downloading ${repo}…`,
    });

    return new Promise((resolve) => {
      proc = spawn(pythonPath, args, safeChildProcessOptions({ env, stdio: ['ignore', 'pipe', 'pipe'] }));
      // Window: kill() could have fired between the second `if (killed)`
      // check and the spawn returning the proc handle. Re-check now that we
      // own a proc — if it raced, kill it immediately.
      if (killed) proc.kill('SIGTERM');

      const handleLine = (raw) => {
        const parsed = parseHfDownloadLine(raw);
        if (parsed.type === 'ignore') return;
        if (parsed.type === 'complete') {
          sizeBytes = parsed.sizeBytes;
          // Don't emit a `complete` event here — wait for the close
          // handler so a successful exit code is required.
          return;
        }
        if (parsed.type === 'user_error') {
          errorKind = parsed.errorKind;
          return;
        }
        if (parsed.type === 'error_message') {
          errorMessage = parsed.message;
          return;
        }
        onEvent(parsed.event);
      };

      // Line-buffer across chunks so a STAGE:/USER_ERROR: marker split across
      // pipe boundaries isn't truncated and routed to the generic log path
      // (which loses the typed-error / progress wire shape). Separate reader
      // per stream — a shared carry buffer would splice stdout onto stderr.
      const stdoutReader = createLineReader(handleLine);
      const stderrReader = createLineReader(handleLine);
      proc.stderr.on('data', stderrReader.push);
      proc.stdout.on('data', stdoutReader.push);
      proc.on('error', (err) => {
        const msg = `Failed to spawn python: ${err.message}`;
        onEvent({ type: 'error', message: msg, kind: 'spawn_failed' });
        resolve({ ok: false, errorKind: 'spawn_failed', errorMessage: msg });
      });
      proc.on('close', (code, signal) => {
        // Flush any trailing partial line the python helper emitted without a
        // newline before exit (rare with line-buffered stderr but possible
        // when the process is SIGKILL'd mid-write).
        stdoutReader.flush();
        stderrReader.flush();
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
