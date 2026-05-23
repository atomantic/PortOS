import { existsSync } from 'fs';
import { join, delimiter } from 'path';

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
