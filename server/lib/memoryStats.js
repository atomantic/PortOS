import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';

const execAsync = promisify(exec);

// `os.freemem()` on macOS returns only "Pages free" — it counts the file
// cache, inactive, and purgeable pages as used, even though the OS will
// reclaim them under pressure. That's why naive (totalmem - freemem) reads
// 47 GB used on a 48 GB box that Activity Monitor says is at 38 GB.
//
// This helper parses the host's authoritative numbers and returns a stat
// shape that matches the "Memory Used" figure Activity Monitor / `top`
// (and macOS's own pressure indicator) display.

function fallback() {
  const total = os.totalmem();
  const free = os.freemem();
  return { total, used: total - free, free, source: 'os' };
}

async function macMemory() {
  const { stdout } = await execAsync('vm_stat', { windowsHide: true });
  const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

  const pages = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([^:]+):\s+(\d+)\.?\s*$/);
    if (m) pages[m[1].trim()] = parseInt(m[2], 10);
  }

  const wired = pages['Pages wired down'] || 0;
  const compressorOccupied = pages['Pages occupied by compressor'] || 0;
  const anonymous = pages['Anonymous pages'] || 0;
  const purgeable = pages['Pages purgeable'] || 0;

  const appMemory = Math.max(0, anonymous - purgeable);
  const usedPages = appMemory + wired + compressorOccupied;

  const total = os.totalmem();
  const used = Math.min(total, usedPages * pageSize);
  return { total, used, free: total - used, source: 'vm_stat' };
}

async function linuxMemory() {
  const text = await readFile('/proc/meminfo', 'utf-8');
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? parseInt(m[1], 10) * 1024 : 0;
  };
  const total = get('MemTotal');
  const available = get('MemAvailable')
    || (get('MemFree') + get('Buffers') + get('Cached'));
  if (total === 0) return fallback();
  const used = Math.max(0, total - available);
  return { total, used, free: available, source: 'meminfo' };
}

export async function getMemoryStats() {
  if (process.platform === 'darwin') {
    return macMemory().catch(() => fallback());
  }
  if (process.platform === 'linux') {
    return linuxMemory().catch(() => fallback());
  }
  return fallback();
}
