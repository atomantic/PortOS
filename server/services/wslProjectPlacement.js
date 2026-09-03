/**
 * Settle where a container project lives on a Windows host, once, for every
 * stack that has one.
 *
 * On Windows the answer is never the default `%USERPROFILE%\<leaf>`: Docker
 * Desktop's engine IS a WSL2 VM, so a project on the Windows filesystem is
 * reached from inside that VM over a 9p share, and tens of gigabytes of weights
 * would be written across it once and paged back across it forever. PortOS used
 * to refuse and hand the operator a UNC template with `<distro>` and `<user>`
 * left as literal angle brackets for them to look up; it now asks WSL for those
 * two values (`lib/wslDistro.js`) and records the answer
 * (`lib/recordedProjectDir.js`), so the readiness poll, the Start button, and
 * the next server boot all resolve the directory this run actually used.
 *
 * This module is the loop — settle → detect → record → emit — and it is
 * deliberately the ONLY copy of it. Two stacks use it today (vLLM, which then
 * clones into the directory, and SGLang, which only ever finds a hand-prepared
 * one), and the difference between them is prose, not mechanism.
 *
 * It lives in `services/` rather than `lib/` because it spawns a subprocess and
 * writes a file, neither of which a `lib/` module promises.
 *
 * Nothing here throws: every caller runs from an SSE route whose headers are
 * already flushed, so a failure comes back as the refusal string.
 */

import { detectWslProjectDir, WSL_UNC_PREFIX } from '../lib/wslDistro.js';

/** The real distros to offer, when there are any. */
const nameDistros = (distros) => (distros?.length
  ? ` PortOS can see ${distros.join(', ')} — \`wsl --set-default <name>\` picks one; otherwise`
  : ' Install one with');

/**
 * The lead sentence for each way the WSL question can go unanswered.
 *
 * A table rather than four returns so the shared tail below is appended exactly
 * once. That tail is the part that must never go missing — a fifth reason added
 * to `detectWslProjectDir` would otherwise ship a refusal that neither rules out
 * `C:\` nor names the override.
 *
 * Only `no-wsl` needs a per-stack word, and only in its last clause: what the
 * operator does once a distro exists differs between a stack PortOS provisions
 * for them and one they prepare by hand.
 */
const PLACEMENT_REFUSALS = Object.freeze({
  'internal-distro': (f, _detail, { sizeHint }) => `the default WSL distro is \`${f.distro}\`, which is a container engine's own plumbing — it is recreated from scratch on a reset, so ${sizeHint} of weights must not live there.${nameDistros(f.distros)} \`wsl --install -d Ubuntu\`.`,
  'unreadable-share': (f, detail) => `the \`${f.distro}\` distro answered, but Windows cannot read ${f.home} — the ${WSL_UNC_PREFIX} share is not responding${detail}. \`wsl --shutdown\` restarts it (that takes the whole VM down, so stop your containers first).`,
  'no-distro': (f, detail) => `WSL is present but no distro answered${detail}, so there is no Linux filesystem to put this project on.${nameDistros(f.distros)} \`wsl --install -d Ubuntu\`.`,
  'no-wsl': (_f, detail, { afterInstall }) => `this stack runs inside WSL2 — Docker Desktop's own engine IS a WSL2 VM — and \`wsl.exe\` did not run on this host${detail}. Install a distro with \`wsl --install -d Ubuntu\`, then ${afterInstall}.`,
});

/**
 * Why PortOS could not find a Linux-side home for this project on a Windows
 * host — prose the checklist renders verbatim, one fix per case.
 *
 * There is no case for "the operator did not configure a directory" any more.
 * That was the old refusal, and it asked a person to look up two values
 * (`<distro>`, `<user>`) that WSL will state on request. What survives is the
 * set of answers PortOS genuinely cannot supply for itself: a machine with no
 * WSL, a default distro that belongs to a container engine, and a share Windows
 * cannot read.
 *
 * @param {{reason?: string, distro?: string, home?: string, error?: string, distros?: string[]}} found
 * @param {{envVar: string, sizeHint: string, afterInstall: string}} stack
 * @returns {string}
 */
function wslPlacementRefusal(found, stack) {
  const lead = PLACEMENT_REFUSALS[found?.reason] || PLACEMENT_REFUSALS['no-wsl'];
  const detail = found?.error ? ` (${found.error})` : '';
  return `${lead(found || {}, detail, stack)} PortOS will not fall back to the Windows filesystem, where every one of those weight reads would cross a 9p share. To place the project somewhere of your own choosing instead, set ${stack.envVar} and click this again.`;
}

/**
 * Settle where one stack's project goes before anything is written to it.
 *
 * Detection runs ONLY when nothing already answers the question — an exported
 * env var or an earlier recording both win, and neither costs a subprocess. Off
 * Windows there is nothing to detect: the default home is already on a Linux
 * filesystem.
 *
 * @param {object} stack
 * @param {string} stack.envVar - the operator override / record key, e.g. `VLLM_QWEN_PROJECT_DIR`
 * @param {string} stack.leaf - the directory name inside the distro's home
 * @param {string} stack.sizeHint - the payload named in the progress line, e.g. `~20 GB`
 * @param {string} stack.afterInstall - completes "Install a distro with …, then ___."
 * @param {() => boolean} stack.isSettled - does anything already answer this?
 * @param {(dir: string) => Promise<unknown>} stack.record - persist the answer
 * @param {(line: string) => void} [stack.emit]
 * @returns {Promise<string|null>} the refusal, or `null` once the directory is
 *   settled — the same shape as each stack's `*StartBlockedReason`, and read
 *   back the same way, through that stack's own inspection.
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
  // This process FIRST, the file second. Every stack's resolver reads the env
  // ahead of the record, so every later read in this run — the re-inspection
  // that follows, the readiness poll, the Start button — resolves the detected
  // directory even when the write fails. Without it, a failed write silently
  // sends the very next inspection back to `%USERPROFILE%\<leaf>`: the C:\
  // placement this whole path exists to refuse.
  process.env[envVar] = found.dir;
  // Recording is only what makes the choice outlive this run, so a failed write
  // costs exactly that — not a multi-tens-of-gigabytes provision.
  const recordedOk = await record(found.dir).then(() => true, (err) => {
    emit(`Could not record ${envVar} in PortOS's .env (${err.message}) — this run still uses that directory, but set it there yourself or the next restart will look on the Windows filesystem again.`);
    return false;
  });
  if (recordedOk) emit(`Recorded ${envVar} in PortOS's .env, so the readiness check and the Start button find it too.`);
  return null;
}
