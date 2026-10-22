import { runCliBounded } from './runCliBounded.js';

// macOS never prompts for Full Disk Access; the operator must add the exact
// binary TCC attributes the access to. Under a pm2 LaunchAgent that is the
// node binary itself (launchd is the parent, so no terminal app's grant
// applies); under a terminal-started server it is the terminal app. The grant
// is per binary path, so an nvm Node upgrade (new versions/node/vX path) needs
// a fresh grant.

export const FULL_DISK_ACCESS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

const MAX_ANCESTOR_HOPS = 12;
const APP_BUNDLE_RE = /^(.*?\.app)\/Contents\/MacOS\//;

// `ps -o ppid=,comm=` on macOS prints the parent pid and the full executable path.
function parsePsLine(stdout) {
  const m = String(stdout || '').trim().match(/^(\d+)\s+(.+)$/);
  return m ? { ppid: Number(m[1]), comm: m[2].trim() } : null;
}

async function defaultReadProcess(pid) {
  const { code, stdout } = await runCliBounded('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeoutMs: 2_000 });
  return code === 0 ? parsePsLine(stdout) : null;
}

/**
 * Pure: pick the grant target from the process ancestry (self first, nearest
 * parent next). The outermost `.app` bundle in the chain is what TCC credits
 * for a terminal-started server; with none, the chain ends at launchd and the
 * server's own binary (plus a distinct pm2 daemon binary) needs the grant.
 */
function resolveFullDiskAccessTarget({ execPath, ancestors = [] }) {
  let app = null;
  for (const comm of ancestors) {
    const m = comm.match(APP_BUNDLE_RE);
    if (m) app = m[1];
  }
  if (app) {
    return { launchedBy: 'app', paths: [app], hostApp: app.split('/').pop().replace(/\.app$/, '') };
  }
  const paths = [execPath];
  for (const comm of ancestors) {
    if (comm.startsWith('/') && /\/node$/.test(comm) && !paths.includes(comm)) paths.push(comm);
  }
  return { launchedBy: 'launchd', paths, hostApp: null };
}

function fullDiskAccessRemediation(target) {
  const what = target?.paths?.length ? target.paths.join(' and ') : 'the process running PortOS';
  return `Add ${what} to System Settings → Privacy & Security → Full Disk Access (+, then Cmd+Shift+G to paste the path), then restart PortOS.`;
}

// Never throws; off macOS (or when `ps` fails) it falls back to the server's own binary.
async function describeFullDiskAccessTarget({
  execPath = process.execPath,
  pid = process.pid,
  platform = process.platform,
  readProcess = defaultReadProcess,
} = {}) {
  const ancestors = [];
  if (platform === 'darwin') {
    let current = await readProcess(pid).catch(() => null);
    for (let hop = 0; current && current.ppid > 1 && hop < MAX_ANCESTOR_HOPS; hop += 1) {
      current = await readProcess(current.ppid).catch(() => null);
      if (current?.comm) ancestors.push(current.comm);
    }
  }
  const target = resolveFullDiskAccessTarget({ execPath, ancestors });
  return { ...target, settingsUrl: FULL_DISK_ACCESS_SETTINGS_URL, nodeVersion: process.version };
}

/**
 * Spread into a setup/sync failure report: `{ fullDiskAccess, remediation }`
 * naming which binary needs Full Disk Access on this machine. Options are
 * injectable for tests.
 */
export async function fullDiskAccessDetails(options) {
  const fullDiskAccess = await describeFullDiskAccessTarget(options);
  return { fullDiskAccess, remediation: fullDiskAccessRemediation(fullDiskAccess) };
}
