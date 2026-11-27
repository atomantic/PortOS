/**
 * Where the SGLang Qwen3.8-27B compose project lives, and whether its weights are already on disk.
 *
 * Sibling of `lib/vllmQwenProject.js` with the same hard rule: **a readiness check only reads directory entries**; it never runs docker, contacts a registry, or reads a weight file
 * (`docker compose up -d` in an unprepared directory would start the multi-GB download PortOS promises never to start on its own).
 * Difference: SGLang publishes an official image and no compose project, so the launch line is PortOS's own (`lib/sglangQwenRecipe.js` generates the `docker-compose.yml`; `docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell`
 * carries it verbatim), and refusals point at that doc rather than a `git clone`.
 *
 * `hasWeights` is tri-state: `true` (a Qwen model dir was found), `false` (every candidate root readable, none held one), `null` (no candidate root could be read). Start treats anything but `true` as
 * "not verified" and refuses with different copy per case. `null` is a real deployment shape (a docker named-volume cache is invisible outside the container; on Windows the project usually lives in a WSL2
 * distro). `SGLANG_QWEN_WEIGHTS_DIR` answers the first; for the second `services/sglangQwenManager.js` asks WSL for the values (`services/wslProjectPlacement.js`) and records them via
 * `recordSglangProjectDir`, so the readiness poll, Start button and next boot resolve the same directory (the default `%USERPROFILE%\\sglang-qwen38` is a *Windows* home).
 * SGLang gets detect + record only, never placement (no provisioner), so an unanswerable host still gets a refusal pointing at the doc.
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

/** Operator override for where the compose project was created. */
export const SGLANG_PROJECT_DIR_ENV = 'SGLANG_QWEN_PROJECT_DIR';

/** Operator override for the HuggingFace cache holding the weights. */
export const SGLANG_WEIGHTS_DIR_ENV = 'SGLANG_QWEN_WEIGHTS_DIR';

/** The user's home, read from the passed env before the OS, so every derived path is injectable and a test is never answered by the developer's real HF cache. */
const resolveHome = (env) =>
  String(env?.HOME || env?.USERPROFILE || '').trim() || homedir();

/** The directory name the feature doc uses, inside whichever home holds it. */
export const SGLANG_PROJECT_LEAF = 'sglang-qwen38';

/** Where `docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell` tells the operator to create it. */
export const sglangDefaultProjectDir = (env = process.env) => join(resolveHome(env), SGLANG_PROJECT_LEAF);

/**
 * This stack's view of the shared `.env` record (`lib/recordedProjectDir.js`), keyed on `SGLANG_QWEN_PROJECT_DIR`.
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
 * Whether anything already answers "where does this project live", so the manager knows whether a WSL probe is worth a subprocess; asks THIS module so `resolveSglangProjectDir` owns the precedence.
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

/** HF hub cache names repo dirs `models--<org>--<repo>`. Matches on `qwen`, not an exact id: the recipe picks FP8 vs NVFP4 by card class, and an exact id would report a prepared Blackwell host as empty. */
const QWEN_CACHE_ENTRY = /^models--.*qwen/i;

/** The `--local-dir` layout, for an operator who downloaded weights by hand. */
const QWEN_LOCAL_ENTRY = /qwen/i;

/** What makes a `qwen`-named directory *weights* rather than a notes folder: a sharded download writes the index, a single-file one the tensor file itself. */
const LOCAL_WEIGHT_MARKERS = ['model.safetensors.index.json', 'model.safetensors'];

const isDirectory = (path) => stat(path).then((s) => s.isDirectory(), () => false);
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

/**
 * The configured project directory, what PortOS recorded, or the documented default, in that order. The process environment outranks the recorded value: an explicit export is a decision for this run,
 * and an earlier auto-detected directory must not outlive it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath] - which `.env` holds the record; a parameter for the
 *   same reason `resolveHome` reads the passed env — so a test's sandbox answers
 *   instead of whatever the developer's own install happens to have recorded.
 */
export function resolveSglangProjectDir(env = process.env, envPath = PORTOS_ENV_PATH) {
  return resolveRecordedProjectDir(SGLANG_PROJECT_DIR_ENV, () => sglangDefaultProjectDir(env), env, envPath);
}

/** Candidate HF caches, most specific first: operator override, caches the compose file may bind-mount from the project dir (the generated one uses `./hf-cache`), then `HF_HOME` and the user default. */
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
      // two stats on a short, ordered candidate list
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
    return `no SGLang project directory was found at ${project?.dir}. Create it (or set ${SGLANG_PROJECT_DIR_ENV}), save the docker-compose.yml from docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell into it, and pull the weights once — PortOS never downloads the image or the ~20 GB of weights.`;
  }
  if (!project.composeFile) {
    return `${project.dir} exists but holds no docker-compose file. Save the one from docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell there — it carries the verified launch line, including the tool-call and reasoning parsers an agent cannot work without.`;
  }
  if (project.hasWeights === false) {
    return 'the compose file is in place but no Qwen weights are cached yet. Download them in a terminal first — starting compose now would pull roughly 20 GB, which PortOS will not do for you.';
  }
  if (project.hasWeights === null) {
    return `PortOS cannot read a HuggingFace cache for this project, so it cannot confirm the weights are already downloaded. On Windows it asks WSL where the project lives and records the UNC path for itself — if that record is stale, or the weights live somewhere else entirely (a docker named volume is invisible from here), set ${SGLANG_PROJECT_DIR_ENV} or ${SGLANG_WEIGHTS_DIR_ENV} to where they actually are. Failing that, start it yourself with \`docker compose up -d\` in ${project.dir}.`;
  }
  return null;
}
