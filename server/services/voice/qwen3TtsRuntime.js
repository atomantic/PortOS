/**
 * Qwen3-TTS Isolated Python Runtime Management (#5381).
 *
 * Single source of truth for Qwen3-TTS runtime location, model paths,
 * hardware/readiness probes, and explicit model acquisition.
 *
 * Never runs unprompted model downloads or batch generations at server boot.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { safeChildProcessOptions, whichFirst } from '../../lib/processEnv.js';

export const QWEN3_TTS_REPO_DIR = join(homedir(), '.portos', 'qwen3-tts');
export const QWEN3_TTS_MODELS_DIR = join(homedir(), '.portos', 'voice', 'models', 'qwen3-tts');
export const QWEN3_TTS_VENV_PYTHON = process.platform === 'win32'
  ? join(QWEN3_TTS_REPO_DIR, '.venv', 'Scripts', 'python.exe')
  : join(QWEN3_TTS_REPO_DIR, '.venv', 'bin', 'python3');
export const QWEN3_TTS_RUNNER_SCRIPT = join(PATHS.root, 'scripts', 'qwen3_tts_runner.py');

export const SUPPORTED_QWEN3_MODELS = Object.freeze([
  {
    id: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    label: 'Qwen3-TTS 1.7B Voice Design',
    description: 'Instruction-controlled natural voice design, synthesis, and streaming',
    sizeGb: 3.5,
    defaultFor: 'voiceDesign',
  },
  {
    id: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    label: 'Qwen3-TTS 1.7B Base',
    description: 'Consented rapid voice cloning, full fidelity synthesis, and fine-tuning',
    sizeGb: 3.5,
    defaultFor: 'instantClone',
  },
  {
    id: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
    label: 'Qwen3-TTS 0.6B Base',
    description: 'Lightweight low-latency model optimized for interactive routes',
    sizeGb: 1.2,
    defaultFor: 'interactive',
  },
]);

export const DEFAULT_DESIGN_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
export const DEFAULT_CLONE_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
export const DEFAULT_INTERACTIVE_MODEL = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';

/**
 * Resolve an executable Python binary: uses isolated venv if present, otherwise
 * falls back to system Python if it can run the runner script.
 */
export async function resolveQwen3Python() {
  if (existsSync(QWEN3_TTS_VENV_PYTHON)) {
    return QWEN3_TTS_VENV_PYTHON;
  }
  const sysPython = await whichFirst('python3', 'python');
  return sysPython || null;
}

/**
 * Check if the isolated runtime venv or compatible Python interpreter is installed.
 */
export async function isQwen3RuntimeInstalled() {
  const status = await getQwen3RuntimeStatus();
  return status.ok;
}

/**
 * Probe runtime health, hardware capabilities, and downloaded model checkpoints.
 */
export async function getQwen3RuntimeStatus() {
  const python = await resolveQwen3Python();
  const venvPresent = existsSync(QWEN3_TTS_VENV_PYTHON);

  if (!python) {
    return {
      ok: false,
      installed: false,
      venvPresent: false,
      pythonPath: null,
      hardware: { device: 'cpu', cuda: false, mps: false, vramGb: null },
      models: {},
      supportedModels: SUPPORTED_QWEN3_MODELS,
      message: 'Python environment not found for Qwen3-TTS runtime',
    };
  }

  try {
    const probeArgs = [QWEN3_TTS_RUNNER_SCRIPT, '--probe', '--models-dir', QWEN3_TTS_MODELS_DIR];
    const { stdout } = await runRuntime(python, probeArgs, 120000);
    const data = JSON.parse(stdout.trim());

    const modelsState = {};
    for (const model of SUPPORTED_QWEN3_MODELS) {
      const probeModel = data.models?.[model.id];
      modelsState[model.id] = {
        ...model,
        downloaded: Boolean(probeModel?.downloaded),
        path: probeModel?.path || null,
      };
    }

    return {
      ok: data.ok === true,
      installed: data.ok === true,
      message: data.error || null,
      venvPresent,
      pythonPath: python,
      hardware: {
        device: data.device || 'cpu',
        cuda: Boolean(data.cuda_available),
        mps: Boolean(data.mps_available),
        vramGb: data.vram_gb || null,
        torchInstalled: Boolean(data.torch_installed),
      },
      models: modelsState,
      supportedModels: SUPPORTED_QWEN3_MODELS,
    };
  } catch (err) {
    return {
      ok: false,
      installed: false,
      venvPresent,
      pythonPath: python,
      hardware: { device: 'cpu', cuda: false, mps: false, vramGb: null },
      models: {},
      supportedModels: SUPPORTED_QWEN3_MODELS,
      error: err.message,
    };
  }
}

function runRuntime(pythonPath, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, safeChildProcessOptions({ timeout }));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(-65536); });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-8192); });
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      // Hub progress may precede the runner's final structured error line.
      let failure = null;
      try { failure = JSON.parse(stderr.trim().split(/\r?\n/).at(-1)); } catch { /* Non-JSON process failure. */ }
      if (['QWEN3_DOWNLOAD_UNAVAILABLE', 'QWEN3_DOWNLOAD_FAILED'].includes(failure?.code)) {
        return reject(new ServerError(failure.error || 'Qwen3 model download failed', {
          status: failure.code === 'QWEN3_DOWNLOAD_UNAVAILABLE' ? 503 : 502,
          code: failure.code,
        }));
      }
      reject(new Error(`Qwen3 runtime failed (code ${code}): ${stderr || stdout}`));
    });
    child.on('error', reject);
  });
}

const downloads = new Map();

/**
 * Explicit user-triggered model download. Coalesce overlapping requests for one
 * model; readiness is published by the runner only after checksum verification.
 */
export async function downloadQwen3Model(modelId) {
  const modelSpec = SUPPORTED_QWEN3_MODELS.find((m) => m.id === modelId);
  if (!modelSpec) {
    throw new ServerError(`Unsupported Qwen3-TTS model: ${modelId}`, {
      status: 400,
      code: 'UNKNOWN_QWEN3_MODEL',
    });
  }

  if (downloads.has(modelId)) return downloads.get(modelId);
  const download = (async () => {
    const python = await resolveQwen3Python();
    if (!python) {
      throw new ServerError('Python with huggingface_hub is required to download Qwen3-TTS models', {
        status: 503, code: 'QWEN3_DOWNLOAD_UNAVAILABLE',
      });
    }
    const { stdout } = await runRuntime(python, [
      QWEN3_TTS_RUNNER_SCRIPT, '--download', '--model-id', modelId,
      '--models-dir', QWEN3_TTS_MODELS_DIR,
    ], 30 * 60 * 1000);
    const result = JSON.parse(stdout.trim());
    if (result.ok !== true || result.modelId !== modelId || !/^[a-f0-9]{40}$/.test(result.revision)) {
      throw new ServerError('Qwen3-TTS download did not return a verified snapshot', {
        status: 502, code: 'QWEN3_DOWNLOAD_INVALID_RESULT',
      });
    }
    return result;
  })();
  downloads.set(modelId, download);
  try {
    return await download;
  } finally {
    downloads.delete(modelId);
  }
}
