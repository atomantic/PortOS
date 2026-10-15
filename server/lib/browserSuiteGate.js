import { execFileSync } from './childProcess.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keep cross-workspace browser suites as visible skips on machines without
 * Chrome, ffmpeg or the client workspace, while letting the one CI job that
 * provisions them fail fast instead of passing green on a skip.
 *
 * `prerequisites` maps a human label to whatever was discovered (a path, a
 * resolved bundler list, or undefined/null when absent). `onUnavailable` runs
 * before the skip or the throw: prerequisite discovery can initialize mocked
 * path fixtures, and Vitest runs no cleanup hooks for a skipped (or failed) file.
 */
export function browserSuiteCanRun(label, prerequisites, { onUnavailable } = {}) {
  const missing = Object.entries(prerequisites).filter(([, found]) => !found).map(([name]) => name);
  if (missing.length === 0) return true;

  onUnavailable?.();
  const reason = `missing ${missing.join(', ')}`;
  if (process.env.PORTOS_REQUIRE_BROWSER_SUITES) {
    throw new Error(`${label}: browser suite skipped but PORTOS_REQUIRE_BROWSER_SUITES is set — ${reason}`);
  }

  console.log(`⏭️ ${label}: skipping suite — ${reason}`);
  return false;
}

const H264_PROBE_PAGE = `data:text/html,<body><script>document.body.textContent='H264:'+document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')</script></body>`;

/**
 * Whether a Chrome binary can decode H.264 (Playwright's bundled Chromium has
 * no proprietary codecs). Returns the binary path when it can, else null, so it
 * drops straight into a `browserSuiteCanRun` prerequisite map. A binary that
 * fails to launch or answer counts as unable.
 */
export function chromeWithH264(chromePath) {
  if (!chromePath) return null;
  const profile = mkdtempSync(join(tmpdir(), 'portos-h264-probe-'));
  try {
    const dom = execFileSync(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${profile}`, '--virtual-time-budget=2000', '--dump-dom', H264_PROBE_PAGE],
    { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /H264:\w+/.test(dom) ? chromePath : null;
  } catch {
    return null;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
