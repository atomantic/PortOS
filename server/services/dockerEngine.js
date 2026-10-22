/**
 * Shared Docker discovery (#12844): the CLI, the engine it talks to, and the
 * readiness vocabulary every Docker-backed runtime reports. SuperCollider uses
 * `resolveDockerCli` / `probeDocker` unchanged; the containment profile uses
 * `resolveDockerEngine`, which also chooses and pins an endpoint.
 *
 * PortOS never installs, starts or reconfigures Docker. Only local endpoints
 * (`unix://`, `npipe://`) are accepted: a `tcp://` or `ssh://` context would
 * ship a worktree to another machine.
 *
 * Node builtins plus dependency-light `server/lib` modules, so the standalone
 * autofixer package can import it.
 */

import { existsSync } from 'node:fs';
import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
import { whichFirst } from '../lib/processEnv.js';
import { parseDockerVersion } from '../lib/superColliderRuntime.js';

const DOCKER_PROBE_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTIC_CHARS = 600;

// Docker Desktop's CLI is not always on a PM2-launched server's PATH — a
// fresh Docker Desktop install may not have created the /usr/local/bin link yet.
export const DOCKER_FALLBACK_PATHS = Object.freeze([
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
]);

const NATIVE_DOCKER_ENDPOINT = 'unix:///var/run/docker.sock';

/** Docker Desktop's context name on macOS, Windows and Linux. */
export const DOCKER_DESKTOP_CONTEXT = 'desktop-linux';

/** Keep diagnostics bounded: one line, at most MAX_DIAGNOSTIC_CHARS, tail-preferring. */
export function clipDiagnostic(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DIAGNOSTIC_CHARS ? `…${flat.slice(-MAX_DIAGNOSTIC_CHARS)}` : flat;
}

/**
 * The docker CLI adapter: `capture` runs a short command and buffers its
 * output; `stream` (when given) runs a long one. `globalArgs` (`--context X`
 * or `--host Y`) prefix every command so a run lands on the engine the
 * resolver verified. Tests pass a fake with the same methods.
 */
function createDockerCli(bin, { globalArgs = [], stream = null } = {}) {
  const env = { ...process.env };
  // The explicit endpoint below must win over anything the server inherited.
  if (globalArgs.length) { delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT; }
  return {
    bin,
    globalArgs,
    env,
    capture: (args, { timeoutMs = DOCKER_PROBE_TIMEOUT_MS } = {}) => bufferedSpawn(bin, [...globalArgs, ...args], { env, timeoutMs, killGraceMs: 2_000, shell: false }),
    ...(stream ? { stream } : {}),
  };
}

/** Path of the local docker CLI, or null when it is not installed. */
async function findDockerBinary({ which = whichFirst, exists = existsSync } = {}) {
  return await which('docker') || DOCKER_FALLBACK_PATHS.find((path) => exists(path)) || null;
}

/**
 * The local docker CLI (against whatever endpoint its own config selects), or
 * null when it is not installed. `stream` is supplied by the caller that needs
 * long-running commands (SuperCollider's builds and renders).
 */
export async function resolveDockerCli({ stream = null } = {}) {
  const bin = await findDockerBinary();
  return bin ? createDockerCli(bin, { stream: stream ? (args, onLine, options) => stream(bin, args, onLine, options) : null }) : null;
}

/** `{ installed, running, clientVersion, serverVersion, os, arch, platformName, error }` for a docker CLI (null = not installed). */
export async function probeDocker(cli) {
  if (!cli) return { installed: false, running: false, clientVersion: null, serverVersion: null, os: null, arch: null, platformName: null, error: null };
  const result = await cli.capture(['version', '--format', '{{json .}}']);
  // The client prints its half even when the engine is down, so the server
  // version — not the exit code alone — is what proves the engine answered.
  const version = parseDockerVersion(result.stdout);
  let platformName = null;
  try { platformName = JSON.parse(String(result.stdout || '').trim())?.Server?.Platform?.Name ?? null; } catch { platformName = null; }
  const running = Boolean(version.serverVersion);
  return {
    installed: true,
    running,
    ...version,
    platformName,
    error: running ? null : clipDiagnostic(result.timedOut ? 'docker did not answer in time' : spawnFailureDetail(result, 'docker engine not reachable')),
  };
}

/** `local` for unix/npipe endpoints, `remote` for tcp/ssh/anything else, null when empty. */
function classifyDockerEndpoint(endpoint) {
  const text = String(endpoint ?? '').trim();
  if (!text) return null;
  return /^(unix|npipe):\/\//i.test(text) ? 'local' : 'remote';
}

/** Parse `docker context ls --format '{{json .}}'` (one object per line). */
function parseDockerContexts(stdout) {
  return String(stdout || '').split('\n').flatMap((line) => {
    let row;
    try { row = JSON.parse(line); } catch { return []; }
    const name = typeof row?.Name === 'string' ? row.Name : null;
    if (!name) return [];
    return [{ name, current: row.Current === true, endpoint: typeof row.DockerEndpoint === 'string' ? row.DockerEndpoint : '' }];
  });
}

/**
 * The endpoints to try, best first: Docker Desktop (preferred when present),
 * the active context, then `default` (native dockerd's socket on Linux). An
 * operator-set `DOCKER_HOST` is the only candidate — it is what they chose.
 */
function dockerEngineCandidates({ contexts = [], dockerHost = null } = {}) {
  if (dockerHost) return [{ name: null, current: true, endpoint: dockerHost, globalArgs: ['--host', dockerHost] }];
  // A CLI too old for contexts still has the native socket.
  if (contexts.length === 0) return [{ name: null, current: true, endpoint: NATIVE_DOCKER_ENDPOINT, globalArgs: ['--host', NATIVE_DOCKER_ENDPOINT] }];
  const ordered = [
    contexts.find((c) => c.name === DOCKER_DESKTOP_CONTEXT),
    contexts.find((c) => c.current),
    contexts.find((c) => c.name === 'default'),
  ].filter(Boolean);
  const seen = new Set();
  return ordered.filter((c) => !seen.has(c.name) && seen.add(c.name))
    .map((c) => ({ name: c.name, current: c.current, endpoint: c.endpoint, globalArgs: ['--context', c.name] }));
}

/** `desktop` (Docker Desktop), `native` (a local dockerd), or `other` (Colima, OrbStack, …). */
function dockerEngineKind({ platformName, endpoint, contextName }) {
  if (/docker desktop/i.test(String(platformName ?? '')) || contextName === DOCKER_DESKTOP_CONTEXT) return 'desktop';
  if (/^unix:\/\/\/(var\/)?run\/docker\.sock$/.test(String(endpoint ?? ''))) return 'native';
  return 'other';
}

const ENGINE_LABELS = { desktop: 'Docker Desktop', native: 'Docker Engine', other: 'Docker-compatible engine' };

/**
 * The engine verdict: `{ state, ready, message, engine, cli }`, `state` one of
 * docker-missing, docker-stopped, docker-unsupported, docker-remote-refused,
 * ready. `cli` (bound to the chosen endpoint) is present only when ready.
 */
function evaluateDockerEngine({ installed, candidates = [], probes = [], platform = process.platform }) {
  const verdict = (state, message, extra = {}) => ({ state, ready: state === 'ready', message, engine: null, cli: null, ...extra });
  if (!installed) {
    return verdict('docker-missing', 'Docker is not installed. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux) and start it — PortOS never installs or reconfigures Docker for you.');
  }
  const remote = candidates.filter((c) => classifyDockerEndpoint(c.endpoint) === 'remote');
  const answered = probes.find((p) => p.docker.running);
  if (!answered) {
    // An operator who pointed the active context (or DOCKER_HOST) at another
    // machine is told so, rather than seeing a generic "stopped".
    if (remote.some((c) => c.current)) {
      return verdict('docker-remote-refused', `The Docker endpoint (${remote[0].name ?? 'DOCKER_HOST'}) is not local; contained runs only use a unix:// or npipe:// engine on this machine.`);
    }
    const error = probes.map((p) => p.docker.error).find(Boolean);
    return verdict('docker-stopped', `Docker is installed but no local engine answered${error ? ` (${error})` : ''}. Start Docker Desktop or the Docker service and try again.`);
  }
  const { candidate, docker } = answered;
  const kind = dockerEngineKind({ platformName: docker.platformName, endpoint: candidate.endpoint, contextName: candidate.name });
  const engine = {
    kind,
    label: ENGINE_LABELS[kind],
    context: candidate.name,
    serverVersion: docker.serverVersion,
    os: docker.os,
    arch: docker.arch,
  };
  if (docker.os !== 'linux') {
    return verdict('docker-unsupported', `Docker is serving ${docker.os || 'unknown'} containers; contained runs need Linux containers.`, { engine });
  }
  if (platform === 'win32') {
    return verdict('docker-unsupported', 'Contained runs are not supported on Windows hosts yet.', { engine });
  }
  return verdict('ready', `${engine.label} ${docker.serverVersion} is ready${candidate.name ? ` (context ${candidate.name})` : ''}.`, { engine, cli: answered.cli });
}

/**
 * Find a local, running engine. Asks only the docker CLI (context list and
 * `docker version` per candidate); never starts, installs or reconfigures it.
 *
 * @param {object} [deps]
 * @param {string|null} [deps.bin] - docker binary (undefined → discover)
 * @param {(bin: string, opts: object) => object} [deps.createCli]
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {Function} [deps.which] - PATH lookup (test seam)
 * @param {Function} [deps.exists] - fallback-path probe (test seam)
 */
export async function resolveDockerEngine({ bin, createCli = createDockerCli, env = process.env, platform = process.platform, which, exists } = {}) {
  const dockerBin = bin === undefined ? await findDockerBinary({ which, exists }) : bin;
  if (!dockerBin) return evaluateDockerEngine({ installed: false, platform });
  const dockerHost = String(env.DOCKER_HOST ?? '').trim() || null;
  let contexts = [];
  if (!dockerHost) {
    const listed = await createCli(dockerBin).capture(['context', 'ls', '--format', '{{json .}}']);
    contexts = listed.success ? parseDockerContexts(listed.stdout) : [];
  }
  const candidates = dockerEngineCandidates({ contexts, dockerHost });
  const probes = [];
  for (const candidate of candidates) {
    if (classifyDockerEndpoint(candidate.endpoint) !== 'local') continue;
    const cli = createCli(dockerBin, { globalArgs: candidate.globalArgs });
    const docker = await probeDocker(cli);
    probes.push({ candidate, docker, cli });
    if (docker.running) break;
  }
  return evaluateDockerEngine({ installed: true, candidates, probes, platform });
}
