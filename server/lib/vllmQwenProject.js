/**
 * Where the vLLM Qwen3.8-27B compose project lives, and whether its weights are
 * already on disk.
 *
 * PortOS does not vendor this stack. It is an upstream compose project
 * (`syv-ai/qwen38-27b-rtx3090`) an operator clones and prepares once, on a box
 * with an RTX 3090 and a working NVIDIA container runtime — a ~9.5 GB image plus
 * ~20 GB of weights. The readiness checklist's start button is a convenience for
 * a project that is ALREADY prepared: `docker compose --profile single up -d` in
 * a directory that has never been prepared would kick off exactly the multi-tens-
 * of-gigabytes download PortOS promises never to start on its own.
 *
 * So the button asks first, and this module is the question. It reads directory
 * entries and records where it looked — it never runs docker, contacts a
 * registry, or reads a weight file.
 *
 * **Sentinels matter here.** `hasWeights` is a tri-state: `true` (a Qwen model
 * directory was found), `false` (every candidate root was readable and none held
 * one), `null` (no candidate root could be read at all). The start
 * path treats anything other than `true` as "not verified" and refuses — but the
 * three cases get different copy, because "your cache is empty" and "I cannot see
 * your cache" send the operator to different fixes. The common `null` case is a
 * real deployment shape, not a bug: on Windows the compose project is cloned
 * inside a WSL2 distro, so a native-Win32 PortOS reaches neither it nor its
 * `models/` at the Windows `~/qwen-serving` this module defaults to. Pointing
 * `VLLM_QWEN_PROJECT_DIR` at the UNC path (`\\wsl.localhost\<distro>\home\…`)
 * resolves it — Node reads that path, and `docker compose` accepts it as a
 * working directory. `VLLM_QWEN_WEIGHTS_DIR` covers the rarer case of a cache
 * kept somewhere else entirely; otherwise the operator simply runs compose
 * themselves, which is the documented path anyway.
 *
 * **The operator no longer types that UNC path themselves.** On Windows,
 * `services/vllmQwenManager.js` asks WSL for it (via the shared
 * `services/wslProjectPlacement.js` loop) and records the answer through
 * `recordVllmProjectDir` below, so every later read — the once-a-minute
 * readiness inspection, the Start button, a restarted server — resolves the same
 * directory the provisioning run actually used. The record is one line in
 * PortOS's own `.env`; the mechanics of reading and writing it live in
 * `lib/recordedProjectDir.js`, shared with the SGLang stack, and this module
 * states only which variable names THIS project.
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
// PORTOS_ENV_PATH is declared by portosEnv.js; recordedProjectDir.js imports it
// for its own defaults but does not re-export it — and it cannot, because both
// modules are `export *`'d from lib/index.js and a re-export would collide there.
import { PORTOS_ENV_PATH } from './portosEnv.js';

/** Operator override for where the compose project was cloned. */
export const VLLM_PROJECT_DIR_ENV = 'VLLM_QWEN_PROJECT_DIR';

/** The directory name upstream's README uses, inside whichever home holds it. */
export const VLLM_PROJECT_LEAF = 'qwen-serving';

/**
 * Operator override for the HuggingFace cache holding the weights — the answer
 * for a stack whose cache is a docker named volume PortOS cannot see.
 */
export const VLLM_WEIGHTS_DIR_ENV = 'VLLM_QWEN_WEIGHTS_DIR';

/**
 * The user's home, read from the passed env before falling back to the OS —
 * so every path this module derives is injectable, and a test can never be
 * answered by the developer's real HuggingFace cache.
 */
const resolveHome = (env) =>
  String(env?.HOME || env?.USERPROFILE || '').trim() || homedir();

/** Where the upstream README tells the operator to clone it. */
export const vllmDefaultProjectDir = (env = process.env) => join(resolveHome(env), VLLM_PROJECT_LEAF);

/**
 * This stack's view of the shared `.env` record (`lib/recordedProjectDir.js`),
 * keyed on `VLLM_QWEN_PROJECT_DIR`.
 *
 * Named wrappers rather than call sites passing the key: "which variable names
 * the vLLM project" is one fact, and it is stated here.
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

/**
 * HuggingFace's hub cache names every repo directory `models--<org>--<repo>`.
 * Matching on `qwen` rather than an exact repo id is deliberate: the stack ships
 * a requant whose repo id upstream is free to rename, and a stale exact id would
 * report a perfectly prepared machine as empty.
 */
const QWEN_CACHE_ENTRY = /^models--.*qwen/i;

/**
 * The hub layout is not what upstream's `prepare` service actually produces.
 * `docker/prepare.sh` runs `hf download <repo> --local-dir /app/models/<model>`,
 * and compose bind-mounts `${MODELS_DIR:-./models}` there — so a prepared 3090
 * holds a plainly-named `models/Qwen3.8-27B-W4A16-AutoRound/` (plus `-fast` and
 * the DFlash2 drafter), never a `models--…` directory. Matching only the hub
 * shape reported every correctly-prepared machine as "no weights cached yet"
 * and refused to start a container that was ready to run.
 */
const QWEN_LOCAL_ENTRY = /qwen/i;

/**
 * What makes a `qwen`-named directory *weights* rather than a notes folder that
 * happens to share the name. These are the same files upstream's own readiness
 * check keys on: a sharded download writes the index, a single-file one (the
 * DFlash2 drafter) writes the tensor file itself.
 */
const LOCAL_WEIGHT_MARKERS = ['model.safetensors.index.json', 'model.safetensors'];

const isDirectory = (path) => stat(path).then((s) => s.isDirectory(), () => false);
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

/**
 * The configured project directory, what PortOS recorded, or upstream's
 * documented default — in that order.
 *
 * The process environment outranks the recorded value deliberately: an operator
 * who exports this variable (in their shell, or in `ecosystem.config.cjs`) is
 * making a decision for this run, and a directory PortOS auto-detected on some
 * earlier run must not quietly outlive it.
 */
export function resolveVllmProjectDir(env = process.env, envPath = PORTOS_ENV_PATH) {
  return resolveRecordedProjectDir(VLLM_PROJECT_DIR_ENV, () => vllmDefaultProjectDir(env), env, envPath);
}

/**
 * Whether anything already answers "where does this project live", so a caller
 * knows whether detecting it is still worth a subprocess.
 *
 * Exported so `services/vllmQwenManager.js` asks THIS module rather than
 * re-listing the two sources above — a precedence change made in one place and
 * not the other is invisible on any non-Windows machine.
 */
export function vllmProjectDirIsSettled(env = process.env, envPath = PORTOS_ENV_PATH) {
  return projectDirIsSettled(VLLM_PROJECT_DIR_ENV, env, envPath);
}

/**
 * Candidate HuggingFace hub caches, most specific first: the operator's explicit
 * override, then the caches the compose project may bind-mount from its own
 * directory, then the user-level default `HF_HOME`/`~/.cache/huggingface`.
 */
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
 * Whether one cache root holds Qwen weights, in either layout: a HuggingFace hub
 * entry, or the `--local-dir` model directory upstream's prepare step writes.
 *
 * @param {string} root
 * @param {string[]} entries
 * @returns {Promise<boolean>}
 */
async function rootHoldsQwenWeights(root, entries) {
  if (entries.some((name) => QWEN_CACHE_ENTRY.test(name))) return true;
  for (const name of entries.filter((entry) => QWEN_LOCAL_ENTRY.test(entry))) {
    for (const marker of LOCAL_WEIGHT_MARKERS) {
      // eslint-disable-next-line no-await-in-loop -- two stats on a short, ordered candidate list
      if (await isFile(join(root, name, marker))) return true;
    }
  }
  return false;
}

/**
 * Inspect the operator's vLLM project without touching docker.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath] - which `.env` holds the recorded directory; a
 *   parameter for the same reason `resolveHome` reads the passed env — every
 *   path this module derives has to be answerable by a test's sandbox rather
 *   than by whatever the developer's own install happens to have recorded.
 * @returns {Promise<{dir:string, hasProject:boolean, composeFile:string|null,
 *   hasWeights:boolean|null, weightsRoot:string|null}>}
 */
export async function inspectVllmQwenProject(env = process.env, envPath = PORTOS_ENV_PATH) {
  const dir = resolveVllmProjectDir(env, envPath);
  const hasProject = await isDirectory(dir);

  let composeFile = null;
  if (hasProject) {
    for (const name of COMPOSE_FILENAMES) {
      // eslint-disable-next-line no-await-in-loop -- four stats on one directory
      if (await isFile(join(dir, name))) { composeFile = name; break; }
    }
  }

  let readAnyRoot = false;
  let weightsRoot = null;
  for (const root of weightsCandidateRoots(dir, env)) {
    // eslint-disable-next-line no-await-in-loop -- short, ordered, first-match-wins
    const entries = await readdir(root).catch(() => null);
    if (entries === null) continue; // absent or unreadable — says nothing either way
    readAnyRoot = true;
    // eslint-disable-next-line no-await-in-loop -- short, ordered, first-match-wins
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

/**
 * Why the start button must not run compose, or `null` when it may. Prose, not a
 * code — the checklist renders it verbatim, and each case names the one command
 * that fixes it.
 *
 * @param {{dir:string, hasProject:boolean, composeFile:string|null, hasWeights:boolean|null}} project
 * @returns {string|null}
 */
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
 * The same inspection, reduced to the four-state vocabulary the readiness
 * checklist speaks (`services/localRuntimeSetup.js`'s `readRuntimeWeights`).
 *
 * `'empty'` is what makes the checklist offer the provisioning action, so it
 * must mean "provisioning is exactly the fix" and nothing looser:
 *
 *   - **no project directory at all** — the ordinary first-run shape. Nothing
 *     to clone over, so the clone/build/prepare sequence is precisely right.
 *   - **a project whose caches read empty** — cloned, never prepared.
 *
 * Everything else is `'unknown'`, never `'empty'`. A directory that exists but
 * holds no compose file is one PortOS does not recognize, and cloning into it
 * would either fail or scatter a checkout across the operator's files; a cache
 * that could not be READ (the normal Windows shape before
 * `VLLM_QWEN_PROJECT_DIR` points at the UNC path) is not a cache that is empty,
 * and treating it as one would offer to re-download ~20 GB that is already
 * there. Both keep today's behavior: the Start button appears and refuses with
 * the reason, which is the message that actually helps.
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
