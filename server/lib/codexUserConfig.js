/**
 * Read-only view of the user's own `~/.codex/config.toml` model routing.
 *
 * WHY THIS EXISTS. Third-party bridges re-point the Codex CLI by writing
 * top-level routing keys (base URL, model provider, model catalog) into that
 * file, so every `codex` spawn, PortOS's included, runs through it while the
 * AI Providers card still reports the ChatGPT account's readiness and quota.
 * This module lets PortOS say so.
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

/** Strip a TOML scalar's quotes; non-string returns null. Triple quotes must be tried FIRST or `"""x"""` matches the empty string `""`. */
const stringValue = (raw) => {
  const trimmed = String(raw ?? '').trim();
  const tripled = /^"""([\s\S]*)"""$|^'''([\s\S]*)'''$/.exec(trimmed);
  if (tripled) return tripled[1] ?? tripled[2];
  const quoted = /^"([^"]*)"|^'([^']*)'/.exec(trimmed);
  return quoted ? (quoted[1] ?? quoted[2]) : null;
};

/**
 * Which routing keys `tomlText` assigns at the top level, and the base URL it
 * points at. Pure.
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
      // Everything after the first table header belongs to that table.
      inTable = true;
      continue;
    }
    const match = KEY_ASSIGNMENT.exec(line);
    if (!match) continue;
    const value = match[4];
    const fence = /^("""|''')/.exec(value.trim());
    // An unclosed multi-line string swallows following lines, so quoted text in a prompt isn't read as an assignment.
    if (fence && value.trim().indexOf(fence[1], fence[1].length) === -1) openHeredoc = fence[1];
    if (inTable) continue;
    const key = match[1] ?? match[2] ?? match[3];
    if (!CODEX_ROUTING_KEYS.includes(key)) continue;
    if (!keys.includes(key)) keys.push(key);
    if (key === 'openai_base_url' && baseUrl === null) baseUrl = stringValue(value);
  }
  return { overridden: keys.length > 0, keys, baseUrl };
}

// TTL cache: `GET /api/providers` is polled; short enough that file edits show within one refresh.
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
    // ENOENT is a definite "no override"; anything else is "could not tell" (null).
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
