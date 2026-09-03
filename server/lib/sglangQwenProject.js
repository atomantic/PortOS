/**
 * Where the SGLang Qwen3.8-27B compose project lives, and whether its weights
 * are already on disk.
 *
 * The sibling of `lib/vllmQwenProject.js`, for the same reason and with the same
 * hard rule: **a readiness check only reads directory entries.** It never runs
 * docker, contacts a registry, or reads a weight file. `docker compose up -d` in
 * an unprepared directory would pull a multi-gigabyte image and then ~20 GB of
 * weights — exactly the download PortOS promises never to start on its own.
 *
 * One thing differs from the vLLM path. There, the compose project is upstream's
 * (`syv-ai/qwen38-27b-rtx3090`) and the operator clones it. SGLang publishes an
 * official image and no compose project, so the launch line is PortOS's own:
 * `lib/sglangQwenRecipe.js` generates the `docker-compose.yml`, and
 * `docs/features/sglang-qwen38.md` carries it verbatim for the operator to save
 * into this directory. The refusals below therefore point at that doc rather
 * than at a `git clone`.
 *
 * **Sentinels matter here.** `hasWeights` is tri-state: `true` (a Qwen model
 * directory was found), `false` (every candidate root was readable and none held
 * one), `null` (no candidate root could be read at all). The start path treats
 * anything other than `true` as "not verified" and refuses — but the three cases
 * get different copy, because "your cache is empty" and "I cannot see your
 * cache" send the operator to different fixes. `null` is a real deployment
 * shape, not a bug: a cache kept in a docker named volume is invisible to a
 * PortOS running outside the container, and on Windows the project usually lives
 * inside a WSL2 distro. `SGLANG_QWEN_WEIGHTS_DIR` answers the first.
 *
 * **The operator no longer types the Windows UNC path themselves.** The second
 * case used to be theirs to fix: the default `%USERPROFILE%\sglang-qwen38`
 * resolves to a *Windows* home, the project is inside a WSL2 distro, and the
 * refusal handed them a `\\wsl.localhost\<distro>\home\<user>\…` template with
 * two values to look up. It bit every Windows operator, because SGLang ships no
 * provisioner and preparing it by hand inside the distro is the only path. Now
 * `services/sglangQwenManager.js` asks WSL for those two values (the shared
 * `services/wslProjectPlacement.js` loop) and records the answer through
 * `recordSglangProjectDir` below, so the readiness poll, the Start button and
 * the next boot all resolve the directory that run found.
 *
 * SGLang gets detect + record only, never placement: there is no provisioner to
 * clone into the directory, so a host WSL cannot answer for still gets a refusal
 * pointing at `docs/features/sglang-qwen38.md`.
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

/** Operator override for where the compose project was created. */
export const SGLANG_PROJECT_DIR_ENV = 'SGLANG_QWEN_PROJECT_DIR';

/** Operator override for the HuggingFace cache holding the weights. */
export const SGLANG_WEIGHTS_DIR_ENV = 'SGLANG_QWEN_WEIGHTS_DIR';

/**
 * The user's home, read from the passed env before falling back to the OS — so
 * every path this module derives is injectable, and a test can never be answered
 * by the developer's real HuggingFace cache.
 */
const resolveHome = (env) =>
  String(env?.HOME || env?.USERPROFILE || '').trim() || homedir();

/** The directory name the feature doc uses, inside whichever home holds it. */
export const SGLANG_PROJECT_LEAF = 'sglang-qwen38';

/** Where `docs/features/sglang-qwen38.md` tells the operator to create it. */
export const sglangDefaultProjectDir = (env = process.env) => join(resolveHome(env), SGLANG_PROJECT_LEAF);

/**
 * This stack's view of the shared `.env` record (`lib/recordedProjectDir.js`),
 * keyed on `SGLANG_QWEN_PROJECT_DIR`.
 *
 * @param {string} [envPath]
 * @returns {string}
 */
export function readRecordedSglangProjectDir(envPath = PORTOS_ENV_PATH) {
  return readRecordedProjectDir(SGLANG_PROJECT_DIR_ENV, envPath);
}

/**
 * Remember where this project was found, so nothing has to detect it twice.
 *
 * @param {string} dir
 * @param {string} [envPath]
 */
export async function recordSglangProjectDir(dir, envPath = PORTOS_ENV_PATH) {
  return recordProjectDir(SGLANG_PROJECT_DIR_ENV, dir, envPath);
}

/**
 * Whether anything already answers "where does this project live", so the
 * manager knows whether a WSL probe is still worth a subprocess. Exported so it
 * asks THIS module rather than re-listing the precedence `resolveSglangProjectDir`
 * already owns.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath]
 * @returns {boolean}
 */
export function sglangProjectDirIsSettled(env = process.env, envPath = PORTOS_ENV_PATH) {
  return projectDirIsSettled(SGLANG_PROJECT_DIR_ENV, env, envPath);
}

/** Compose file names docker itself accepts, in its own precedence order. */
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * HuggingFace's hub cache names every repo directory `models--<org>--<repo>`.
 * Matching on `qwen` rather than an exact repo id is deliberate: the recipe
 * chooses between the FP8 and NVFP4 repos by card class, and an exact id would
 * report a perfectly prepared Blackwell host as empty.
 */
const QWEN_CACHE_ENTRY = /^models--.*qwen/i;

/** The `--local-dir` layout, for an operator who downloaded weights by hand. */
const QWEN_LOCAL_ENTRY = /qwen/i;

/**
 * What makes a `qwen`-named directory *weights* rather than a notes folder that
 * happens to share the name: a sharded download writes the index, a single-file
 * one writes the tensor file itself.
 */
const LOCAL_WEIGHT_MARKERS = ['model.safetensors.index.json', 'model.safetensors'];

const isDirectory = (path) => stat(path).then((s) => s.isDirectory(), () => false);
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

/**
 * The configured project directory, what PortOS recorded, or the documented
 * default — in that order.
 *
 * The process environment outranks the recorded value deliberately: an operator
 * who exports this variable (in their shell, or in `ecosystem.config.cjs`) is
 * making a decision for this run, and a directory PortOS auto-detected on some
 * earlier run must not quietly outlive it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath] - which `.env` holds the record; a parameter for the
 *   same reason `resolveHome` reads the passed env — so a test's sandbox answers
 *   instead of whatever the developer's own install happens to have recorded.
 */
export function resolveSglangProjectDir(env = process.env, envPath = PORTOS_ENV_PATH) {
  return resolveRecordedProjectDir(SGLANG_PROJECT_DIR_ENV, () => sglangDefaultProjectDir(env), env, envPath);
}

/**
 * Candidate HuggingFace caches, most specific first: the operator's explicit
 * override, then the caches the compose file may bind-mount from the project
 * directory (the generated one uses `./hf-cache`), then `HF_HOME` and the
 * user-level default.
 */
function weightsCandidateRoots(projectDir, env = process.env) {
  const override = String(env?.[SGLANG_WEIGHTS_DIR_ENV] || '').trim();
  const hfHome = String(env?.HF_HOME || '').trim();
  return [
    ...(override ? [override] : []),
    join(projectDir, 'hf-cache', 'hub'),
    join(projectDir, 'hf-cache'),
    join(projectDir, 'models'),
    ...(hfHome ? [join(hfHome, 'hub')] : []),
    join(resolveHome(env), '.cache', 'huggingface', 'hub'),
  ];
}

/**
 * Whether one cache root holds Qwen weights, in either layout: a HuggingFace hub
 * entry, or a plainly-named `--local-dir` model directory.
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
 * Inspect the operator's SGLang project without touching docker.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath] - which `.env` holds the recorded directory
 * @returns {Promise<{dir:string, hasProject:boolean, composeFile:string|null,
 *   hasWeights:boolean|null, weightsRoot:string|null}>}
 */
export async function inspectSglangQwenProject(env = process.env, envPath = PORTOS_ENV_PATH) {
  const dir = resolveSglangProjectDir(env, envPath);
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
 * code — the checklist renders it verbatim, and each case names the one thing
 * that fixes it.
 *
 * @param {{dir:string, hasProject:boolean, composeFile:string|null, hasWeights:boolean|null}} project
 * @returns {string|null}
 */
export function sglangStartBlockedReason(project) {
  if (!project?.hasProject) {
    return `no SGLang project directory was found at ${project?.dir}. Create it (or set ${SGLANG_PROJECT_DIR_ENV}), save the docker-compose.yml from docs/features/sglang-qwen38.md into it, and pull the weights once — PortOS never downloads the image or the ~20 GB of weights.`;
  }
  if (!project.composeFile) {
    return `${project.dir} exists but holds no docker-compose file. Save the one from docs/features/sglang-qwen38.md there — it carries the verified launch line, including the tool-call and reasoning parsers an agent cannot work without.`;
  }
  if (project.hasWeights === false) {
    return 'the compose file is in place but no Qwen weights are cached yet. Download them in a terminal first — starting compose now would pull roughly 20 GB, which PortOS will not do for you.';
  }
  if (project.hasWeights === null) {
    return `PortOS cannot read a HuggingFace cache for this project, so it cannot confirm the weights are already downloaded. On Windows it asks WSL where the project lives and records the UNC path for itself — if that record is stale, or the weights live somewhere else entirely (a docker named volume is invisible from here), set ${SGLANG_PROJECT_DIR_ENV} or ${SGLANG_WEIGHTS_DIR_ENV} to where they actually are. Failing that, start it yourself with \`docker compose up -d\` in ${project.dir}.`;
  }
  return null;
}
