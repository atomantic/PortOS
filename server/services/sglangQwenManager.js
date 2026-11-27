/**
 * Finds where the SGLang Qwen3.8-27B project lives on a Windows host (WSL2 distro).
 * No provisioning counterpart to `services/vllmQwenManager.js`: the operator prepares
 * the directory from `docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell`. `ensureSglangProjectDir` is the
 * shared settle → detect → record loop (`services/wslProjectPlacement.js`) with this
 * stack's env var, leaf and wording; nothing is created.
 */
import {
  recordSglangProjectDir,
  sglangProjectDirIsSettled,
  SGLANG_PROJECT_DIR_ENV,
  SGLANG_PROJECT_LEAF,
} from '../lib/sglangQwenProject.js';
import { ensureWslProjectDir } from './wslProjectPlacement.js';

/**
 * What the shared placement loop needs for this stack. `afterInstall` differs from
 * vLLM: nothing is provisioned here, so it names the doc the operator prepares from.
 */
const SGLANG_PLACEMENT = Object.freeze({
  envVar: SGLANG_PROJECT_DIR_ENV,
  leaf: SGLANG_PROJECT_LEAF,
  sizeHint: '~20 GB',
  afterInstall: 'prepare the project inside it as docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell describes — PortOS finds it there by itself, and never downloads the image or the weights for you',
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
