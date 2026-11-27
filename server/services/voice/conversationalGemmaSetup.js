/**
 * One-click local llama.cpp + Conversational Gemma 4 31B setup orchestrator.
 *
 * Automates the full Apple Silicon setup directly from the Voice UI:
 *   1. Install `llama.cpp` if `llama-server` is missing on PATH.
 *   2. If `~/.portos/models/Conversational-Gemma-4-31B-Q8_0.gguf` is absent,
 *      verify gated Hugging Face access, prepare an isolated `uv` converter
 *      environment, download the pinned checkpoint with the user's HF token,
 *      and convert it locally to Q8_0 GGUF.
 *   3. Start `llama-server` with the Conversational Gemma preset.
 *   4. Enable the `llama-server` API provider and select Conversational Gemma
 *      as the active Voice Brain LLM.
 */

import { access, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { PATHS } from '../../lib/paths.js';
import { PORTS } from '../../lib/ports.js';
import { artifactDownloadEnv, findCommandOnPath } from '../../lib/processEnv.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { resolveSpecModelPath } from '../../lib/specDecodePresets.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { CONVERSATIONAL_GEMMA } from '../../lib/voiceModelCatalog.js';
import { getHfToken } from '../hfToken.js';
import { emitToOperators } from '../socketIo.js';
import { checkConversationalGemmaAccess } from './conversationalGemmaAccess.js';

const CONVERTER_ROOT = join(PATHS.data, 'cache', 'conversational-gemma-converter');
const CONVERTER_SCRIPT = join(PATHS.root, 'scripts', 'ml', 'convert_conversational_gemma.py');
const LLAMA_CPP_REPO_URL = 'https://github.com/ggml-org/llama.cpp.git';
const CONVERTER_PACKAGES = [
  'huggingface_hub>=0.27.0',
  'torch>=2.5.0',
  'numpy>=1.26.0',
  'sentencepiece>=0.2.0',
  'transformers>=4.51.0',
  'safetensors>=0.4.5',
  'protobuf>=4.25.0',
  'gguf>=0.14.0',
  'mistral-common>=1.5.0',
];

const ACTIVE_PHASES = new Set([
  'checking-access',
  'installing-llama',
  'preparing-converter',
  'downloading',
  'converting',
  'starting',
]);

let job = null;
let state = {
  phase: 'idle',
  detail: '',
  percent: null,
  error: '',
  accessStatus: null,
};

function publish(patch) {
  state = { ...state, ...patch };
  emitToOperators('voice:conversationalGemma:changed');
}

async function readGgufStat() {
  const stats = await stat(resolveSpecModelPath(CONVERSATIONAL_GEMMA.localGgufPath)).catch(() => null);
  return stats?.isFile() && stats.size > 0 ? stats : null;
}

export async function getConversationalGemmaSetupStatus(deps = {}) {
  const resolveBinary = deps.resolveLlamaServerBinary
    || (await import('../llamaServerInstall.js')).resolveLlamaServerBinary;
  const readToken = deps.getHfToken || getHfToken;
  const [llamaBin, gguf, token] = await Promise.all([
    resolveBinary().catch(() => null),
    deps.readGgufStat ? deps.readGgufStat() : readGgufStat(),
    readToken().catch(() => null),
  ]);
  const ggufExists = Boolean(gguf);
  return {
    supported: deps.supported ?? isAppleSilicon(),
    llamaInstalled: Boolean(llamaBin),
    ggufExists,
    ggufSizeBytes: gguf?.size ?? null,
    ggufPath: CONVERSATIONAL_GEMMA.localGgufPath,
    hasHfToken: Boolean(token),
    running: ACTIVE_PHASES.has(state.phase),
    ...state,
  };
}

async function runCmd(cmd, args, { cwd, env, signal, onLine, timeoutMs = 60 * 60_000, errorMessage }) {
  const result = await runStreamingCommand(cmd, args, onLine, {
    signal,
    timeoutMs,
    processGroup: true,
    cwd,
    spawnImpl: (file, argv, options) => spawn(file, argv, { ...options, env: withSpawnCwdEnv(env, cwd) }),
  });
  signal.throwIfAborted();
  if (!result.success) {
    throw new ServerError(errorMessage || `Command failed (${result.code ?? 'signal'}).`, {
      status: 500,
      code: 'CONVERSATIONAL_GEMMA_SETUP_FAILED',
    });
  }
}

async function ensureConverterEnvironment(signal) {
  await mkdir(CONVERTER_ROOT, { recursive: true, mode: 0o700 });
  const env = {
    ...artifactDownloadEnv(),
    UV_CACHE_DIR: join(CONVERTER_ROOT, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(CONVERTER_ROOT, 'python'),
  };
  let uv = findCommandOnPath('uv');
  if (!uv) {
    const { installPinnedAppleUv } = await import('../mkserveRuntimeInstall.js');
    uv = await installPinnedAppleUv(CONVERTER_ROOT, (msg) => publish({ phase: 'preparing-converter', detail: msg }), signal);
  }
  const venvDir = join(CONVERTER_ROOT, 'venv');
  const python = join(venvDir, 'bin', 'python3');
  const hasPython = await access(python).then(() => true, () => false);
  if (!hasPython) {
    publish({ phase: 'preparing-converter', detail: 'Creating isolated Python environment for GGUF conversion…', percent: 5 });
    await runCmd(uv, ['--no-config', 'venv', '--python', '3.12', venvDir], {
      cwd: CONVERTER_ROOT,
      env,
      signal,
      errorMessage: 'Could not create isolated Python environment for GGUF conversion.',
    });
  }
  publish({ phase: 'preparing-converter', detail: 'Installing GGUF conversion dependencies…', percent: 8 });
  await runCmd(uv, ['--no-config', 'pip', 'install', '--python', python, ...CONVERTER_PACKAGES], {
    cwd: CONVERTER_ROOT,
    env,
    signal,
    errorMessage: 'Could not install Python conversion dependencies.',
  });

  const llamaRepo = join(CONVERTER_ROOT, 'llama.cpp');
  const convertScript = join(llamaRepo, 'convert_hf_to_gguf.py');
  const hasConverter = await access(convertScript).then(() => true, () => false);
  if (!hasConverter) {
    publish({ phase: 'preparing-converter', detail: 'Fetching llama.cpp GGUF converter…', percent: 9 });
    await runCmd('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', LLAMA_CPP_REPO_URL, llamaRepo], {
      cwd: CONVERTER_ROOT,
      env,
      signal,
      errorMessage: 'Could not fetch llama.cpp converter repository.',
    });
    await runCmd('git', ['-C', llamaRepo, 'sparse-checkout', 'set', 'convert_hf_to_gguf.py', 'gguf-py'], {
      cwd: CONVERTER_ROOT,
      env,
      signal,
      errorMessage: 'Could not check out llama.cpp converter files.',
    });
  }
  return { python, convertScript, env };
}

async function ensureLlamaProviderAndVoiceConfig(deps = {}) {
  const providersMod = deps.providersMod || await import('../provider/providers.js');
  const voiceConfigMod = deps.voiceConfigMod || await import('./config.js');
  const endpoint = `http://127.0.0.1:${PORTS.LLAMA_SERVER}/v1`;
  const providerId = CONVERSATIONAL_GEMMA.llamaProviderId;
  const existing = await providersMod.getProviderById(providerId).catch(() => null);
  const models = Array.from(new Set([...(existing?.models || []), CONVERSATIONAL_GEMMA.id]));
  if (existing) {
    await providersMod.updateProvider(providerId, {
      enabled: true,
      endpoint: existing.endpoint || endpoint,
      llamaBacked: true,
      models,
      defaultModel: CONVERSATIONAL_GEMMA.id,
    });
  } else {
    await providersMod.createProvider({
      id: providerId,
      name: 'llama.cpp (local)',
      type: 'api',
      endpoint,
      apiKey: '',
      llamaBacked: true,
      models,
      defaultModel: CONVERSATIONAL_GEMMA.id,
      timeout: 300000,
      enabled: true,
      envVars: {},
      secretEnvVars: [],
    });
  }
  await voiceConfigMod.updateVoiceConfig({
    llm: { provider: providerId, model: CONVERSATIONAL_GEMMA.id },
  });
}

async function runSetupPipeline(signal, deps = {}) {
  const llamaInstallMod = deps.llamaInstallMod || await import('../llamaServerInstall.js');
  const llamaLifecycleMod = deps.llamaLifecycleMod || await import('../llamaServerLifecycle.js');

  const llamaBin = await llamaInstallMod.resolveLlamaServerBinary();
  if (!llamaBin) {
    publish({ phase: 'installing-llama', detail: 'Installing llama.cpp…', percent: 2, error: '', accessStatus: null });
    await llamaInstallMod.installLlamaServer();
    signal.throwIfAborted();
  }

  const gguf = await (deps.readGgufStat ? deps.readGgufStat() : readGgufStat());
  if (!gguf) {
    publish({ phase: 'checking-access', detail: 'Checking Hugging Face access to Conversational Gemma 4 31B…', percent: 4, error: '', accessStatus: null });
    const accessCheck = await (deps.checkAccess || checkConversationalGemmaAccess)();
    signal.throwIfAborted();
    if (accessCheck.status !== 'ready') {
      const msg = accessCheck.status === 'token-required'
        ? 'Save a Hugging Face read token with gated-repo access to download Conversational Gemma 4 31B.'
        : 'Accept the Conversational Gemma 4 31B license terms on Hugging Face, then retry setup.';
      publish({ phase: 'failed', detail: msg, error: msg, accessStatus: accessCheck.status, percent: null });
      return;
    }
    publish({ accessStatus: 'ready' });
    const token = await (deps.getHfToken || getHfToken)();
    if (deps.convertModel) {
      await deps.convertModel({ signal, token, onProgress: publish });
    } else {
      const { python, convertScript, env } = await ensureConverterEnvironment(signal);
      const outputPath = resolveSpecModelPath(CONVERSATIONAL_GEMMA.localGgufPath);
      const stagingDir = join(resolveSpecModelPath('~/.portos/models'), '.conversational-gemma-staging');
      await runCmd(python, [
        '-uB',
        CONVERTER_SCRIPT,
        '--repo', CONVERSATIONAL_GEMMA.id,
        '--revision', CONVERSATIONAL_GEMMA.revision,
        '--converter', convertScript,
        '--staging', stagingDir,
        '--output', outputPath,
      ], {
        cwd: CONVERTER_ROOT,
        env: { ...env, HF_TOKEN: token },
        signal,
        timeoutMs: 2 * 60 * 60_000,
        errorMessage: 'Failed to download or convert Conversational Gemma 4 31B to Q8_0 GGUF.',
        onLine: (line) => {
          try {
            const parsed = JSON.parse(line);
            if (parsed?.phase && parsed?.detail) {
              publish({ phase: parsed.phase, detail: parsed.detail, ...(parsed.percent != null ? { percent: parsed.percent } : {}) });
            }
          } catch {
            // Non-JSON diagnostic lines are ignored.
          }
        },
      });
    }
    signal.throwIfAborted();
  }

  publish({ phase: 'starting', detail: 'Starting llama-server with Conversational Gemma 4 31B…', percent: 92 });
  const currentStatus = await llamaLifecycleMod.getLlamaServerStatus().catch(() => null);
  const alreadyServing = currentStatus?.running && currentStatus?.config?.alias === CONVERSATIONAL_GEMMA.id;
  if (!alreadyServing) {
    if (currentStatus?.running && currentStatus?.managed) {
      await llamaLifecycleMod.stopLlamaServer();
      signal.throwIfAborted();
    }
    await llamaLifecycleMod.startLlamaServer({
      model: CONVERSATIONAL_GEMMA.localGgufPath,
      alias: CONVERSATIONAL_GEMMA.id,
      specType: 'none',
      ctxSize: 4096,
      port: PORTS.LLAMA_SERVER,
    });
    signal.throwIfAborted();
  }

  publish({ phase: 'starting', detail: 'Enabling llama.cpp provider and selecting Conversational Gemma for Voice…', percent: 97 });
  await ensureLlamaProviderAndVoiceConfig(deps);
  publish({
    phase: 'ready',
    detail: 'Conversational Gemma 4 31B is running via llama.cpp and active for Voice.',
    percent: 100,
    error: '',
  });
}

export async function startConversationalGemmaSetup(deps = {}) {
  if (!(deps.supported ?? isAppleSilicon())) {
    throw new ServerError('Automated llama.cpp GGUF setup is currently supported on Apple Silicon.', {
      status: 400,
      code: 'CONVERSATIONAL_GEMMA_UNSUPPORTED',
    });
  }
  if (job) {
    throw new ServerError('Conversational Gemma setup is already in progress.', {
      status: 409,
      code: 'CONVERSATIONAL_GEMMA_SETUP_BUSY',
    });
  }
  const controller = new AbortController();
  const current = { controller };
  job = current;
  publish({ phase: 'checking-access', detail: 'Preparing llama.cpp + Conversational Gemma 4 31B…', percent: 0, error: '', accessStatus: null });

  const run = runSetupPipeline(controller.signal, deps).catch((err) => {
    if (controller.signal.aborted) {
      publish({ phase: 'idle', detail: 'Setup cancelled.', percent: null, error: '' });
      return;
    }
    const message = err?.message || 'Conversational Gemma setup failed.';
    publish({ phase: 'failed', detail: message, error: message, percent: null });
  }).finally(() => {
    if (job === current) job = null;
  });

  if (deps.awaitCompletion) await run;
  return getConversationalGemmaSetupStatus(deps);
}

export async function cancelConversationalGemmaSetup(deps = {}) {
  if (!job) {
    publish({ phase: 'idle', detail: '', percent: null, error: '' });
    return getConversationalGemmaSetupStatus(deps);
  }
  job.controller.abort();
  publish({ phase: 'idle', detail: 'Setup cancelled.', percent: null, error: '' });
  return getConversationalGemmaSetupStatus(deps);
}

export function _resetConversationalGemmaSetupForTests() {
  job?.controller.abort();
  job = null;
  state = { phase: 'idle', detail: '', percent: null, error: '', accessStatus: null };
}
