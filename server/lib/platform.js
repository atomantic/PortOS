import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const platform = process.platform;

// Probe the real CPU for arm64, cached. Needed because a Node launched under
// Rosetta on an M-series Mac reports `process.arch === 'x64'` even though the
// hardware (and a native LM Studio) is Apple Silicon — `hw.optional.arm64` is the
// hardware truth regardless of the process's translation. try/catch is the
// sanctioned child-process boundary (the sysctl key is absent on Intel → throws).
let arm64HardwareCache;
function probeArm64Hardware() {
  if (arm64HardwareCache === undefined) {
    try {
      arm64HardwareCache = execSync('sysctl -n hw.optional.arm64', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1';
    } catch {
      arm64HardwareCache = false;
    }
  }
  return arm64HardwareCache;
}

/**
 * Is this an Apple-Silicon Mac? Gates MLX model features (MLX is Apple's native
 * framework, so MLX formats only run on Apple Silicon). Detect at the route
 * boundary and pass into pure services, like `os.totalmem()`.
 *
 * `process.arch === 'arm64'` is the fast native answer; an x64 darwin process may
 * still be arm64 hardware under Rosetta, so that case probes `hw.optional.arm64`.
 * The `platform`/`arch`/`probe` overrides exist for deterministic tests.
 * @returns {boolean}
 */
export function isAppleSilicon({ platform: plat = process.platform, arch = process.arch, probe = probeArm64Hardware } = {}) {
  if (plat !== 'darwin') return false;
  if (arch === 'arm64') return true;
  return probe();
}

/**
 * Parse a platform port-discovery command into a sorted unique list. Kept pure
 * so command formats are covered deterministically instead of depending on the
 * test host's current listeners or installed utilities.
 * @param {string} stdout
 * @param {string} targetPlatform
 * @returns {number[]} Array of port numbers
 */
export function parseListeningPorts(stdout, targetPlatform = platform) {
  const ports = new Set();
  const addPort = (value) => {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  };

  if (targetPlatform === 'darwin') {
    for (const line of String(stdout || '').split('\n')) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (match) addPort(match[1]);
    }
  } else if (targetPlatform === 'linux') {
    for (const line of String(stdout || '').split('\n')) {
      if (!/^\s*LISTEN\b/.test(line)) continue;
      const match = line.match(/:(\d+)\s/);
      if (match) addPort(match[1]);
    }
  } else {
    for (const line of String(stdout || '').split('\n')) {
      if (!/\bLISTENING\b/i.test(line)) continue;
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+/i);
      if (match) addPort(match[1]);
    }
  }

  return Array.from(ports).sort((a, b) => a - b);
}

function portProbeFor(targetPlatform) {
  if (targetPlatform === 'darwin') return 'lsof -iTCP -sTCP:LISTEN -n -P';
  if (targetPlatform === 'linux') return 'ss -lntp';
  return 'netstat -an';
}

/**
 * Get list of listening TCP ports. Discovery failure is explicit: returning an
 * empty array would be indistinguishable from a host with no listeners and let
 * callers advertise occupied ports as free.
 * @param {{platform?: string, exec?: Function}} options deterministic overrides
 * @returns {Promise<number[]>} Array of port numbers
 */
export async function getListeningPorts({ platform: targetPlatform = platform, exec: run = execAsync } = {}) {
  const command = portProbeFor(targetPlatform);
  try {
    const { stdout } = await run(command, { windowsHide: true });
    return parseListeningPorts(stdout, targetPlatform);
  } catch (cause) {
    const error = new Error(`Unable to discover listening ports with ${command}: ${cause.message}`);
    error.code = 'PORT_DISCOVERY_FAILED';
    error.command = command;
    error.platform = targetPlatform;
    error.cause = cause;
    throw error;
  }
}

/**
 * Check if a specific port is in use
 * @param {number} port Port to check
 * @returns {Promise<boolean>} True if port is in use
 */
export async function isPortInUse(port, probeOptions) {
  const ports = await getListeningPorts(probeOptions);
  return ports.includes(port);
}

/**
 * Find available ports in a range
 * @param {number} start Start of range
 * @param {number} end End of range
 * @param {number} count Number of ports to find
 * @returns {Promise<number[]>} Available ports
 */
export async function findAvailablePorts(start, end, count = 1, probeOptions) {
  if (start > end || count <= 0) return [];
  const usedPorts = new Set(await getListeningPorts(probeOptions));
  const available = [];

  for (let port = start; port <= end && available.length < count; port++) {
    if (!usedPorts.has(port)) {
      available.push(port);
    }
  }

  return available;
}

export { platform };
