/**
 * Resolve SSH `Host` aliases from `~/.ssh/config` to the real `HostName`.
 *
 * ## Why PortOS needs this
 *
 * The standard way to drive several GitHub accounts from one machine is a
 * per-account SSH alias:
 *
 *   # ~/.ssh/config
 *   Host github-acme
 *     HostName github.com
 *     IdentityFile ~/.ssh/id_acme
 *
 * …with the repo's origin set to `git@github-acme:acme/widget.git`. Git and ssh
 * resolve that alias transparently, so the checkout works — but every PortOS
 * code path that classifies a repo by its remote HOST sees the literal string
 * `github-acme` and gets the answer wrong:
 *
 *  - `hostToWorkTracker()` doesn't match `github.com` or `github.*`, so the app's
 *    work tracker silently degrades to PLAN.md and its GitHub issues are invisible.
 *  - `checkGhHealth({ hostname: 'github-acme' })` can't reach an API host by that
 *    name, so the CoS forge spawn gate reports the forge unreachable and HOLDS
 *    every change-request task for an hour before letting it fail — the symptom
 *    that prompted this module ("Holding task … — github-acme is unreachable").
 *  - `resolveForgeTokenEnv()` gates its token overlay on `host === 'github.com'`,
 *    so an aliased repo's agent never receives the account-pinned `GH_TOKEN` and
 *    falls back to gh's mutable active user — the "must be a collaborator" trap.
 *
 * `gh` itself resolves these aliases through the user's ssh config before it
 * picks an API host, so canonicalizing here keeps PortOS's view of a remote and
 * the CLI's view of the same remote in agreement.
 *
 * ## Scope
 *
 * Only literal `Host` → `HostName` pairs are honored. Deliberately NOT handled:
 *
 *  - Pattern aliases (`Host *.internal`, `Host !foo`) — a wildcard alias never
 *    appears verbatim in a remote URL, so matching one would require re-
 *    implementing ssh's matcher for no gain here.
 *  - `Match` blocks and `Include` directives — both can make resolution depend on
 *    the connecting user, the local network, or another file entirely. A remote's
 *    forge identity must not change under PortOS with the network it is on, so an
 *    alias we cannot resolve unconditionally is left alone.
 *  - `HostName` values containing ssh's `%` tokens (`%h`, `%n`) — those expand at
 *    connect time, not parse time.
 *
 * Anything unresolved passes through unchanged, so a plain `github.com` remote,
 * an enterprise host, and an alias we decline to interpret all behave exactly as
 * they did before this module existed.
 */

import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Re-stat the config at most this often. The map is read from remote-URL parsers
// that run on ordinary request paths, and an ssh config changes about as often as
// a new machine is set up — a stat per parse would be pure overhead.
const STAT_TTL_MS = 5000;

const WILDCARD = /[*?!]/;

let cache = null; // { key, aliases: Map }
let lastStatAt = 0;

/**
 * Parse ssh-config text into a `Map` of lowercased alias → canonical `HostName`.
 *
 * Exported for tests and for callers that already hold the config text; the
 * cached filesystem read lives in `resolveSshHostAlias`.
 *
 * @param {string} text - contents of an ssh config file
 * @returns {Map<string, string>}
 */
export function parseSshHostAliases(text) {
  const aliases = new Map();
  if (!text || typeof text !== 'string') return aliases;

  // ssh config is line-oriented; a keyword and its value may be separated by
  // whitespace or `=`. Host patterns accumulate until the next `Host`/`Match`
  // block starts, and `Match` ends the current block WITHOUT opening one we
  // honor — otherwise a `HostName` under `Match` would be attributed to the
  // Host block above it.
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
    // `%h` and friends expand at connect time against the alias itself; there is
    // no stable canonical host to record for them.
    if (value.includes('%')) continue;
    // A `user@host` HostName is legal in some configs; only the host half is the
    // forge identity.
    const hostName = value.includes('@') ? value.slice(value.lastIndexOf('@') + 1) : value;
    if (!hostName) continue;
    for (const alias of current) {
      // First declaration wins, matching ssh's own "first obtained value" rule.
      if (!aliases.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), hostName);
    }
  }
  return aliases;
}

/**
 * The alias map from `~/.ssh/config`, memoized on the file's size+mtime and
 * re-validated at most once per `STAT_TTL_MS`.
 *
 * A missing or unreadable config is an empty map, not an error: the overwhelming
 * majority of installs have no aliases and must not pay a throw for it.
 */
function loadAliases() {
  const now = Date.now();
  if (cache && now - lastStatAt < STAT_TTL_MS) return cache.aliases;

  const path = join(homedir(), '.ssh', 'config');
  // Sync + guarded: this sits inside synchronous remote-URL parsers, and every
  // failure mode (no file, no permission, a directory) means the same thing —
  // "this install has no aliases to honor".
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
