/**
 * Settle where a container project lives on a Windows host, once, for every
 * stack that has one (vLLM and SGLang share this settle → detect → record → emit loop).
 *
 * On Windows the answer is never `%USERPROFILE%\<leaf>`: Docker Desktop's engine
 * IS a WSL2 VM, so the Windows filesystem is a slow 9p share. This asks WSL for
 * the distro and user and records the answer so every later resolver agrees.
 * Nothing here throws (SSE headers are already flushed): failure is the refusal string.
 */

import { detectWslProjectDir, WSL_UNC_PREFIX } from '../lib/wslDistro.js';

/** The real distros to offer, when there are any. */
const nameDistros = (distros) => (distros?.length
  ? ` PortOS can see ${distros.join(', ')} — \`wsl --set-default <name>\` picks one; otherwise`
  : ' Install one with');

// Lead sentence per unanswered-WSL case; a table so the shared tail (which rules
// out `C:\` and names the override) is appended exactly once.
const PLACEMENT_REFUSALS = Object.freeze({
  'internal-distro': (f, _detail, { sizeHint }) => `the default WSL distro is \`${f.distro}\`, which is a container engine's own plumbing — it is recreated from scratch on a reset, so ${sizeHint} of weights must not live there.${nameDistros(f.distros)} \`wsl --install -d Ubuntu\`.`,
  'unreadable-share': (f, detail) => `the \`${f.distro}\` distro answered, but Windows cannot read ${f.home} — the ${WSL_UNC_PREFIX} share is not responding${detail}. \`wsl --shutdown\` restarts it (that takes the whole VM down, so stop your containers first).`,
  'no-distro': (f, detail) => `WSL is present but no distro answered${detail}, so there is no Linux filesystem to put this project on.${nameDistros(f.distros)} \`wsl --install -d Ubuntu\`.`,
  'no-wsl': (_f, detail, { afterInstall }) => `this stack runs inside WSL2 — Docker Desktop's own engine IS a WSL2 VM — and \`wsl.exe\` did not run on this host${detail}. Install a distro with \`wsl --install -d Ubuntu\`, then ${afterInstall}.`,
});

/**
 * Why PortOS could not find a Linux-side home for this project on Windows:
 * prose the checklist renders verbatim, one fix per case.
 * @param {{reason?: string, distro?: string, home?: string, error?: string, distros?: string[]}} found
 * @param {{envVar: string, sizeHint: string, afterInstall: string}} stack
 */
function wslPlacementRefusal(found, stack) {
  const lead = PLACEMENT_REFUSALS[found?.reason] || PLACEMENT_REFUSALS['no-wsl'];
  const detail = found?.error ? ` (${found.error})` : '';
  return `${lead(found || {}, detail, stack)} PortOS will not fall back to the Windows filesystem, where every one of those weight reads would cross a 9p share. To place the project somewhere of your own choosing instead, set ${stack.envVar} and click this again.`;
}

/**
 * Settle where one stack's project goes before anything is written to it.
 * Detection runs ONLY when nothing already answers (an env var or earlier
 * recording wins); off Windows there is nothing to detect.
 *
 * @param {object} stack
 * @param {string} stack.envVar - the operator override / record key, e.g. `VLLM_QWEN_PROJECT_DIR`
 * @param {string} stack.leaf - the directory name inside the distro's home
 * @param {string} stack.sizeHint - the payload named in the progress line, e.g. `~20 GB`
 * @param {string} stack.afterInstall - completes "Install a distro with …, then ___."
 * @param {() => boolean} stack.isSettled - does anything already answer this?
 * @param {(dir: string) => Promise<unknown>} stack.record - persist the answer
 * @param {(line: string) => void} [stack.emit]
 * @returns {Promise<string|null>} the refusal, or `null` once the directory is settled
 */
export async function ensureWslProjectDir({
  envVar,
  leaf,
  sizeHint,
  afterInstall,
  isSettled,
  record,
  emit = () => {},
}) {
  if (process.platform !== 'win32') return null;
  if (isSettled()) return null;

  emit(`Windows host — asking WSL where this project belongs, so its ${sizeHint} of weights sit on the distro filesystem rather than on the Windows one.`);
  const found = await detectWslProjectDir(leaf);
  if (!found.dir) return wslPlacementRefusal(found, { envVar, sizeHint, afterInstall });

  emit(`Using the \`${found.distro}\` distro, at ${found.dir}.`);
  // This process FIRST, the file second: every resolver reads the env ahead of the
  // record, so even a failed write can't send the next inspection back to
  // `%USERPROFILE%\<leaf>`, the C:\ placement this path exists to refuse.
  process.env[envVar] = found.dir;
  // Recording only makes the choice outlive this run; a failed write costs just that.
  const recordedOk = await record(found.dir).then(() => true, (err) => {
    emit(`Could not record ${envVar} in PortOS's .env (${err.message}) — this run still uses that directory, but set it there yourself or the next restart will look on the Windows filesystem again.`);
    return false;
  });
  if (recordedOk) emit(`Recorded ${envVar} in PortOS's .env, so the readiness check and the Start button find it too.`);
  return null;
}
