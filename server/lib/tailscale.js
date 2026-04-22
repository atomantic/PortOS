import { existsSync } from 'fs';
import { join, delimiter } from 'path';

// Paths where the Tailscale CLI binary is commonly found. On macOS the GUI app
// doesn't put the CLI in PATH by default; Homebrew installs to /usr/local/bin
// (Intel) or /opt/homebrew/bin (Apple Silicon); Linux packages land in /usr/bin.
const TAILSCALE_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale'
];

export function findTailscale() {
  for (const p of TAILSCALE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  // Use path.delimiter (';' on Windows, ':' elsewhere) so PATH scanning works cross-platform.
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'tailscale');
    if (existsSync(p)) return p;
  }
  return null;
}
