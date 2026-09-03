/**
 * The one thing PortOS does TO the SGLang Qwen3.8-27B project: find out where
 * it is on a Windows host.
 *
 * There is no provisioning counterpart to `services/vllmQwenManager.js` here, on
 * purpose. SGLang publishes an image and no compose project, so PortOS owns the
 * launch line (`lib/sglangQwenRecipe.js`) but nothing to clone — the operator
 * prepares the directory once from `docs/features/sglang-qwen38.md`, and the
 * checklist's Start button only ever brings up what is already there.
 *
 * That is exactly why the Windows placement question bit harder on this stack
 * than on vLLM's. `%USERPROFILE%\sglang-qwen38` is a *Windows* home; the project
 * and its ~20 GB of weights are inside a WSL2 distro, because Docker Desktop's
 * engine IS a WSL2 VM. A native-Win32 PortOS could read neither, so the start
 * refused and handed the operator a `\\wsl.localhost\<distro>\home\<user>\…`
 * template with two values to look up. Since there is no 1-click path to fall
 * back on, EVERY Windows operator hit it.
 *
 * `ensureSglangProjectDir` is the same settle → detect → record loop the vLLM
 * stack uses — literally the same one (`services/wslProjectPlacement.js`) — with
 * this stack's env-var name, directory leaf, and refusal wording. Detect and
 * record only: nothing is created, so a host WSL cannot answer for is still
 * pointed at the feature doc.
 */

import {
  recordSglangProjectDir,
  sglangProjectDirIsSettled,
  SGLANG_PROJECT_DIR_ENV,
  SGLANG_PROJECT_LEAF,
} from '../lib/sglangQwenProject.js';
import { ensureWslProjectDir } from './wslProjectPlacement.js';

/**
 * What the shared placement loop needs to speak for this stack.
 *
 * `afterInstall` is the one sentence that cannot be shared with vLLM: there the
 * next click provisions the project into the new distro, here there is nothing
 * to provision, so it names the doc the operator prepares it from instead.
 */
const SGLANG_PLACEMENT = Object.freeze({
  envVar: SGLANG_PROJECT_DIR_ENV,
  leaf: SGLANG_PROJECT_LEAF,
  sizeHint: '~20 GB',
  afterInstall: 'prepare the project inside it as docs/features/sglang-qwen38.md describes — PortOS finds it there by itself, and never downloads the image or the weights for you',
});

/**
 * Settle where this project lives before the start row inspects it.
 *
 * @param {{emit?: (line: string) => void}} [ctx]
 * @returns {Promise<string|null>} the refusal, or `null` once the directory is
 *   settled — the same shape as `sglangStartBlockedReason`, and read back the
 *   same way, through `inspectSglangQwenProject()`.
 */
export async function ensureSglangProjectDir({ emit } = {}) {
  return ensureWslProjectDir({
    ...SGLANG_PLACEMENT,
    emit,
    isSettled: () => sglangProjectDirIsSettled(),
    record: (dir) => recordSglangProjectDir(dir),
  });
}
