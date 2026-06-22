import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const platform = process.platform;

/**
 * Is this an Apple-Silicon Mac (arm64 darwin)? Gates MLX model features: MLX is
 * Apple's native ML framework, so MLX formats only run on Apple Silicon. (Node
 * under Rosetta reports `process.arch === 'x64'`, which correctly reads false.)
 * Detect at the route boundary and pass into pure services, like `os.totalmem()`.
 * @returns {boolean}
 */
export function isAppleSilicon() {
  return process.platform === 'darwin' && process.arch === 'arm64';
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
