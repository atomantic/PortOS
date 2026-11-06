/**
 * Which Homebrew package supplies a CLI, and what Homebrew itself can deliver.
 *
 * A vendor self-updater on a Homebrew install (`codex update` runs
 * `brew upgrade --cask codex`) can only reach the version Homebrew has
 * published, and that can lag the vendor's npm release by hours. Comparing such
 * a copy against npm reports an update its own updater cannot perform.
 *
 * Answers carry the package kind and name only, never the resolved path: a
 * filesystem path can embed the host account name.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { readBodyCapped } from './safeUrlFetch.js';

const MANAGED_PATH = /^(.*\/(Caskroom|Cellar)\/([\w.+@-]+)\/[^/]+)\//;
const API_TIMEOUT_MS = 12_000;
const API_MAX_BYTES = 2 * 1024 * 1024;

/** The Homebrew package owning an executable, or `null` when Homebrew does not. */
export function homebrewPackageFor(executable) {
  if (typeof executable !== 'string' || !executable) return null;
  let target = executable;
  // PATH holds a symlink into the Caskroom/Cellar, so the real target decides.
  try { target = realpathSync(executable); } catch { /* classify the path as given */ }
  const match = target.replaceAll('\\', '/').match(MANAGED_PATH);
  if (!match) return null;
  const [, packageDir, root, name] = match;
  const kind = root === 'Caskroom' ? 'cask' : 'formula';
  return { manager: 'homebrew', kind, name, thirdPartyTap: kind === 'formula' && isThirdPartyFormula(packageDir) };
}

/** A tap's formula can share a name with a different homebrew-core formula. */
function isThirdPartyFormula(kegDir) {
  try {
    const tap = JSON.parse(readFileSync(`${kegDir}/INSTALL_RECEIPT.json`, 'utf8'))?.source?.tap;
    return typeof tap === 'string' && tap !== 'homebrew/core';
  } catch {
    return false;
  }
}

/**
 * The newest version homebrew-core or homebrew-cask has published, or `null`
 * when that is not known, including for a third-party tap the API does not cover.
 */
export async function fetchHomebrewLatestVersion({ kind, name, thirdPartyTap = false }, { fetchImpl = fetchWithTimeout } = {}) {
  if (thirdPartyTap) return null;
  const url = `https://formulae.brew.sh/api/${kind === 'cask' ? 'cask' : 'formula'}/${encodeURIComponent(name)}.json`;
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error' }, API_TIMEOUT_MS);
  if (!response.ok) { await response.body?.cancel(); return null; }
  const bytes = await readBodyCapped(response, API_MAX_BYTES);
  if (!bytes) { await response.body?.cancel().catch(() => {}); return null; }
  const data = JSON.parse(bytes.toString('utf8'));
  // A cask version can carry a build suffix (`1.2.3,456`).
  const published = kind === 'cask' ? String(data?.version ?? '').split(',')[0] : data?.versions?.stable;
  // Loaded here so the runtime installer's static graph stays narrow (#6009).
  const { parseHarnessVersion } = await import('./harnessOutput.js');
  return parseHarnessVersion(published);
}
