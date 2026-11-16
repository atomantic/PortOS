/**
  * Resolve SSH `Host` aliases from `~/.ssh/config` to the real `HostName` (`resolveSshHostAlias`, `parseSshHostAliases`).
  *
  * Multi-account setups use a per-account alias (`Host github-acme` / `HostName github.com` / `IdentityFile ~/.ssh/id_acme`, origin `git@github-acme:acme/widget.git`); git and ssh resolve it, but every PortOS path classifying a repo by remote HOST sees `github-acme` and errs: `hostToWorkTracker()` degrades the work tracker to PLAN.md (GitHub issues invisible); `checkGhHealth({ hostname: 'github-acme' })` can't reach it, so the CoS forge spawn gate HOLDS every change-request task an hour ("Holding task … — github-acme is unreachable"); `resolveForgeTokenEnv()` gates its overlay on `host === 'github.com'`, so the agent misses the account-pinned `GH_TOKEN` and falls to gh's mutable active user. `gh` itself resolves aliases through ssh config, so every remote-URL host parser (`gitForge.parseGitRemote`, `gitRemote.parseGitRemoteUrl`, `workTracker.hostFromOriginUrl`) canonicalizes through here to agree with the CLI.
 *
 * Scope: only literal `Host` → `HostName` pairs. NOT handled: pattern aliases (`Host *.internal`, `Host !foo`: never verbatim in a remote URL, and matching would reimplement ssh's matcher); `Match` blocks and `Include` directives
 * (resolution could depend on user, network or another file, and a remote's forge identity must not change with the network); `HostName` values with ssh `%` tokens (`%h`, `%n`: expanded at connect time).
 * Anything unresolved passes through unchanged.
 */

import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Re-stat the config at most this often: parsers run on ordinary request paths and an ssh config changes about as often as a machine is set up.
const STAT_TTL_MS = 5000;

const WILDCARD = /[*?!]/;

let cache = null; // { key, aliases: Map }
let lastStatAt = 0;

/**
 * Parse ssh-config text into a `Map` of lowercased alias → canonical `HostName`. Exported for tests and callers holding the text; the cached filesystem read lives in `resolveSshHostAlias`.
 *
 * @param {string} text - contents of an ssh config file
 * @returns {Map<string, string>}
 */
export function parseSshHostAliases(text) {
  const aliases = new Map();
  if (!text || typeof text !== 'string') return aliases;

  // Line-oriented; keyword and value may be separated by whitespace or `=`. Host patterns accumulate until the next `Host`/`Match`; `Match` ends the block WITHOUT opening one we honor (a `HostName` under `Match` must not attach to the Host above).
  let current = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^(\w+)(?:\s*=\s*|\s+)(.+)$/);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();

    if (keyword === 'match') { current = []; continue; }
    if (keyword === 'host') {
      current = value.split(/\s+/).filter(name => name && !WILDCARD.test(name));
      continue;
    }
    if (keyword !== 'hostname' || !current.length) continue;
    // `%h` and friends expand at connect time against the alias itself; no stable canonical host to record.
    if (value.includes('%')) continue;
    // A `user@host` HostName is legal; only the host half is the forge identity.
    const hostName = value.includes('@') ? value.slice(value.lastIndexOf('@') + 1) : value;
    if (!hostName) continue;
    for (const alias of current) {
      // First declaration wins, matching ssh's own "first obtained value" rule.
      if (!aliases.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), hostName);
    }
  }
  return aliases;
}

/** The alias map from `~/.ssh/config`, memoized on size+mtime and re-validated at most once per `STAT_TTL_MS`. A missing/unreadable config is an empty map, not an error (most installs have no aliases). */
function loadAliases() {
  const now = Date.now();
  if (cache && now - lastStatAt < STAT_TTL_MS) return cache.aliases;

  const path = join(homedir(), '.ssh', 'config');
  // Sync + guarded: it sits in synchronous remote-URL parsers and every failure (no file, no permission, a directory) means "no aliases to honor".
  let key = null;
  try {
    const stats = statSync(path);
    key = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    key = null;
  }
  lastStatAt = now;
  if (cache && cache.key === key) return cache.aliases;

  let aliases = new Map();
  if (key !== null) {
    try {
      aliases = parseSshHostAliases(readFileSync(path, 'utf8'));
    } catch {
      aliases = new Map();
    }
  }
  cache = { key, aliases };
  return aliases;
}

/**
 * Canonicalize a git-remote host through the user's ssh `Host` aliases.
 *
 * @param {string|null|undefined} host - host as it appears in the remote URL
 * @returns {string|null|undefined} the aliased `HostName`, or `host` unchanged
 */
export function resolveSshHostAlias(host) {
  if (!host || typeof host !== 'string') return host;
  return loadAliases().get(host.toLowerCase()) || host;
}

/** Test seam — drops the memoized ssh-config read. */
export function __resetSshHostAliasCache() {
  cache = null;
  lastStatAt = 0;
}
