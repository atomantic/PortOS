import { getListeningPorts, findAvailablePorts } from '../lib/platform.js';
import { getReservedPorts } from './apps.js';

// Managed-app band from docs/PORTS.md; 5553-5569 belongs to PortOS itself.
// Allocation overflows past the end (see allocatePorts) but never below the start.
export const DEFAULT_PORT_RANGE_START = 5570;
export const DEFAULT_PORT_RANGE_END = 5599;
const PORT_OVERFLOW = 100;

/**
 * Scan system for used ports and compute available ranges
 */
export async function scanPorts() {
  // Get ports currently in use by the system
  const usedPorts = await getListeningPorts();

  // Get ports reserved by registered apps (may not be currently running)
  const reservedPorts = await getReservedPorts();

  // Combine used and reserved
  const allOccupied = [...new Set([...usedPorts, ...reservedPorts])].sort((a, b) => a - b);

  // Compute free ranges in our default range
  const freeRanges = computeFreeRanges(allOccupied, DEFAULT_PORT_RANGE_START, DEFAULT_PORT_RANGE_END);

  // Find suggested next available ports
  const suggestedPorts = await findAvailablePorts(DEFAULT_PORT_RANGE_START, DEFAULT_PORT_RANGE_END, 2, undefined, reservedPorts);

  return {
    usedPorts,
    reservedPorts,
    allOccupied,
    freeRanges,
    suggestedPorts,
    defaultRange: {
      start: DEFAULT_PORT_RANGE_START,
      end: DEFAULT_PORT_RANGE_END
    }
  };
}

/**
 * Compute free ranges within a given range
 */
function computeFreeRanges(occupiedPorts, start, end) {
  const ranges = [];
  let rangeStart = start;

  const portsInRange = occupiedPorts.filter(p => p >= start && p <= end).sort((a, b) => a - b);

  for (const port of portsInRange) {
    if (rangeStart < port) {
      ranges.push({ start: rangeStart, end: port - 1, count: port - rangeStart });
    }
    rangeStart = port + 1;
  }

  // Add remaining range after last occupied port
  if (rangeStart <= end) {
    ranges.push({ start: rangeStart, end, count: end - rangeStart + 1 });
  }

  return ranges;
}

/**
 * Check if specific ports are available
 */
export async function checkPortsAvailable(ports) {
  const scan = await scanPorts();
  const results = {};

  for (const port of ports) {
    results[port] = !scan.allOccupied.includes(port);
  }

  return results;
}

/**
 * Allocate N ports, preferring the managed band and overflowing just past it.
 * Skips listeners, ports reserved by registered apps, and browser-blocked ports.
 */
export async function allocatePorts(count = 1) {
  const reservedPorts = await getReservedPorts();
  return findAvailablePorts(
    DEFAULT_PORT_RANGE_START,
    DEFAULT_PORT_RANGE_END + PORT_OVERFLOW,
    count,
    undefined,
    reservedPorts
  );
}
