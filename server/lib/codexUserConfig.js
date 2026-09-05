/**
 * Read-only view of the user's own `~/.codex/config.toml` model routing.
 *
 * WHY THIS EXISTS. Third-party bridges re-point the Codex CLI by writing
 * top-level routing keys — a base URL, a named model provider, a model catalog
 * — into that file. Every `codex` invocation on the machine then runs through
 * whatever the file names, PortOS's own spawns included, while the AI Providers
 * card keeps reporting the signed-in ChatGPT account's readiness and the quota
 * meters keep reporting that account's limits. Nothing is wrong with choosing
 * such a bridge; the failure is that PortOS reports one thing and does another.
 * This module is what lets it say so.
 *
 * READ ONLY, ALWAYS. Never write, repair, or migrate this file — it is the
 * user's, several tools edit it, and a rewrite by PortOS can silently unpick
 * somebody else's install. Detection is a read and a report, never a fix and
 * never a fail-closed prerequisite.
 *
 * MACHINE-LOCAL. `baseUrl` can embed a host name or a port, so it is the
 * user's private data (root AGENTS.md, Sensitive Data & Privacy): render it in
 * the local UI, never log it, never persist it, and never let it cross
 * federation.
 *
 * A few anchored line matches, deliberately not a TOML parser: the question is
 * only whether one of three well-known keys is assigned at the TOP level, and a
 * dependency to answer it would be a poor trade.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Codex's config directory, honoring the CLI's own `CODEX_HOME` override. */
export const codexHomeDir = () => process.env.CODEX_HOME || join(homedir(), '.codex');

/**
 * The top-level keys that re-point where Codex sends model traffic. A key of
 * the same name inside a `[table]` is a DIFFERENT setting (per-provider
 * configuration Codex only uses when that provider is selected) and must not
 * trip the badge.
 */
export const CODEX_ROUTING_KEYS = Object.freeze(['openai_base_url', 'model_provider', 'model_catalog_json']);

const KEY_ASSIGNMENT = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/;
const TABLE_HEADER = /^\s*\[/;

/** Strip a TOML scalar's surrounding quotes; a non-string value returns null. */
const stringValue = (raw) => {
  const trimmed = String(raw ?? '').trim();
  const quoted = /^"([^"]*)"|^'([^']*)'/.exec(trimmed);
  return quoted ? (quoted[1] ?? quoted[2]) : null;
};

/**
 * Which routing keys `tomlText` assigns at the top level, and the base URL it
 * points at. Pure — exported for tests.
 *
 * @returns {{overridden: boolean, keys: string[], baseUrl: string|null}}
 */
export function parseCodexRoutingOverride(tomlText) {
  const keys = [];
  let baseUrl = null;
  let inTable = false;
  let openHeredoc = null; // the `"""` / `'''` fence a multi-line string is inside
  for (const line of String(tomlText || '').split('\n')) {
    if (openHeredoc) {
      if (line.includes(openHeredoc)) openHeredoc = null;
      continue;
    }
    const stripped = line.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;
    if (TABLE_HEADER.test(line)) {
      // Everything after the first table header belongs to that table, so no
      // later assignment is top-level however the file is ordered.
      inTable = true;
      continue;
    }
    const match = KEY_ASSIGNMENT.exec(line);
    if (!match) continue;
    const value = match[4];
    const fence = /^("""|''')/.exec(value.trim());
    // A multi-line string opened and not closed on this line swallows the lines
    // that follow — otherwise a base URL quoted inside a prompt would read as
    // an assignment.
    if (fence && value.trim().indexOf(fence[1], fence[1].length) === -1) openHeredoc = fence[1];
    if (inTable) continue;
    const key = match[1] ?? match[2] ?? match[3];
    if (!CODEX_ROUTING_KEYS.includes(key)) continue;
    if (!keys.includes(key)) keys.push(key);
    if (key === 'openai_base_url' && baseUrl === null) baseUrl = stringValue(value);
  }
  return { overridden: keys.length > 0, keys, baseUrl };
}

// Cache-only reads: `GET /api/providers` is polled, and re-reading the file per
// request would be a syscall per card. Short enough that a user who edits the
// file sees the badge follow within one refresh.
const SNAPSHOT_TTL_MS = 10_000;
let cached = null;
let cachedAt = 0;

/**
 * The install's current Codex routing snapshot, or `null` for NOT DETERMINED.
 *
 * `null` is a real sentinel and must never be painted as "not overridden": it
 * means the file exists but could not be read (permissions, a mid-write
 * truncation). A file that is simply ABSENT is a definite answer — Codex is
 * using its own defaults — and comes back as `overridden: false`.
 *
 * @param {object} [options]
 * @param {string} [options.codexHome] — override the config directory (tests)
 * @param {boolean} [options.force] — bypass the TTL cache
 * @returns {{overridden: boolean, keys: string[], baseUrl: string|null}|null}
 */
export function readCodexRoutingOverride({ codexHome = null, force = false } = {}) {
  const home = codexHome || codexHomeDir();
  const now = Date.now();
  if (!codexHome && !force && cachedAt > 0 && now - cachedAt < SNAPSHOT_TTL_MS) return cached;
  let snapshot;
  try {
    snapshot = parseCodexRoutingOverride(readFileSync(join(home, 'config.toml'), 'utf8'));
  } catch (err) {
    // ENOENT is an answer ("no user config, so no override"); anything else is
    // "could not tell", which the sentinel above keeps distinct.
    snapshot = err?.code === 'ENOENT' ? { overridden: false, keys: [], baseUrl: null } : null;
  }
  if (!codexHome) {
    cached = snapshot;
    cachedAt = now;
  }
  return snapshot;
}

/** Test-only: drop the TTL cache so a suite isn't order-dependent. */
export function __resetCodexRoutingCache() {
  cached = null;
  cachedAt = 0;
}
