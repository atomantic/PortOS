import { existsSync } from 'fs';
import { join, delimiter } from 'path';

const IS_WIN = process.platform === 'win32';
const TAILSCALE_BIN = IS_WIN ? 'tailscale.exe' : 'tailscale';

// Paths where the Tailscale CLI binary is commonly found. On macOS the GUI app
// doesn't put the CLI in PATH by default; Homebrew installs to /usr/local/bin
// (Intel) or /opt/homebrew/bin (Apple Silicon); Linux packages land in /usr/bin;
// Windows installs land in Program Files.
const TAILSCALE_CANDIDATES = IS_WIN
  ? [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
    ]
  : [
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
    const p = join(dir, TAILSCALE_BIN);
    if (existsSync(p)) return p;
  }
  return null;
}
