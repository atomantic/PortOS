import { existsSync } from 'fs';
import { join, delimiter } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { safeJSONParse } from './fileUtils.js';

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === 'win32';
const TAILSCALE_BIN = IS_WIN ? 'tailscale.exe' : 'tailscale';

export const MACOS_TAILSCALE_APP_BUNDLE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// Paths where the Tailscale CLI binary is commonly found. On macOS the GUI app
// doesn't put the CLI in PATH by default; Homebrew installs to /usr/local/bin
// (Intel) or /opt/homebrew/bin (Apple Silicon); Linux packages land in /usr/bin;
// Windows installs land in Program Files.
//
// On macOS we prefer Homebrew over the App Store bundle. The Mac App Store
// build of Tailscale runs under macOS App Sandbox and `tailscale cert` cannot
// write the cert temp file outside its container (EPERM "operation not
// permitted" when targeting paths like data/certs/). The Homebrew binary is
// the open-source CLI and is not sandboxed, so it can write anywhere the
// shell user can. App-bundle is kept as a last-resort fallback.
const TAILSCALE_CANDIDATES = IS_WIN
  ? [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
    ]
  : [
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
      '/usr/bin/tailscale',
      MACOS_TAILSCALE_APP_BUNDLE
    ];

export function findTailscale() {
  for (const p of TAILSCALE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  // Use path.delimiter (';' on Windows, ':' elsewhere) so PATH scanning works cross-platform.
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, TAILSCALE_BIN);
    if (existsSync(p)) return p;
  }
  return null;
}

export function isSandboxedTailscale(binPath) {
  return binPath === MACOS_TAILSCALE_APP_BUNDLE;
}

/**
 * Read the Tailscale backend state via `tailscale status --json`.
 *
 * Distinguishes the states that matter for deciding whether federated peer
 * probing is worth attempting — the CLI cleanly exits 0 with
 * `BackendState: "Stopped"` when Tailscale is installed but not connected, so a
 * mere "binary exists" check (findTailscale) is NOT enough to know we're on the
 * tailnet. Returns:
 *   - available: the CLI binary was found
 *   - running:   BackendState === 'Running' (connected to the tailnet)
 *   - state:     raw BackendState string, or null when unknown
 *   - reason:    machine-readable classification for logs/UI
 *
 * Never throws — execFile failures and non-JSON output degrade to a
 * not-running result so callers can treat this as a plain boolean gate.
 */
export async function getTailscaleStatus() {
  const bin = findTailscale();
  if (!bin) return { available: false, running: false, state: null, reason: 'tailscale-not-installed' };
  const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 5000 })
    .catch(() => ({ stdout: null }));
  if (!stdout) return { available: true, running: false, state: null, reason: 'tailscale-status-failed' };
  // Guard against non-JSON output (warnings, partial reads) so we never throw.
  const status = safeJSONParse(stdout, null);
  if (!status) return { available: true, running: false, state: null, reason: 'tailscale-parse-error' };
  const state = status.BackendState ?? null;
  return {
    available: true,
    running: state === 'Running',
    state,
    reason: state === 'Running' ? 'running' : `tailscale-${(state || 'unknown').toLowerCase()}`
  };
}

/**
 * Convenience boolean: true only when Tailscale is installed AND connected to
 * the tailnet (BackendState === 'Running').
 */
export async function isTailscaleUp() {
  const { running } = await getTailscaleStatus();
  return running;
}

export function hasOnlySandboxedTailscale() {
  if (process.platform !== 'darwin') return false;
  // True iff the MAS app bundle exists AND no unsandboxed binary is
  // reachable anywhere. The previous implementation delegated to
  // findTailscale which returns the FIRST candidate in TAILSCALE_CANDIDATES
  // order — so an unsandboxed `tailscale` living in a non-standard $PATH
  // directory (not in TAILSCALE_CANDIDATES) was missed entirely, and we
  // misclassified the machine as sandboxed-only.
  if (!existsSync(MACOS_TAILSCALE_APP_BUNDLE)) return false;
  for (const p of TAILSCALE_CANDIDATES) {
    if (p === MACOS_TAILSCALE_APP_BUNDLE) continue;
    if (existsSync(p)) return false;
  }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, TAILSCALE_BIN);
    if (existsSync(p) && p !== MACOS_TAILSCALE_APP_BUNDLE) return false;
  }
  return true;
}
