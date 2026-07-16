/**
 * viteAllowedHosts — detect and remediate Vite's `server.allowedHosts` block in a
 * managed app's config.
 *
 * Why this exists: PortOS is served over a Tailscale MagicDNS name (e.g.
 * `box.taile8179.ts.net`). When a managed app's Dev UI is launched, the browser
 * hits the app's Vite dev server at that same hostname — and Vite ≥5 rejects it
 * with "Blocked request. This host ("…") is not allowed. … add it to
 * server.allowedHosts in vite.config.js" unless the host is allow-listed.
 *
 * These pure helpers locate the app's vite config, read its current
 * `allowedHosts` setting, decide whether a given hostname would be accepted, and
 * deterministically rewrite the config to allow all hosts. When the config shape
 * is too unusual to rewrite safely the rewrite bails (`ok: false`) so the caller
 * can fall back to an LLM-assisted fix instead of corrupting the file.
 */
import { join } from 'path';
import { readdir } from 'fs/promises';
import { tryReadFile } from './fileUtils.js';

// Vite resolves its config from any of these (TS variants included). Order
// mirrors Vite's own resolution preference (js/mjs/ts first).
export const VITE_CONFIG_FILENAMES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cjs',
  'vite.config.cts'
];

/**
 * Strip `//` line and `/* *\/` block comments so detection/rewrite logic never
 * matches a commented-out `allowedHosts`. Intentionally simple — it does not
 * parse strings, so a `//` inside a string literal would be over-stripped; that
 * only ever makes detection MORE conservative (we treat the host as not-allowed
 * and offer remediation), never less safe.
 */
function stripComments(source) {
  return String(source ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const ALLOWED_HOSTS_VALUE_RE =
  /allowedHosts\s*:\s*(true|false|'all'|"all"|`all`|\[[^\]]*\])/;

/**
 * Parse the current `server.allowedHosts` value out of a vite config source.
 * Returns `{ present, allowsAll, hosts, raw }`:
 *   - present  — an `allowedHosts:` key was found
 *   - allowsAll — value is `true` or the `'all'` sentinel (every host accepted)
 *   - hosts    — string entries when the value is an array literal
 */
export function parseAllowedHosts(source) {
  const code = stripComments(source);
  const m = code.match(ALLOWED_HOSTS_VALUE_RE);
  if (!m) return { present: false, allowsAll: false, hosts: [] };
  const raw = m[1];
  if (raw === 'true') return { present: true, allowsAll: true, hosts: [], raw };
  if (raw === 'false') return { present: true, allowsAll: false, hosts: [], raw };
  if (/^['"`]all['"`]$/.test(raw)) return { present: true, allowsAll: true, hosts: [], raw };
  const hosts = [...raw.matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
  return { present: true, allowsAll: false, hosts, raw };
}

/** True when `hostname` is an IPv4/IPv6 literal or bracketed IPv6. */
function isIpLiteral(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  if (h.includes(':') && /^[0-9a-f:]+$/i.test(h)) return true; // IPv6
  return false;
}

/**
 * Decide whether Vite would accept a request for `hostname` given a parsed
 * allowedHosts setting. Mirrors Vite's own host-check rules:
 *   - `localhost` and IP literals are always accepted (Vite never blocks them);
 *   - `allowedHosts: true` / `'all'` accepts everything;
 *   - an exact match in the array accepts that host;
 *   - a leading-dot entry (`.ts.net`) accepts the bare domain and any subdomain.
 */
export function hostIsAllowed(parsed, hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  // Vite always allows loopback/IP hosts regardless of allowedHosts — this is
  // why "launch by IP" is a valid escape hatch for the user.
  if (h === 'localhost' || h.endsWith('.localhost') || isIpLiteral(h)) return true;
  if (parsed.allowsAll) return true;
  return (parsed.hosts || []).some((entry) => {
    const e = String(entry).toLowerCase();
    if (e === h) return true;
    if (e.startsWith('.')) return h === e.slice(1) || h.endsWith(e);
    return false;
  });
}

// Common locations a vite config sits in relative to an app's repo root. Many
// PortOS-managed apps are monorepos whose Vite client lives under `client/`
// (PortOS itself does), so the repo root alone misses them. This is only a
// fast-path ordering hint — `findViteConfig` falls back to a bounded recursive
// scan (`discoverViteConfig`) so a config in an unlisted subdir (e.g. `admin/`)
// is still found instead of reporting a false "no vite.config" warning.
const VITE_CONFIG_SUBDIRS = ['', 'client', 'frontend', 'web', 'app', 'ui', 'admin', 'apps/web', 'packages/client'];

// Directories that never hold an app's own vite config but are expensive to walk
// (or would surface a dependency's config). Skipped by the recursive fallback.
const VITE_SCAN_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.vite', 'tmp', 'temp', 'vendor', '.venv'
]);

/**
 * Breadth-first scan for a vite config under `root`, skipping heavy/vendor dirs.
 * Breadth-first so the shallowest (most likely the app's own) config wins, and
 * bounded by `maxDepth` so a deep monorepo can't turn this into a full-tree walk.
 * Returns the same `{ path, filename, dir }` shape as `findViteConfig` (content
 * read by the caller), or `null` when nothing is found within the depth budget.
 */
async function discoverViteConfig(root, { maxDepth = 3 } = {}) {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!entries) continue;
      // Match a config file at this level before descending, so shallower wins.
      for (const filename of VITE_CONFIG_FILENAMES) {
        if (entries.some((e) => e.isFile() && e.name === filename)) {
          return { path: join(dir, filename), filename, dir };
        }
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && !VITE_SCAN_IGNORE_DIRS.has(e.name)) {
          next.push(join(dir, e.name));
        }
      }
    }
    level = next;
  }
  return null;
}

/**
 * Locate an app's vite config on disk. Returns `{ path, filename, content, dir }`
 * for the first match, or `null` when no vite config is found (a non-Vite app,
 * or one whose Dev UI launches a different dev server).
 *
 * Searches `extraDirs` first (e.g. the cwd of the app's detected Vite process),
 * then the repo root and a set of common subdirectories.
 */
export async function findViteConfig(repoPath, { extraDirs = [] } = {}) {
  const dirs = [];
  for (const d of extraDirs) if (d && !dirs.includes(d)) dirs.push(d);
  if (repoPath) {
    for (const sub of VITE_CONFIG_SUBDIRS) {
      const d = sub ? join(repoPath, sub) : repoPath;
      if (!dirs.includes(d)) dirs.push(d);
    }
  }
  for (const dir of dirs) {
    for (const filename of VITE_CONFIG_FILENAMES) {
      const path = join(dir, filename);
      const content = await tryReadFile(path);
      if (content != null) return { path, filename, content, dir };
    }
  }
  // Fast-path subdirs missed it — fall back to a bounded recursive scan so a
  // config in an unlisted subdir (critical-mass keeps its Vite client in
  // `admin/`) is still detected instead of a false "no vite.config" warning.
  if (repoPath) {
    const found = await discoverViteConfig(repoPath);
    if (found) {
      const content = await tryReadFile(found.path);
      if (content != null) return { ...found, content };
    }
  }
  return null;
}

/**
 * Deterministically rewrite a vite config so every host is allowed
 * (`server.allowedHosts: true`). Handles the three common shapes:
 *   1. An existing `allowedHosts:` value → replace it with `true`.
 *   2. An existing `server: { … }` block → inject `allowedHosts: true,`.
 *   3. A `defineConfig({ … })` / `defineConfig(() => ({ … }))` object with no
 *      `server` block → inject `server: { allowedHosts: true },`.
 *
 * Bails with `{ ok: false, reason }` when the shape is ambiguous (multiple
 * `allowedHosts`/`server` blocks) or unrecognized, so the caller falls back to
 * an LLM fix rather than risk corrupting the config.
 */
export function rewriteAllowedHosts(source) {
  const original = String(source ?? '');
  const code = stripComments(original);

  // Case 1: an allowedHosts key already exists. Replace its value in the
  // ORIGINAL text (preserving comments) — but only when unambiguous.
  const allowedHostsCount = (code.match(/allowedHosts\s*:/g) || []).length;
  if (allowedHostsCount > 1) {
    return { ok: false, reason: 'multiple allowedHosts entries — ambiguous to rewrite safely' };
  }
  if (allowedHostsCount === 1) {
    if (/allowedHosts\s*:\s*(?:true|'all'|"all"|`all`)/.test(code)) {
      return { ok: false, reason: 'already allows all hosts' };
    }
    const content = original.replace(ALLOWED_HOSTS_VALUE_RE, 'allowedHosts: true');
    if (content === original) {
      return { ok: false, reason: 'allowedHosts present in an unrecognized form' };
    }
    return { ok: true, content, strategy: 'replace-value' };
  }

  // Case 2: a single server: { … } block exists — inject the key after `{`.
  const serverBlockCount = (code.match(/\bserver\s*:\s*\{/g) || []).length;
  if (serverBlockCount > 1) {
    return { ok: false, reason: 'multiple server blocks — ambiguous to rewrite safely' };
  }
  if (serverBlockCount === 1) {
    const content = original.replace(
      /(\bserver\s*:\s*\{)/,
      '$1\n    allowedHosts: true,'
    );
    return { ok: true, content, strategy: 'inject-into-server' };
  }

  // Case 3: a defineConfig({ … }) object (literal or arrow-returned) with no
  // server block — add one. Matches `defineConfig({`, `defineConfig(() => ({`,
  // and `defineConfig(async ({ mode }) => ({`.
  const objectStart = code.match(
    /defineConfig\s*\(\s*(?:async\s*)?(?:\([^)]*\)\s*=>\s*)?\(?\s*\{/
  );
  if (objectStart) {
    const content = original.replace(
      /(defineConfig\s*\(\s*(?:async\s*)?(?:\([^)]*\)\s*=>\s*)?\(?\s*\{)/,
      '$1\n  server: { allowedHosts: true },'
    );
    if (content !== original) {
      return { ok: true, content, strategy: 'inject-server-block' };
    }
  }

  return { ok: false, reason: 'could not locate a config object to edit' };
}

/**
 * One-shot status for a repo + hostname: locate the vite config, parse its
 * allowedHosts, and report whether `hostname` would be accepted plus whether a
 * deterministic auto-fix is possible. Pure aside from the config read.
 */
export async function checkViteHost(repoPath, hostname, { extraDirs = [] } = {}) {
  const config = await findViteConfig(repoPath, { extraDirs });
  if (!config) {
    return {
      hasViteConfig: false,
      configPath: null,
      filename: null,
      allowedHostsPresent: false,
      allowsAll: false,
      hosts: [],
      hostAllowed: false,
      canAutoFix: false
    };
  }
  const parsed = parseAllowedHosts(config.content);
  const hostAllowed = hostIsAllowed(parsed, hostname);
  const rewrite = hostAllowed ? { ok: false } : rewriteAllowedHosts(config.content);
  return {
    hasViteConfig: true,
    configPath: config.path,
    filename: config.filename,
    allowedHostsPresent: parsed.present,
    allowsAll: parsed.allowsAll,
    hosts: parsed.hosts,
    hostAllowed,
    canAutoFix: !hostAllowed && rewrite.ok === true
  };
}
