/**
 * Where the vLLM Qwen3.8-27B compose project lives, and whether its weights are already on disk.
 *
 * Start requires a complete checkpoint for the single-user configuration. Inspect the
 * model metadata and tensor headers on disk without invoking Docker or the network.
 * `hasWeights` is true for verified weights, false for an incomplete checkpoint in
 * a readable cache, and null when the location or its contents cannot be inspected.
 *
 * On Windows `services/vllmQwenManager.js` asks WSL for that path (via `services/wslProjectPlacement.js`) and records it through `recordVllmProjectDir`, one line in PortOS's own `.env`
 * (mechanics in `lib/recordedProjectDir.js`, shared with SGLang); this module states only which variable names THIS project.
 */

import { constants } from 'fs';
import { access, readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { parseEnv } from 'util';

import { isSafeHfRepoRelativePath, repoToDirName, verifySafetensorsStructure } from './hfCache.js';
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

// Match the pinned upstream single-user launcher and prepare script.
const BASE_MODEL = 'Qwen3.8-27B-W4A16-AutoRound';
const FAST_MODEL = `${BASE_MODEL}-fast`;
const DRAFTERS = ['Qwen3.8-27B-DFlash2-W4A16', 'Qwen3.8-27B-DFlash2'];
const INDEX = 'model.safetensors.index.json';
const SINGLE_WEIGHT = 'model.safetensors';
const HUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const LOCAL_MODEL_PREFIX = /^(?:\/app\/|\.\/)?models\//;
const isHubModel = (model) => HUB_REPO.test(model) && !LOCAL_MODEL_PREFIX.test(model);

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

async function ifMissing(operation, fallback) {
  try {
    return await operation();
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

const readText = (path) => ifMissing(() => readFile(path, 'utf8'), null);
const fileStat = (path) => ifMissing(() => stat(path), null);

async function readableFile(path) {
  const info = await fileStat(path);
  if (!info?.isFile() || info.size === 0) return null;
  await access(path, constants.R_OK);
  return info;
}

async function completeTensor(path) {
  const info = await readableFile(path);
  if (!info) return false;
  const result = await verifySafetensorsStructure(path, info.size);
  if (result.reason === 'unreadable') throw new Error('Cannot open model weights');
  return result.ok;
}

async function completeCheckpoint(dir, { preparedBase = false, fast = false, drafter = false } = {}) {
  const metadata = drafter ? ['config.json'] : ['config.json', 'tokenizer.json', 'tokenizer_config.json'];
  if (fast) metadata.push('mtp_draft_vocab_ids.pt');
  for (const name of metadata) {
    if (!await readableFile(join(dir, name))) return false;
  }

  const indexPath = join(dir, INDEX);
  const indexInfo = await fileStat(indexPath);
  if (!indexInfo) return !preparedBase && !fast && completeTensor(join(dir, SINGLE_WEIGHT));
  if (!indexInfo.isFile()) return false;

  let index;
  try {
    index = JSON.parse(await readText(indexPath))?.weight_map;
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
  if (!index || typeof index !== 'object' || Array.isArray(index)) return false;
  const tensors = Object.keys(index);
  if (!tensors.length) return false;
  const shards = new Set(Object.values(index));
  for (const shard of shards) {
    if (!isSafeHfRepoRelativePath(shard) || !shard.endsWith('.safetensors')
      || !await completeTensor(join(dir, shard))) return false;
  }

  // Raw upstream shards can be intact while prepare's requantization is unfinished.
  return !preparedBase || (
    Object.hasOwn(index, 'lm_head.weight_packed')
    && tensors.some((name) => name.endsWith('embed_tokens.weight_packed'))
    && Object.hasOwn(index, 'mtp.layers.0.mlp.down_proj.weight_packed')
    && Object.hasOwn(index, 'mtp.draft_lm_head.weight_packed')
    && Boolean(await readableFile(join(dir, 'mtp_draft_vocab_ids.pt')))
  );
}

async function checkpointPath(model, modelsRoot, hubRoot) {
  const local = model.replace(LOCAL_MODEL_PREFIX, '');
  if (local !== model && isSafeHfRepoRelativePath(local)) return join(modelsRoot, local);
  if (!isHubModel(model) || !isSafeHfRepoRelativePath(model)) return null;

  // A serving repo ID selects its current Hub ref. Snapshots can coexist, but a
  // complete older revision cannot stand in for a partial selected revision.
  const repo = join(hubRoot, repoToDirName(model));
  const ref = (await readText(join(repo, 'refs', 'main')))?.trim() || '';
  return /^[a-f0-9]{40}$/i.test(ref) ? join(repo, 'snapshots', ref) : null;
}

async function inspectWeights(dir, env) {
  const settings = parseEnv(await readText(join(dir, '.env')) ?? '');
  const override = env[VLLM_WEIGHTS_DIR_ENV]?.trim();
  const modelsRoot = resolve(dir, override || env.MODELS_DIR || settings.MODELS_DIR || 'models');
  const hfHome = env.HF_HOME || settings.HF_HOME;
  const hubRoot = resolve(dir, override || env.HF_HUB_CACHE || settings.HF_HUB_CACHE
    || (hfHome ? join(hfHome, 'hub') : join(resolveHome(env), '.cache', 'huggingface', 'hub')));
  const configuredModel = settings.MODEL || '';
  const configuredDraft = settings.DRAFT || '';
  // Compose resolves interpolated .env values itself. A literal guess could
  // verify a different directory from the one selected in the container.
  if ([modelsRoot, hubRoot, configuredModel, configuredDraft, settings.SPEC].some((value) => value?.includes('$'))) {
    return { hasWeights: null, weightsRoot: null };
  }

  const usesHub = isHubModel(configuredModel);
  if ((usesHub || (settings.SPEC === 'dflash2' && isHubModel(configuredDraft)))
    && settings.HF_HUB_OFFLINE !== '1') {
    return { hasWeights: null, weightsRoot: null };
  }
  if (usesHub && settings.VERIFY !== '0') return { hasWeights: null, weightsRoot: null };
  const root = usesHub ? hubRoot : modelsRoot;
  await readdir(root);
  const fast = !configuredModel && (await fileStat(join(modelsRoot, FAST_MODEL)))?.isDirectory();
  const model = configuredModel || `/app/models/${fast ? FAST_MODEL : BASE_MODEL}`;
  const checkpoint = await checkpointPath(model, modelsRoot, hubRoot);
  const preparedBase = checkpoint === join(modelsRoot, BASE_MODEL);
  const usesFast = checkpoint === join(modelsRoot, FAST_MODEL);
  let complete = Boolean(checkpoint && await completeCheckpoint(checkpoint, { preparedBase, fast: usesFast }));
  const fastWeightsIncomplete = usesFast && !complete;
  // The container entrypoint verifies the default base before launch, even
  // when the single-user launcher will then choose the fast variant.
  if (complete && fast && settings.VERIFY !== '0') {
    complete = await completeCheckpoint(join(modelsRoot, BASE_MODEL), { preparedBase: true });
  }
  if (complete && settings.SPEC === 'dflash2') {
    let draft = configuredDraft;
    if (!draft) {
      for (const name of DRAFTERS) {
        if ((await fileStat(join(modelsRoot, name, SINGLE_WEIGHT)))?.isFile()) {
          draft = `/app/models/${name}`;
          break;
        }
      }
    }
    const draftPath = await checkpointPath(draft, modelsRoot, hubRoot);
    complete = Boolean(draftPath && await completeCheckpoint(draftPath, { drafter: true }));
  }
  return { hasWeights: complete, weightsRoot: complete ? root : null, fastWeightsIncomplete };
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
 *   hasWeights:boolean|null, weightsRoot:string|null, fastWeightsIncomplete?:boolean}>}
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

  const weights = composeFile
    ? await inspectWeights(dir, env).catch(() => ({ hasWeights: null, weightsRoot: null }))
    : { hasWeights: null, weightsRoot: null };
  return { dir, hasProject, composeFile, ...weights };
}

/**
 * Why the start button must not run compose, or `null` when it may. Prose rendered verbatim by the checklist; each case names the one command that fixes it.
 *
 * @param {{dir:string, hasProject:boolean, composeFile:string|null, hasWeights:boolean|null}} project
 */
export function vllmStartBlockedReason(project) {
  if (!project?.hasProject) {
    return `the compose project was not found at ${project?.dir}. Use the checklist's “Clone, build & prepare” button — it does the whole ~30 GB sequence for you, and a plain Start never downloads an image or a weight.`;
  }
  if (!project.composeFile) {
    return `${project.dir} exists but holds no docker-compose file. Point ${VLLM_PROJECT_DIR_ENV} at the cloned syv-ai/qwen38-27b-rtx3090 checkout.`;
  }
  if (project.hasWeights === false) {
    return `the project is cloned but the selected Qwen weights are missing or incomplete. Use the checklist's “Clone, build & prepare” button, which runs that step and names the ~20 GB before it starts — a plain Start will not spend it for you.`;
  }
  if (project.hasWeights !== true) {
    return `PortOS cannot read a models directory for this project or verify the selected model there. On Windows it places the project inside WSL2 and records the UNC path for itself — if that record is stale, or the weights live somewhere else entirely, set ${VLLM_PROJECT_DIR_ENV} or ${VLLM_WEIGHTS_DIR_ENV} to where they actually are. Failing that, start it yourself with \`docker compose --profile single up -d --no-deps --no-build --pull never single\` in ${project.dir}.`;
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
