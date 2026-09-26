import { noteFleetHostChanged } from './fleetHostNotify.js';
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
import { installFleetHostLoginTask, isFleetHostLoginTaskInstalled, removeFleetHostLoginTask } from './fleetLlmStartup.js';
import { flushFleetHostUsage, getFleetHostUsageLedger, getFleetHostUsageReport, scheduleFleetHostUsagePersist } from './fleetLlmUsage.js';
import { ensureFleetDockerIntegration } from './fleetLlmDocker.js';
import { createFleetLlmGateway } from './fleetLlmGateway.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { getNavPageForPath } from '../lib/navManifest.js';

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
  if (specs.appleSilicon) {
    const page = getNavPageForPath('/models/llms-runtimes')?.breadcrumb;
    return {
      runtime: 'mtplx',
      supported: false,
      title: 'MTPLX on Apple Silicon',
      reason: `Use the managed MTPLX setup${page ? ` on ${page}` : ''}. Automated dedicated hosting currently supports the validated RTX 3090 recipe.`,
    };
  }
  const performancePage = getNavPageForPath('/models/performance')?.breadcrumb;
  return {
    runtime: null,
    supported: false,
    title: specs.cuda?.status === 'unknown' ? 'Hardware detection needs attention' : 'Connect to a model host',
    reason: `No validated automatic Qwen3.8-27B host recipe matches this machine. Connect to an existing host${performancePage ? `, or compare installed models on ${performancePage}` : ''}.`,
  };
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
  // Hydrated before the listener binds, so the first inbound request is
  // recorded against the history already on disk rather than starting a second
  // ledger that the hydrate would then overwrite.
  const usage = await getFleetHostUsageLedger();
  const next = createFleetLlmGateway({ upstream, apiKey, usage, onRecorded: scheduleFleetHostUsagePersist, onChanged: () => noteFleetHostChanged({ usageOnly: true }) });
  await new Promise((resolve, reject) => {
    next.server.once('error', reject);
    next.server.listen(PORTS.FLEET_LLM, '0.0.0.0', resolve);
  });
  next.server.on('error', () => console.error('❌ Fleet inference listener failed'));
  gateway = next;
  noteFleetHostChanged();
}

export async function stopFleetLlmHost() {
  const previous = gateway;
  gateway = null;
  noteFleetHostChanged();
  await previous?.close();
  // The in-flight requests `close()` just cancelled are the newest rows in the
  // ledger; write them before the listener is gone rather than leaving them to
  // a debounce timer that a shutdown may never run.
  await flushFleetHostUsage();
}

export function getFleetLlmHostQueue() {
  return gateway?.status() || { active: 0, queued: 0, maxActive: 1, maxQueued: 16 };
}

/** Inbound usage, with this host's live admission state folded in. */
export async function getFleetLlmHostUsage() {
  return getFleetHostUsageReport({ queue: gateway?.status() || null });
}

/**
 * Turn the dedicated host OFF — every part of it, in the order that makes the
 * machine quiet and keeps it quiet.
 *
 * `configureFleetLlmHost` arms four separate things, and until this existed the
 * only way to undo any of them was by hand: the shared API listener, the
 * `PORTOS_FLEET_LLM_ENABLED` marker that brings it back on the next boot, a
 * container written with `restart: unless-stopped` (so stopping Docker does not
 * stop it), and — on Windows — a scheduled task that re-runs the resume path at
 * every login. Stopping only the container leaves three of those to start it
 * again, which is why the host looked impossible to stop.
 *
 * The listener and the marker are cleared FIRST and unconditionally: even if
 * docker is not answering, the host must stop accepting peer requests and must
 * not come back on the next restart. Docker's own step reports its failure as a
 * value, so an unreachable engine leaves the operator disabled-but-with-a-
 * container rather than enabled-and-confused.
 *
 * @returns {Promise<{success: boolean, containerStopped: boolean, error?: string}>}
 */
export function disableFleetLlmHost(options = {}) {
  return disableHost(options).finally(() => noteFleetHostChanged());
}

async function disableHost({ emit = () => {} } = {}) {
  emit('Closing the shared API queue — no new peer requests will be admitted.');
  await stopFleetLlmHost();
  await upsertPortosEnvLine(ENABLED_KEY, '0');
  noteFleetHostChanged();
  emit('Disabled the model host for the next restart.');

  const loginTask = await removeFleetHostLoginTask();
  if (!loginTask.success) emit(`Could not remove the Windows login task (${loginTask.error}) — it will try to resume the host at the next login.`);
  else if (process.platform === 'win32') emit('Removed the Windows login-recovery task.');

  const project = await inspectVllmQwenProject();
  if (!project.composeFile) {
    return { success: true, containerStopped: false, error: 'No prepared compose project was found, so no container was stopped. The API queue is closed and the host will stay off.' };
  }
  const override = join(project.dir, 'compose.portos-host.yaml');
  const files = (await tryReadFile(override)) === null
    ? ['-f', project.composeFile]
    : ['-f', project.composeFile, '-f', override];
  emit('Stopping and removing the vLLM container. Its image and weights stay on disk.');
  // `rm -s -f` stops AND removes: the host container carries
  // `restart: unless-stopped`, so a container merely stopped comes back the
  // next time the Docker engine starts. The weights and the image are
  // untouched — a later setup run starts again in minutes, not 30 GB.
  const stopped = await runStreamingCommand(
    'docker',
    ['compose', ...files, '--profile', 'single', 'rm', '-s', '-f', 'single'],
    emit,
    { cwd: project.dir, env: { PORT: String(PORTS.VLLM_QWEN) }, timeoutMs: 120000 },
  );
  if (!stopped.success) {
    return { success: true, containerStopped: false, error: `The host is disabled and its API queue is closed, but the container could not be stopped: ${stopped.error}` };
  }
  return { success: true, containerStopped: true };
}

export async function getFleetLlmHostStatus() {
  const [specs, tailnet, docker, loginTask] = await Promise.all([
    detectSystemCapabilities(), getTailscaleStatus(),
    commandOutput('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 }),
    isFleetHostLoginTaskInstalled(),
  ]);
  const recommendation = recommendFleetLlmHost(specs);
  const host = recommendation.supported && docker ? await readHostEnv().catch(() => null) : null;
  const probe = host ? await probeOpenAiModels(`${upstream}/v1`, { apiKey: host.apiKey, timeoutMs: 4000 }) : null;
  const enabled = parseEnvContents((await tryReadFile(PORTOS_ENV_PATH)) || '').get(ENABLED_KEY) === '1';
  return {
    recommendation, specs, enabled, serving: Boolean(gateway && probe?.models?.includes(MODEL)), setupRunning,
    // What a Stop action would actually have to turn off. Reported separately
    // from `serving` because the case the operator hits is precisely the one
    // where those disagree: a container answering on the runtime port while the
    // model has not finished loading still reads `serving: false`, and offering
    // no Stop button there is how the host became impossible to turn off.
    listening: Boolean(gateway), runtimeReachable: Boolean(probe?.reachable),
    stoppable: Boolean(gateway) || Boolean(probe?.reachable) || enabled,
    endpoint: tailnet.running && tailnet.dnsName ? `http://${tailnet.dnsName}:${PORTS.FLEET_LLM}/v1` : null,
    model: MODEL, hasApiKey: Boolean(host?.apiKey),
    queue: getFleetLlmHostQueue(),
    checks: [
      { id: 'hardware', label: 'Supported hardware', ok: recommendation.supported },
      { id: 'docker', label: 'Docker engine responding', ok: Boolean(docker), detail: docker ? 'Ready' : 'Start Docker Desktop; if it is already running, restart its engine and retry.' },
      { id: 'weights', label: 'Prepared model and API key', ok: host ? host.project.hasWeights : null },
      { id: 'runtime', label: 'Qwen model loaded', ok: probe ? Boolean(probe.models?.includes(MODEL)) : null },
      { id: 'tailnet', label: 'Tailscale connected', ok: tailnet.running },
      ...(specs.platform === 'win32' ? [{ id: 'startup', label: 'Windows login recovery registered', ok: loginTask }] : []),
      { id: 'gateway', label: 'Shared API queue listening', ok: Boolean(gateway) },
    ],
  };
}

export async function revealFleetLlmKey() {
  const { apiKey } = await readHostEnv();
  return apiKey;
}

export async function getFleetPeerHosts({ timeoutMs = 3000 } = {}) {
  const { getPeers } = await import('./instances.js');
  const peers = await getPeers();
  const candidates = peers.filter((p) => p && p.enabled !== false && p.status !== 'offline');
  if (candidates.length === 0) return { hosts: [] };

  const results = await Promise.allSettled(
    candidates.map(async (peer) => {
      return withAbortTimeout(timeoutMs, async (signal) => {
        const baseUrl = peerBaseUrl(peer);
        const res = await peerFetch(`${baseUrl}/api/providers/fleet-host`, { signal }, peer);
        if (!res.ok) throw new Error('Peer host status unavailable');
        const status = await res.json();
        if (!status || typeof status.enabled !== 'boolean' || typeof status.serving !== 'boolean') throw new Error('Invalid peer host status');
        if (!status.serving && !status.enabled) return null;

        const endpoint = status.endpoint || (peer.host || peer.address
          ? `http://${peer.host || peer.address}:${PORTS.FLEET_LLM}/v1`
          : null);

        return {
          peerId: peer.id,
          peerName: peer.name || peer.host || peer.address,
          peerHost: peer.host || null,
          peerAddress: peer.address,
          endpoint,
          model: status.model || MODEL,
          serving: Boolean(status.serving),
          enabled: Boolean(status.enabled),
          hasApiKey: Boolean(status.hasApiKey),
          specs: status.specs || null,
          queue: status.queue || null,
        };
      });
    })
  );

  const hosts = results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value);

  const unavailable = results.filter(result => result.status === 'rejected').length;
  return { hosts, ...(unavailable ? { unavailable } : {}) };
}

export async function revealFleetPeerHostKey(peerId, { timeoutMs = 4000 } = {}) {
  if (!peerId) throw new Error('Peer ID is required');
  const { getPeers } = await import('./instances.js').catch(() => ({ getPeers: async () => [] }));
  const peers = await getPeers().catch(() => []);
  const peer = peers.find((p) => p.id === peerId);
  if (!peer) throw new Error('Peer not found');

  const baseUrl = peerBaseUrl(peer);
  return withAbortTimeout(timeoutMs, async (signal) => {
    const res = await peerFetch(`${baseUrl}/api/providers/fleet-host/key`, { method: 'POST', signal }, peer);
    if (!res.ok) {
      throw new Error(`Host returned HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => null);
    if (!data?.apiKey) {
      throw new Error('Host did not return an API key');
    }
    return { apiKey: data.apiKey };
  });
}

export async function configureFleetLlmHost({ emit = () => {}, isCancelled = () => false } = {}) {
  if (setupRunning) throw new Error('Model host setup is already running.');
  setupRunning = true;
  noteFleetHostChanged();
  return configure({ emit, isCancelled }).finally(() => { setupRunning = false; noteFleetHostChanged(); });
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
  await ensureFleetDockerIntegration(await inspectVllmQwenProject(), { emit });
  const prepared = await provisionVllmQwenProject({ emit, isCancelled });
  if (!prepared.success) throw new Error(prepared.error);
  if (isCancelled()) throw new Error('Setup cancelled before starting the model.');
  const { project, apiKey } = await readHostEnv();
  const probe = await probeOpenAiModels(`${upstream}/v1`, { apiKey, timeoutMs: 3000 });
  if (!probe.reachable) {
    const gpu = await getCudaUtilization({ refresh: true });
    if (gpu.gpus?.some((item) => item.memoryUsedMib > 3000)) {
      const page = getNavPageForPath('/models/llms-runtimes')?.breadcrumb;
      throw new Error(`Another application is holding GPU memory. Unload its model${page ? ` on ${page}` : ''}, then retry.`);
    }
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
  const loginTask = await installFleetHostLoginTask();
  if (!loginTask.success) throw new Error('The model started, but Windows login startup could not be configured: ' + loginTask.error);
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
