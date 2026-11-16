/**
 * Where the vLLM Qwen3.8-27B compose project lives, and whether its weights are already on disk.
 *
 * PortOS does not vendor this stack: it is an upstream compose project (`syv-ai/qwen38-27b-rtx3090`) an operator clones and prepares once (~9.5 GB image, ~20 GB weights).
 * The readiness checklist's start button is only for an ALREADY prepared project: `docker compose up` in an unprepared directory would start the multi-GB download PortOS promises never to start
 * on its own. This module reads directory entries and records where it looked; it never runs docker, contacts a registry, or reads a weight file.
 *
 * `hasWeights` is a tri-state: `true` (a Qwen model dir was found), `false` (every candidate root was readable and none held one), `null` (no candidate root could be read).
 * Start treats anything but `true` as "not verified" and refuses, with different copy per case ("cache is empty" vs "cannot see your cache"). `null` is a real deployment shape: on Windows the
 * project is cloned inside a WSL2 distro, unreachable at the default `~/qwen-serving`; `VLLM_QWEN_PROJECT_DIR` (UNC path) fixes it and `VLLM_QWEN_WEIGHTS_DIR` covers a cache elsewhere.
 *
 * On Windows `services/vllmQwenManager.js` asks WSL for that path (via `services/wslProjectPlacement.js`) and records it through `recordVllmProjectDir`, one line in PortOS's own `.env`
 * (mechanics in `lib/recordedProjectDir.js`, shared with SGLang); this module states only which variable names THIS project.
 */

import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import {
  projectDirIsSettled,
  readRecordedProjectDir,
  recordProjectDir,
  resolveRecordedProjectDir,
} from './recordedProjectDir.js';
// PORTOS_ENV_PATH is declared by portosEnv.js; recordedProjectDir.js imports but does not re-export it.
import { PORTOS_ENV_PATH } from './portosEnv.js';

/** Operator override for where the compose project was cloned. */
export const VLLM_PROJECT_DIR_ENV = 'VLLM_QWEN_PROJECT_DIR';

/** The directory name upstream's README uses, inside whichever home holds it. */
export const VLLM_PROJECT_LEAF = 'qwen-serving';

/** Operator override for the HuggingFace cache holding the weights (e.g. a docker named volume PortOS cannot see). */
export const VLLM_WEIGHTS_DIR_ENV = 'VLLM_QWEN_WEIGHTS_DIR';

/** The user's home, read from the passed env before the OS, so every derived path is injectable and a test is never answered by the developer's real HF cache. */
const resolveHome = (env) =>
  String(env?.HOME || env?.USERPROFILE || '').trim() || homedir();

/** Where the upstream README tells the operator to clone it. */
export const vllmDefaultProjectDir = (env = process.env) => join(resolveHome(env), VLLM_PROJECT_LEAF);

/**
 * This stack's view of the shared `.env` record (`lib/recordedProjectDir.js`), keyed on `VLLM_QWEN_PROJECT_DIR`.
 *
 * @param {string} [envPath]
 * @returns {string}
 */
export function readRecordedVllmProjectDir(envPath = PORTOS_ENV_PATH) {
  return readRecordedProjectDir(VLLM_PROJECT_DIR_ENV, envPath);
}

/**
 * Remember where this project was placed, so nothing has to detect it twice.
 *
 * @param {string} dir
 * @param {string} [envPath]
 */
export async function recordVllmProjectDir(dir, envPath = PORTOS_ENV_PATH) {
  return recordProjectDir(VLLM_PROJECT_DIR_ENV, dir, envPath);
}

/** Compose file names the upstream project may ship under. */
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** HF hub cache names repo dirs `models--<org>--<repo>`. Matches on `qwen`, not an exact id: upstream may rename the requant repo, and a stale id would report a prepared machine as empty. */
const QWEN_CACHE_ENTRY = /^models--.*qwen/i;

/** Upstream's `prepare` service runs `hf download --local-dir /app/models/<model>` (bind-mounted from `${MODELS_DIR:-./models}`), so a prepared machine holds a plain `models/Qwen3.8-27B-…/` dir, never `models--…`; matching only the hub shape reported it as empty. */
const QWEN_LOCAL_ENTRY = /qwen/i;

/** What makes a `qwen`-named directory *weights* rather than a notes folder; the files upstream's own readiness check keys on (sharded index, or the tensor file itself for a single-file drafter). */
const LOCAL_WEIGHT_MARKERS = ['model.safetensors.index.json', 'model.safetensors'];

const isDirectory = (path) => stat(path).then((s) => s.isDirectory(), () => false);
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

/**
 * The configured project directory, what PortOS recorded, or upstream's default, in that order. The process environment outranks the recorded value: an explicit export is a decision
 * for this run, and an earlier auto-detected directory must not outlive it.
 */
export function resolveVllmProjectDir(env = process.env, envPath = PORTOS_ENV_PATH) {
  return resolveRecordedProjectDir(VLLM_PROJECT_DIR_ENV, () => vllmDefaultProjectDir(env), env, envPath);
}

/** Whether anything already answers "where does this project live", so a caller knows if detecting it is worth a subprocess. `services/vllmQwenManager.js` asks THIS module so precedence lives in one place. */
export function vllmProjectDirIsSettled(env = process.env, envPath = PORTOS_ENV_PATH) {
  return projectDirIsSettled(VLLM_PROJECT_DIR_ENV, env, envPath);
}

/** Candidate HF hub caches, most specific first: operator override, caches the compose project may bind-mount, then `HF_HOME`/`~/.cache/huggingface`. */
function weightsCandidateRoots(projectDir, env = process.env) {
  const override = String(env?.[VLLM_WEIGHTS_DIR_ENV] || '').trim();
  const hfHome = String(env?.HF_HOME || '').trim();
  return [
    ...(override ? [override] : []),
    join(projectDir, 'models'),
    join(projectDir, 'hf-cache'),
    join(projectDir, 'huggingface', 'hub'),
    join(projectDir, '.cache', 'huggingface', 'hub'),
    ...(hfHome ? [join(hfHome, 'hub')] : []),
    join(resolveHome(env), '.cache', 'huggingface', 'hub'),
  ];
}

/**
 * Whether one cache root holds Qwen weights, in either layout (hub entry or upstream's `--local-dir` model directory).
 *
 * @param {string} root
 * @param {string[]} entries
 * @returns {Promise<boolean>}
 */
async function rootHoldsQwenWeights(root, entries) {
  if (entries.some((name) => QWEN_CACHE_ENTRY.test(name))) return true;
  for (const name of entries.filter((entry) => QWEN_LOCAL_ENTRY.test(entry))) {
    for (const marker of LOCAL_WEIGHT_MARKERS) {
      // two stats on a short, ordered candidate list
      if (await isFile(join(root, name, marker))) return true;
    }
  }
  return false;
}

/**
 * Inspect the operator's vLLM project without touching docker.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath] - which `.env` holds the recorded directory (a parameter so a test's sandbox, not the developer's install, answers)
 * @returns {Promise<{dir:string, hasProject:boolean, composeFile:string|null,
 *   hasWeights:boolean|null, weightsRoot:string|null}>}
 */
export async function inspectVllmQwenProject(env = process.env, envPath = PORTOS_ENV_PATH) {
  const dir = resolveVllmProjectDir(env, envPath);
  const hasProject = await isDirectory(dir);

  let composeFile = null;
  if (hasProject) {
    for (const name of COMPOSE_FILENAMES) {
      // four stats on one directory
      if (await isFile(join(dir, name))) { composeFile = name; break; }
    }
  }

  let readAnyRoot = false;
  let weightsRoot = null;
  for (const root of weightsCandidateRoots(dir, env)) {
    // short, ordered, first-match-wins
    const entries = await readdir(root).catch(() => null);
    if (entries === null) continue; // absent or unreadable — says nothing either way
    readAnyRoot = true;
    // short, ordered, first-match-wins
    if (await rootHoldsQwenWeights(root, entries)) { weightsRoot = root; break; }
  }

  return {
    dir,
    hasProject,
    composeFile,
    // `null` = no candidate cache could be read, which is NOT "no weights".
    hasWeights: weightsRoot ? true : (readAnyRoot ? false : null),
    weightsRoot,
  };
}

/** Why the start button must not run compose, or `null` when it may. Prose rendered verbatim by the checklist; each case names the one command that fixes it. */
export function vllmStartBlockedReason(project) {
  if (!project?.hasProject) {
    return `the compose project was not found at ${project?.dir}. Use the checklist's “Clone, build & prepare” button — it does the whole ~30 GB sequence for you, and a plain Start never downloads an image or a weight.`;
  }
  if (!project.composeFile) {
    return `${project.dir} exists but holds no docker-compose file. Point ${VLLM_PROJECT_DIR_ENV} at the cloned syv-ai/qwen38-27b-rtx3090 checkout.`;
  }
  if (project.hasWeights === false) {
    return `the project is cloned but no Qwen weights are cached yet. Use the checklist's “Clone, build & prepare” button, which runs that step and names the ~20 GB before it starts — a plain Start will not spend it for you.`;
  }
  if (project.hasWeights === null) {
    return `PortOS cannot read a models directory for this project, so it cannot confirm the weights are already downloaded. On Windows it places the project inside WSL2 and records the UNC path for itself — if that record is stale, or the weights live somewhere else entirely, set ${VLLM_PROJECT_DIR_ENV} or ${VLLM_WEIGHTS_DIR_ENV} to where they actually are. Failing that, start it yourself with \`docker compose --profile single up -d\` in ${project.dir}.`;
  }
  return null;
}

/**
 * The inspection reduced to the checklist's four-state vocabulary (`services/localRuntimeSetup.js`'s `readRuntimeWeights`).
 *
 * `'empty'` offers the provisioning action, so it must mean exactly "provisioning is the fix": no project directory at all (first run), or a project whose caches read empty (cloned, never prepared).
 * Everything else is `'unknown'`: a directory with no compose file is unrecognized (cloning into it would scatter a checkout), and an UNREADABLE cache is not an empty one
 * (it would offer to re-download ~20 GB already there). Those keep the Start button, which refuses with the helpful reason.
 *
 * @param {{hasProject?:boolean, composeFile?:string|null, hasWeights?:boolean|null}} project
 * @returns {'ready'|'empty'|'unknown'}
 */
export function vllmProjectSetupState(project) {
  if (!project?.hasProject) return 'empty';
  if (!project.composeFile) return 'unknown';
  if (project.hasWeights === true) return 'ready';
  if (project.hasWeights === false) return 'empty';
  return 'unknown';
}
