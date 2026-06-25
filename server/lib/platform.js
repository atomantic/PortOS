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
 * Get list of listening TCP ports
 * @returns {Promise<number[]>} Array of port numbers
 */
export async function getListeningPorts() {
  const ports = new Set();

  if (platform === 'darwin') {
    // macOS: use lsof
    const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -n -P', { windowsHide: true }).catch(() => ({ stdout: '' }));
    const lines = stdout.split('\n').slice(1); // Skip header
    for (const line of lines) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (match) {
        ports.add(parseInt(match[1], 10));
      }
    }
  } else if (platform === 'linux') {
    // Linux: use ss
    const { stdout } = await execAsync('ss -lntp', { windowsHide: true }).catch(() => ({ stdout: '' }));
    const lines = stdout.split('\n').slice(1); // Skip header
    for (const line of lines) {
      const match = line.match(/:(\d+)\s/);
      if (match) {
        ports.add(parseInt(match[1], 10));
      }
    }
  } else {
    // Windows: use netstat
    const { stdout } = await execAsync('netstat -an', { windowsHide: true }).catch(() => ({ stdout: '' }));
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('LISTENING')) {
        const match = line.match(/:(\d+)\s/);
        if (match) {
          ports.add(parseInt(match[1], 10));
        }
      }
    }
  }

  return Array.from(ports).sort((a, b) => a - b);
}

/**
 * Check if a specific port is in use
 * @param {number} port Port to check
 * @returns {Promise<boolean>} True if port is in use
 */
export async function isPortInUse(port) {
  const ports = await getListeningPorts();
  return ports.includes(port);
}

/**
 * Find available ports in a range
 * @param {number} start Start of range
 * @param {number} end End of range
 * @param {number} count Number of ports to find
 * @returns {Promise<number[]>} Available ports
 */
export async function findAvailablePorts(start, end, count = 1) {
  const usedPorts = await getListeningPorts();
  const available = [];

  for (let port = start; port <= end && available.length < count; port++) {
    if (!usedPorts.includes(port)) {
      available.push(port);
    }
  }

  return available;
}

export { platform };
