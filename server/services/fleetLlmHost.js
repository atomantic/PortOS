import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { detectSystemCapabilities } from '../lib/systemCapabilities.js';
import { getCudaUtilization } from '../lib/cudaCapability.js';
import { getTailscaleStatus } from '../lib/tailscale.js';
import { PORTS } from '../lib/ports.js';
import { PORTOS_ENV_PATH, parseEnvContents, upsertEnvLine, upsertPortosEnvLine } from '../lib/portosEnv.js';
import { atomicWrite, tryReadFile } from '../lib/fileUtils.js';
import { commandOutput } from '../lib/commandExists.js';
import { inspectVllmQwenProject } from '../lib/vllmQwenProject.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { createFleetLlmGateway } from './fleetLlmGateway.js';

const ENABLED_KEY = 'PORTOS_FLEET_LLM_ENABLED';
const MODEL = 'qwen3.8-27b';
const upstream = `http://127.0.0.1:${PORTS.VLLM_QWEN}`;
let gateway = null;
let setupRunning = false;

export function recommendFleetLlmHost(specs) {
  const gpu = specs.cuda?.gpus?.find((item) => /RTX 3090\b/i.test(item.name || '') && item.vramGb >= 23);
  if (gpu && ['win32', 'linux'].includes(specs.platform)) return {
    runtime: 'vllm', supported: true, title: 'Qwen3.8-27B · vLLM + DFlash 2',
    reason: 'Validated RTX 3090 recipe with structured tool calls and prefix caching. Recorded warm decode: 105 tokens/sec; actual speed depends on context and workload.',
  };
  if (specs.appleSilicon) return { runtime: 'mtplx', supported: false, title: 'MTPLX on Apple Silicon', reason: 'Use the managed MTPLX setup on Models → LLMs. Automated dedicated hosting currently supports the validated RTX 3090 recipe.' };
  return { runtime: null, supported: false, title: specs.cuda?.status === 'unknown' ? 'Hardware detection needs attention' : 'Connect to a model host', reason: 'No validated automatic Qwen3.8-27B host recipe matches this machine. Connect to an existing host, or compare installed models on Models → Performance.' };
}

async function readHostEnv() {
  const project = await inspectVllmQwenProject();
  const env = parseEnvContents(await readFile(join(project.dir, '.env'), 'utf8'));
  const apiKey = env.get('VLLM_API_KEY');
  if (!apiKey || apiKey.length < 24) throw new Error('The runtime needs an API key of at least 24 characters. Run recommended setup to configure it.');
  return { project, env, apiKey };
}

export async function startFleetLlmHost() {
  if (gateway) return;
  const enabled = parseEnvContents((await tryReadFile(PORTOS_ENV_PATH)) || '').get(ENABLED_KEY) === '1';
  if (!enabled) return;
  const { apiKey } = await readHostEnv();
  const next = createFleetLlmGateway({ upstream, apiKey });
  await new Promise((resolve, reject) => {
    next.server.once('error', reject);
    next.server.listen(PORTS.FLEET_LLM, '0.0.0.0', resolve);
  });
  next.server.on('error', () => console.error('❌ Fleet inference listener failed'));
  gateway = next;
}

export async function stopFleetLlmHost() {
  const previous = gateway;
  gateway = null;
  await previous?.close();
}

export async function getFleetLlmHostStatus() {
  const [specs, tailnet, docker] = await Promise.all([
    detectSystemCapabilities(), getTailscaleStatus(),
    commandOutput('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 }),
  ]);
  const recommendation = recommendFleetLlmHost(specs);
  const host = recommendation.supported && docker ? await readHostEnv().catch(() => null) : null;
  const probe = host ? await probeOpenAiModels(`${upstream}/v1`, { apiKey: host.apiKey, timeoutMs: 4000 }) : null;
  const enabled = parseEnvContents((await tryReadFile(PORTOS_ENV_PATH)) || '').get(ENABLED_KEY) === '1';
  return {
    recommendation, specs, enabled, serving: Boolean(gateway && probe?.models?.includes(MODEL)), setupRunning,
    endpoint: tailnet.running && tailnet.dnsName ? `http://${tailnet.dnsName}:${PORTS.FLEET_LLM}/v1` : null,
    model: MODEL, hasApiKey: Boolean(host?.apiKey),
    queue: gateway?.status() || { active: 0, queued: 0, maxActive: 1, maxQueued: 16 },
    checks: [
      { id: 'hardware', label: 'Supported hardware', ok: recommendation.supported },
      { id: 'docker', label: 'Docker engine responding', ok: Boolean(docker), detail: docker ? 'Ready' : 'Start Docker Desktop; if it is already running, restart its engine and retry.' },
      { id: 'weights', label: 'Prepared model and API key', ok: host ? host.project.hasWeights : null },
      { id: 'runtime', label: 'Qwen model loaded', ok: probe ? Boolean(probe.models?.includes(MODEL)) : null },
      { id: 'tailnet', label: 'Tailscale connected', ok: tailnet.running },
      { id: 'gateway', label: 'Shared API queue listening', ok: Boolean(gateway) },
    ],
  };
}

export async function revealFleetLlmKey() {
  const { apiKey } = await readHostEnv();
  return apiKey;
}

export async function configureFleetLlmHost({ emit = () => {}, isCancelled = () => false } = {}) {
  if (setupRunning) throw new Error('Model host setup is already running.');
  setupRunning = true;
  return configure({ emit, isCancelled }).finally(() => { setupRunning = false; });
}

async function configure({ emit, isCancelled }) {
  const recommendation = recommendFleetLlmHost(await detectSystemCapabilities());
  if (!recommendation.supported) throw new Error(recommendation.reason);
  const { ensureVllmProjectDir, provisionVllmQwenProject } = await import('./vllmQwenManager.js');
  emit('Checking Docker and the prepared model. This setup reserves the GPU for inference.');
  let docker = await commandOutput('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
  if (!docker && process.platform === 'win32') {
    emit('Starting Docker Desktop…');
    await runStreamingCommand('docker', ['desktop', 'start'], undefined, { timeoutMs: 60000 });
    docker = await commandOutput('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000 });
  }
  if (!docker) throw new Error('Docker engine is not responding. Open Docker Desktop and restart the engine, then retry. If its runtime socket is stuck, restart Windows. Prepared weights will be reused.');
  const misplaced = await ensureVllmProjectDir({ emit });
  if (misplaced) throw new Error(misplaced);
  const prepared = await provisionVllmQwenProject({ emit, isCancelled });
  if (!prepared.success) throw new Error(prepared.error);
  if (isCancelled()) throw new Error('Setup cancelled before starting the model.');
  const { project, apiKey } = await readHostEnv();
  const probe = await probeOpenAiModels(`${upstream}/v1`, { apiKey, timeoutMs: 3000 });
  if (!probe.reachable) {
    const gpu = await getCudaUtilization({ refresh: true });
    if (gpu.gpus?.some((item) => item.memoryUsedMib > 3000)) throw new Error('Another application is holding GPU memory. Unload its model on Models → LLMs, then retry.');
  }
  let contents = await readFile(join(project.dir, '.env'), 'utf8');
  for (const [key, value] of [['SPEC', 'dflash2'], ['PREFIX_CACHE', '1'], ['MAX_SEQS', '1']]) contents = upsertEnvLine(contents, key, value);
  await atomicWrite(join(project.dir, '.env'), contents);
  // !override replaces the public mapping, rather than appending another.
  const composeText = await commandOutput('docker', ['compose', '-f', project.composeFile, '--profile', 'single', 'config', '--format', 'json'], { cwd: project.dir, env: { ...process.env, PORT: String(PORTS.VLLM_QWEN) }, timeoutMs: 10000 });
  const compose = JSON.parse(composeText || '{}');
  const image = compose.services?.single?.image;
  if (!image) throw new Error('The prepared compose project has no single-user image.');
  const imageId = await commandOutput('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 10000 });
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId || '')) throw new Error('The prepared runtime image is missing. Build it with the runtime setup checklist first.');
  const override = join(project.dir, 'compose.portos-host.yaml');
  await atomicWrite(override, `services:\n  single:\n    image: ${imageId}\n    ports: !override\n      - "127.0.0.1:${PORTS.VLLM_QWEN}:${PORTS.VLLM_QWEN}"\n    restart: unless-stopped\n`);
  emit('Starting the prepared image with one generation slot and a private runtime port. Cold startup can take 5–7 minutes.');
  const started = await runStreamingCommand('docker', ['compose', '-f', project.composeFile, '-f', override, '--profile', 'single', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'single'], emit, { cwd: project.dir, env: { PORT: String(PORTS.VLLM_QWEN) }, timeoutMs: 60000 });
  if (!started.success) throw new Error(started.error);
  await upsertPortosEnvLine(ENABLED_KEY, '1');
  await startFleetLlmHost();
  const { getAllProviders, createProvider, updateProvider } = await import('./providers.js');
  const { providers } = await getAllProviders();
  const endpoint = `http://127.0.0.1:${PORTS.FLEET_LLM}/v1`;
  const existing = providers.find((provider) => provider.type === 'api' && provider.endpoint === endpoint);
  const record = { name: 'Dedicated Qwen API', type: 'api', endpoint, apiKey, models: [MODEL], defaultModel: MODEL, vllmBacked: true, enabled: true, thinking: false, temperature: 0.7, timeout: 600000 };
  const { localRuntimeForProvider } = await import('../lib/localProviderRuntime.js');
  for (const provider of providers) {
    const localRuntime = localRuntimeForProvider(provider);
    if (['lmstudio', 'ollama', 'llama', 'sglang', 'slotstream'].includes(localRuntime?.kind)) {
      await updateProvider(provider.id, { enabled: false });
      continue;
    }
    if (!provider.vllmBacked || localRuntime?.kind !== 'vllm') continue;
    const envVars = { ...provider.envVars };
    if (envVars.OPENCODE_CONFIG_CONTENT) {
      const config = JSON.parse(envVars.OPENCODE_CONFIG_CONTENT);
      if (config.provider?.vllm) config.provider.vllm.options = { ...config.provider.vllm.options, baseURL: endpoint };
      envVars.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    }
    await updateProvider(provider.id, { endpoint, apiKey, envVars, thinking: false, temperature: 0.7 });
  }
  if (existing) await updateProvider(existing.id, record);
  else await createProvider(record);
  emit('Persistent container and shared API queue configured. Refresh host status until Qwen is loaded, then connect another instance. Docker must start with Windows for reboot recovery.');
  return { success: true };
}
