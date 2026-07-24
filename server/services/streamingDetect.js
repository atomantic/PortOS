import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execPm2 } from './pm2.js';
import { safeJSONParse, tryReadFile, atomicWrite } from '../lib/fileUtils.js';
import { detectAppIcon } from './appIconDetect.js';

/** App types that do not use PM2 for process management */
export const NON_PM2_TYPES = new Set(['ios-native', 'macos-native', 'xcode', 'swift']);

/**
 * App types that run a GUI/desktop process with no HTTP port (e.g. a Godot
 * game binary). These are still supervised through PM2, but launched from the
 * app's own `startCommands` — never an ecosystem web-server config — and with
 * autorestart OFF: the user closing the window is a NORMAL exit (code 0), not a
 * crash to relaunch. Port-dependent surfaces (Open UI, HTTP probes) branch on
 * "has a port" rather than assuming one.
 */
export const DESKTOP_TYPES = new Set(['desktop']);

/** Check if an app type is a portless GUI/desktop process. */
export const isDesktopType = (type) => DESKTOP_TYPES.has(type);

/**
 * Ecosystem config filenames in the order they're resolved. The READER
 * (parseEcosystemFromPath) and the WRITER (writeEcosystemPorts) must agree on
 * this order: if a repo has both, the writer has to rewrite the same file the
 * reader derives ports from, or a port edit lands in a file detection ignores
 * and silently reverts on the next refresh.
 */
const ECOSYSTEM_CONFIG_FILENAMES = ['ecosystem.config.js', 'ecosystem.config.cjs'];

/** Check if an app type uses PM2 for process management */
export const usesPm2 = (type) => !NON_PM2_TYPES.has(type);

/**
 * Count the run of consecutive backslashes immediately before `idx`.
 * An odd count means the character at `idx` is escaped; even (including 0)
 * means it isn't — `\"` is an escaped quote, but `\\"` is an escaped backslash
 * followed by a real quote.
 */
function isEscaped(content, idx) {
  let count = 0;
  for (let i = idx - 1; i >= 0 && content[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

/**
 * Find the index of the `}` that matches the `{` at `openBraceIdx`, ignoring
 * braces inside strings (single/double/backtick) and JS comments. Returns -1
 * if no match. Backticks are treated as opaque so `${...}` interpolations
 * don't perturb the depth count of the surrounding object.
 */
function findMatchingBrace(content, openBraceIdx) {
  let depth = 0;
  let inString = false;
  let stringChar = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBraceIdx; i < content.length; i++) {
    const char = content[i];
    const nextChar = i < content.length - 1 ? content[i + 1] : '';

    if (!inString && !inBlockComment && char === '/' && nextChar === '/') { inLineComment = true; continue; }
    if (inLineComment && char === '\n') { inLineComment = false; continue; }
    if (!inString && !inLineComment && char === '/' && nextChar === '*') { inBlockComment = true; continue; }
    if (inBlockComment && char === '*' && nextChar === '/') { inBlockComment = false; i++; continue; }
    if (inLineComment || inBlockComment) continue;

    if ((char === '"' || char === "'" || char === '`') && !isEscaped(content, i)) {
      if (!inString) { inString = true; stringChar = char; }
      else if (char === stringChar) { inString = false; stringChar = null; }
    }

    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Parse ecosystem.config.js/cjs to extract all processes with their ports
 * Uses regex parsing since we can't safely execute arbitrary JS
 * @returns {{ processes: Array, pm2Home: string|null }}
 */
export function parseEcosystemConfig(content) {
  const processes = [];
  let pm2Home = null;

  // Extract PM2_HOME constant if defined (e.g., const PM2_HOME = `${require("os").homedir()}/.pm2-grace`)
  // First try template literals (backticks) which can contain nested quotes
  const templateMatch = content.match(/(?:const|let|var)\s+PM2_HOME\s*=\s*`([^`]+)`/);
  if (templateMatch) {
    let homePath = templateMatch[1];
    // Replace common template expressions
    homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.homedir\(\)\}/g, homedir());
    homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.userInfo\(\)\.username\}/g, process.env.USER || 'user');
    homePath = homePath.replace(/\$\{process\.env\.HOME\}/g, homedir());
    pm2Home = homePath;
  } else {
    // Try regular string literals
    const stringMatch = content.match(/(?:const|let|var)\s+PM2_HOME\s*=\s*['"]([^'"]+)['"]/);
    if (stringMatch) {
      pm2Home = stringMatch[1];
    } else {
      // Check for PM2_HOME in env blocks
      const envPm2HomeMatch = content.match(/PM2_HOME\s*:\s*PM2_HOME/);
      if (envPm2HomeMatch) {
        // PM2_HOME is used but defined as a variable - try template literal first
        const varTemplateMatch = content.match(/PM2_HOME\s*=\s*`([^`]+)`/);
        if (varTemplateMatch) {
          let homePath = varTemplateMatch[1];
          homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.homedir\(\)\}/g, homedir());
          homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.userInfo\(\)\.username\}/g, process.env.USER || 'user');
          pm2Home = homePath;
        }
      }
    }
  }

  // Extract top-level port constants (e.g., const CDP_PORT = 5549)
  const portConstants = {};
  const constMatches = content.matchAll(/(?:const|let|var)\s+(\w*PORT\w*)\s*=\s*(\d+)/g);
  for (const match of constMatches) {
    portConstants[match[1]] = parseInt(match[2], 10);
  }

  // Extract PORTS object - handles both flat and nested structures
  // Flat: const PORTS = { WEB: 5550, API: 5551 }
  // Nested: const PORTS = { server: { api: 5555 }, client: { ui: 5554 } }
  const portsObjStart = content.match(/(?:const|let|var)\s+PORTS\s*=\s*\{/);
  if (portsObjStart) {
    const startIdx = portsObjStart.index + portsObjStart[0].length - 1;
    let braceCount = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < content.length; i++) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          endIdx = i;
          break;
        }
      }
    }
    const portsBlock = content.substring(startIdx, endIdx + 1);

    // Parse flat entries: KEY: 5550
    const flatEntries = portsBlock.matchAll(/(\w+)\s*:\s*(\d+)/g);
    for (const entry of flatEntries) {
      portConstants[`PORTS.${entry[1]}`] = parseInt(entry[2], 10);
    }

    // Parse nested entries: key: { subkey: 5550 }
    const nestedMatches = portsBlock.matchAll(/(\w+)\s*:\s*\{([^}]+)\}/g);
    for (const nestedMatch of nestedMatches) {
      const parentKey = nestedMatch[1];
      const nestedContent = nestedMatch[2];
      const nestedPorts = {};
      const subEntries = nestedContent.matchAll(/(\w+)\s*:\s*(\d+)/g);
      for (const subEntry of subEntries) {
        const port = parseInt(subEntry[2], 10);
        portConstants[`PORTS.${parentKey}.${subEntry[1]}`] = port;
        nestedPorts[subEntry[1]] = port;
      }
      // Also store the whole nested object for `ports: PORTS.server` references
      portConstants[`PORTS.${parentKey}`] = nestedPorts;
    }
  }

  // Match each app block: { name: '...', ... }
  // This regex captures app objects including nested braces
  const appBlockRegex = /\{\s*name\s*:\s*['"]([^'"]+)['"]/g;
  let match;
  let lastIndex = 0;

  while ((match = appBlockRegex.exec(content)) !== null) {
    const processName = match[1];
    const startPos = match.index;

    // Find the end of this app block by counting braces
    let braceCount = 0;
    let endPos = startPos;
    let inString = false;
    let stringChar = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = startPos; i < content.length; i++) {
      const char = content[i];
      const nextChar = i < content.length - 1 ? content[i + 1] : '';

      // Handle line comments (// ...)
      if (!inString && !inBlockComment && char === '/' && nextChar === '/') {
        inLineComment = true;
        continue;
      }
      if (inLineComment && char === '\n') {
        inLineComment = false;
        continue;
      }

      // Handle block comments (/* ... */)
      if (!inString && !inLineComment && char === '/' && nextChar === '*') {
        inBlockComment = true;
        continue;
      }
      if (inBlockComment && char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++; // Skip the closing /
        continue;
      }

      // Skip if in any comment
      if (inLineComment || inBlockComment) continue;

      // Backticks count as string delimiters so `${...}` braces don't perturb
      // the count. Use isEscaped() so an even-length backslash run before a
      // quote (e.g. `\\"`) correctly reads as not-escaped.
      if ((char === '"' || char === "'" || char === '`') && !isEscaped(content, i)) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
          stringChar = null;
        }
      }

      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            endPos = i;
            break;
          }
        }
      }
    }

    const appBlock = content.substring(startPos, endPos + 1);

    // Extract ports - first try the PortOS standard 'ports' object
    let ports = {};

    // Look for ports: { label: port, ... } object with literal values
    const portsObjMatch = appBlock.match(/\bports\s*:\s*\{([^}]+)\}/);
    if (portsObjMatch) {
      const portsContent = portsObjMatch[1];
      const portEntries = portsContent.matchAll(/(\w+)\s*:\s*(\d+)/g);
      for (const entry of portEntries) {
        ports[entry[1]] = parseInt(entry[2], 10);
      }
    }

    // Look for ports: VARIABLE reference (e.g., ports: PORTS.server)
    if (Object.keys(ports).length === 0) {
      const portsVarMatch = appBlock.match(/\bports\s*:\s*([\w.]+)/);
      if (portsVarMatch) {
        const varRef = portsVarMatch[1];
        const resolved = portConstants[varRef];
        if (resolved && typeof resolved === 'object') {
          ports = { ...resolved };
        }
      }
    }

    // Fall back to legacy parsing if no ports object found
    if (Object.keys(ports).length === 0) {
      // Helper to resolve port value from literal, variable reference, or expression
      // Handles: 4420, PORTS.API, process.env.PORT || 4420, Number(...) || 4420
      const resolvePortValue = (value) => {
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
        // Expression with || fallback: "process.env.PORT || 4420"
        const fallbackMatch = trimmed.match(/\|\|\s*['"]?(\d+)['"]?\s*$/);
        if (fallbackMatch) return parseInt(fallbackMatch[1], 10);
        // PORTS.XXX or constant reference
        if (portConstants[trimmed]) return portConstants[trimmed];
        return null;
      };

      // Collect every `<NAME>_PORT` env-var first, label after — so CDP_PORT
      // can influence the smart label chosen for PORT regardless of source order.
      // The `_PORT` suffix requirement avoids matching identifiers like REPORT.
      // Brace-counting (not `[^}]*`) so env values with nested objects/ternaries
      // don't truncate the scan at the first inner `}`.
      // Iterate env blocks in PM2 precedence order (env < env_development <
      // env_production) and let later writes overwrite — so when a port is
      // redefined per-environment, the production value is the one we surface.
      const envBlockPrecedence = { env: 0, env_development: 1, env_production: 2 };
      const envHeaderRegex = /\b(env|env_development|env_production)\s*:\s*\{/g;
      const envBlocks = [];
      let envHeaderMatch;
      while ((envHeaderMatch = envHeaderRegex.exec(appBlock)) !== null) {
        const envName = envHeaderMatch[1];
        const openIdx = envHeaderMatch.index + envHeaderMatch[0].length - 1;
        const closeIdx = findMatchingBrace(appBlock, openIdx);
        if (closeIdx < 0) continue;
        envBlocks.push({
          envName,
          index: envHeaderMatch.index,
          envContent: appBlock.substring(openIdx + 1, closeIdx),
        });
      }
      envBlocks.sort((a, b) => {
        const pd = envBlockPrecedence[a.envName] - envBlockPrecedence[b.envName];
        return pd !== 0 ? pd : a.index - b.index;
      });

      const envPorts = {};
      // `['"]?` lets quoted keys like `'PORT': 3000` or `"COINBASE_IPC_PORT": 5565`
      // match — common in JSON-style ecosystem configs. `\b` still anchors the key.
      const portKeyRegex = /['"]?\b(PORT|[A-Z][A-Z0-9_]*_PORT)\b['"]?\s*:\s*([^,}\n]+)/g;
      for (const { envContent } of envBlocks) {
        portKeyRegex.lastIndex = 0;
        let m;
        while ((m = portKeyRegex.exec(envContent)) !== null) {
          const key = m[1];
          const resolved = resolvePortValue(m[2]);
          if (resolved) envPorts[key] = resolved; // last write wins
        }
      }

      const isUiProcess = /[-_](ui|client)$/i.test(processName);
      const isBrowserProcess = /[-_]browser$/i.test(processName);

      if (envPorts.CDP_PORT !== undefined) ports.cdp = envPorts.CDP_PORT;
      if (envPorts.PORT !== undefined) {
        if (isUiProcess) {
          ports.ui = envPorts.PORT;
        } else if (isBrowserProcess && ports.cdp !== undefined) {
          // Browser processes pair CDP_PORT (DevTools) with PORT (health endpoint).
          ports.health = envPorts.PORT;
        } else {
          ports.api = envPorts.PORT;
        }
      }
      if (envPorts.VITE_PORT !== undefined) ports.ui = envPorts.VITE_PORT;

      // FOO_BAR_PORT → fooBar, capturing app-specific labels (coinbaseIpc, etc.).
      for (const [key, value] of Object.entries(envPorts)) {
        if (key === 'PORT' || key === 'VITE_PORT' || key === 'CDP_PORT') continue;
        const stem = key.replace(/_?PORT$/, '');
        if (!stem) continue;
        const label = stem.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase());
        if (ports[label] === undefined) ports[label] = value;
      }

      // Also check for --port in args
      if (Object.keys(ports).length === 0) {
        const argsPortMatch = appBlock.match(/args\s*:\s*['"][^'"]*--port\s+(\d+)/);
        if (argsPortMatch) {
          ports.ui = parseInt(argsPortMatch[1], 10);
        }
      }

      // Check for port: XXXX directly (some configs use this)
      if (Object.keys(ports).length === 0) {
        const directPortMatch = appBlock.match(/\bport\s*:\s*(\d+)/);
        if (directPortMatch) {
          ports.api = parseInt(directPortMatch[1], 10);
        }
      }
    }

    // Primary port is the first one found (for backwards compatibility)
    const portValues = Object.values(ports);
    const port = portValues.length > 0 ? portValues[0] : null;

    // Extract cwd for processes that might have external config files
    let cwd = null;
    const cwdMatch = appBlock.match(/cwd\s*:\s*['"]([^'"]+)['"]/);
    if (cwdMatch) {
      cwd = cwdMatch[1];
    }

    // Check if this process uses vite (need to check vite.config in cwd)
    // Match explicit "vite" command OR VITE_PORT in env config
    const usesVite = /\bvite\b/i.test(appBlock) || /VITE_PORT/i.test(appBlock);

    processes.push({ name: processName, port, ports, cwd, usesVite });
    lastIndex = endPos;
  }

  // Post-process: when an app has both an API process and Vite dev processes,
  // relabel Vite ports from 'ui' to 'devUi' since the prod UI is served by the API.
  const hasApiProcess = processes.some(p => p.ports?.api);
  if (hasApiProcess) {
    for (const proc of processes) {
      if (proc.usesVite && proc.ports?.ui && !proc.ports?.devUi) {
        proc.ports.devUi = proc.ports.ui;
        delete proc.ports.ui;
        // Update primary port reference
        const portValues = Object.values(proc.ports);
        proc.port = portValues.length > 0 ? portValues[0] : null;
      }
    }
  }

  return { processes, pm2Home };
}

/**
 * Extract port from vite.config.js/ts content
 */
function extractVitePort(content) {
  const portMatch = content.match(/port\s*:\s*(\d+)/);
  return portMatch ? parseInt(portMatch[1], 10) : null;
}

/**
 * Parse ecosystem config from a directory path (non-streaming, for refresh)
 * Also checks vite.config files in subdirectories for processes that use Vite
 * @returns {{ processes: Array, pm2Home: string|null }}
 */
export async function parseEcosystemFromPath(dirPath) {
  for (const ecosystemFile of ECOSYSTEM_CONFIG_FILENAMES) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (existsSync(ecosystemPath)) {
      const content = await readFile(ecosystemPath, 'utf-8');
      const { processes, pm2Home } = parseEcosystemConfig(content);

      // For processes that use vite and don't have a port, check their cwd for vite.config
      for (const proc of processes) {
        if (proc.usesVite && !proc.port && proc.cwd) {
          const cwdPath = join(dirPath, proc.cwd);
          for (const viteConfig of ['vite.config.ts', 'vite.config.js']) {
            const viteConfigPath = join(cwdPath, viteConfig);
            if (existsSync(viteConfigPath)) {
              const viteContent = await readFile(viteConfigPath, 'utf-8').catch(() => '');
              const port = extractVitePort(viteContent);
              if (port) {
                proc.port = port;
                break;
              }
            }
          }
        }
        // Clean up internal properties before returning
        delete proc.cwd;
        delete proc.usesVite;
      }

      return { processes, pm2Home };
    }
  }
  return { processes: [], pm2Home: null };
}

/**
 * Brace-matched `{ start, end }` regions whose numeric values are rewritten
 * by VALUE regardless of key name: every `const PORTS = {...}` block AND every
 * per-app `ports: { api: N, ui: N }` object. parseEcosystemConfig reads the
 * per-app `ports:` object FIRST when deriving uiPort/apiPort/devUiPort, so a
 * rewrite that skipped it would let the edit silently revert on the next
 * config refresh — the exact bug the write-back exists to prevent.
 *
 * Commented-out matches are skipped: rewriting a port inside a commented
 * `const PORTS = {...}` would make writeEcosystemPorts report success while the
 * executable config is untouched (the per-region slice starts at the `{`, so
 * the region's own comment scan can no longer see the leading `//`/`/*`).
 */
function findValuePortRegions(content) {
  const comments = commentRanges(content);
  const inComment = (pos) => comments.some(([s, e]) => pos >= s && pos < e);
  const regions = [];
  // `const PORTS = {` (uppercase, any declarator) OR a lowercase `ports: {`
  // object value — the latter is case-sensitive so it won't match `const PORTS`
  // or `reports:`.
  const re = /(?:(?:const|let|var)\s+PORTS\s*=\s*|\bports\s*:\s*)\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (inComment(m.index)) continue;
    const open = m.index + m[0].length - 1;
    const end = findMatchingBrace(content, open);
    if (end >= 0) regions.push({ start: open, end });
  }
  return regions;
}

/**
 * Byte ranges `[start, end)` covered by line comments and block comments,
 * skipping comment markers that appear inside string/template literals. Used to
 * keep the port rewrite from matching (and falsely "succeeding" on) a port that
 * only appears in a comment.
 */
function commentRanges(content) {
  const ranges = [];
  let i = 0;
  const n = content.length;
  let inString = false;
  let stringChar = null;
  while (i < n) {
    const c = content[i];
    const nx = i + 1 < n ? content[i + 1] : '';
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = true; stringChar = c; i++; continue; }
    if (c === '/' && nx === '/') {
      const start = i; i += 2;
      while (i < n && content[i] !== '\n') i++;
      ranges.push([start, i]);
      continue;
    }
    if (c === '/' && nx === '*') {
      const start = i; i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      ranges.push([start, Math.min(i, n)]);
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * Replace every match of `re` in `str` with `${prefix}${replacement}`, EXCEPT
 * matches whose port number falls inside a comment. `re` must have its port
 * number as the final capture run so we can locate where the digits begin: a
 * value living only in a comment (`// PORT: 5173`) must NOT count as a rewrite,
 * or the writer would report changed:true while the executable config is
 * untouched, recreating the apps.json-vs-PM2 mismatch the write-back prevents.
 */
function replaceOutsideComments(str, re, replacement) {
  const ranges = commentRanges(str);
  return str.replace(re, (full, prefix, offset) => {
    const numStart = offset + prefix.length;
    return ranges.some(([s, e]) => numStart >= s && numStart < e) ? full : `${prefix}${replacement}`;
  });
}

/**
 * Find the `{ start, end }` brace-matched region of the app block whose
 * `name:` equals `processName`. Mirrors the block-scan parseEcosystemConfig
 * uses, so a per-process rewrite targets exactly the block the parser derived
 * that process's ports from. Returns the first match (parser semantics) or null.
 */
function findAppBlock(content, processName) {
  const re = /\{\s*name\s*:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== processName) continue;
    const end = findMatchingBrace(content, m.index);
    if (end >= 0) return { start: m.index, end };
  }
  return null;
}

/**
 * Within a single app block, rewrite the port literal that belongs to `label`
 * (`api`/`ui`/`devUi`) from `oldP` → `newP`, leaving sibling labels alone.
 *
 * The key insight that makes per-label targeting safe inside one block: `PORT`
 * maps to exactly ONE label per process (api OR ui, decided by process name) —
 * the two never collide in the same block. So when two labels share a literal
 * value, they either live in different blocks (block scoping splits them) or in
 * an explicit `ports: { api: N, ui: N }` map (the label KEY splits them). The
 * value-keyed rewriter can't disambiguate either; this one can.
 *
 * Sources rewritten per label mirror parseEcosystemConfig's derivation AND the
 * PM2 runtime env (so the config the parser reads and the env PM2 launches with
 * both move together):
 *   - api  → `ports: { api: N }`, plus env `PORT`/`PORT: … || N`/`port:` ONLY
 *            when the block has no `ports:` REFERENCE (`ports: PORTS.server`) —
 *            for a reference the parser reads the external const, not env, so
 *            rewriting env would falsely report success while the real source
 *            (and displayed port) reverts on refresh.
 *   - ui   → exact `ui:` key, env `VITE_PORT`, `--port N`, and bare env `PORT`
 *            only when there's no explicit ports source (inline object OR
 *            reference) — a UI-named process whose bare `PORT` IS the UI port.
 *   - devUi → exact `devUi:` key (same env/args/bare-PORT sources as ui), PLUS
 *            a Vite process's `ui:` literal when the block has no explicit
 *            `devUi:` key (parseEcosystemConfig relabels ui→devUi when an api
 *            sibling exists, so the on-disk source for that devUi IS `ui:`).
 *
 * Matching the EXACT label key (not a combined `ui|devUi`) means a block that
 * carries both `ui:` and `devUi:` with the same value only rewrites the one the
 * user edited — the sibling keeps its literal.
 *
 * @returns {{ block: string, changed: boolean }}
 */
function rewriteLabelInBlock(block, label, oldP, newP, processName = '') {
  // Swap the matched digits to a sentinel first, then resolve the sentinel to
  // the new value — so a label whose old/new values overlap another source in
  // the same block can't chain. Each prefix capture group is preserved, so only
  // the number changes (no whitespace artifact).
  const ph = 'PORT_TGT_PLACEHOLDER';
  const NUM = `${oldP}\\b`;
  // An explicit ports source is what parseEcosystemConfig derives from. An
  // inline `ports: { ... }` object is rewritable in-block; a `ports: PORTS.x`
  // REFERENCE points at an external const this block can't reach, so the
  // same-valued env literal must NOT be used as a fallback for it (false
  // success + silent runtime-env change). Both forms mean env `PORT` is
  // metadata, not the parser's value.
  const hasInlinePortsObj = /\bports\s*:\s*\{/.test(block);
  const hasPortsReference = /\bports\s*:\s*[A-Za-z_$]/.test(block);
  const hasExplicitPortsSource = hasInlinePortsObj || hasPortsReference;
  // Note: a `ports: SOME_REF` whose constant parseEcosystemConfig can't resolve
  // makes the parser fall back to env/args — but this block-level rewriter has
  // no constant table, so it can't tell a resolved reference from an unresolved
  // one and conservatively treats ALL references as explicit sources (suppresses
  // the env fallback). The cost is a safe 422 on that uncommon malformed-config
  // shape (no corruption), not a wrong write; resolving it would mean threading
  // the parser's resolved-port map down into this pure function.
  // `PORT`/`'PORT'`/`` `PORT` `` followed by `:` and optional whitespace.
  const PORT_KEY = "['\"`]?\\bPORT\\b['\"`]?\\s*:\\s*";
  // Which label does a bare env `PORT` map to? Mirror parseEcosystemConfig:
  // a `-ui`/`-client`-suffixed process routes bare PORT → ui; otherwise → api.
  // (A browser process routes PORT → health, which is none of api/ui/devUi.)
  // PM2 launches with this env var, so the bare PORT must move with its label's
  // port even when an inline ports object is also present — otherwise the
  // process restarts on the old port while the config/registry show the new.
  const isUiProcess = /[-_](ui|client)$/i.test(processName);
  const isBrowserProcess = /[-_]browser$/i.test(processName);
  const barePortLabel = isBrowserProcess ? 'health' : (isUiProcess ? 'ui' : 'api');
  // Label-specific runtime env var, mirroring parseEcosystemConfig's
  // `<STEM>_PORT` → camelCased-stem labeling (API_PORT→api, UI_PORT→ui,
  // DEV_UI_PORT→devUi). PM2 launches the process WITH this env var, so a shared
  // inline `ports` edit that left it on the old value would revert at runtime.
  const LABEL_ENV_KEY = { api: 'API_PORT', ui: 'UI_PORT', devUi: 'DEV_UI_PORT' }[label];

  // Patterns are split by SCOPE:
  //   - portsObjPats run ONLY inside the inline `ports: { ... }` slice. The
  //     `api:`/`ui:`/`devUi:` keys are valid only there (the only place
  //     parseEcosystemConfig reads them); applied over the whole block they'd
  //     also hit a same-named field elsewhere (e.g. `metadata: { api: N }`) and
  //     mutate config the parser never used as the port source.
  //   - blockPats run over the whole block (env keys, args, bare PORT).
  const portsObjPats = [];
  const blockPats = [];
  // Bare env `PORT` should be rewritten whenever it maps to THIS label (per the
  // process name), regardless of whether an inline ports object also exists —
  // PM2 launches with it, so it must track the label's port. NOT for a ports
  // REFERENCE block: there the parser reads the external const and ignores env,
  // so rewriting the bare PORT would be a false-success runtime-only change.
  // A UI process's bare PORT serves BOTH `ui` and `devUi`: when an API sibling
  // exists parseEcosystemConfig relabels that parsed ui port to devUi, so a
  // devUi edit on a UI-named process targets the same bare PORT.
  const barePortIsThisLabel = barePortLabel === label || (barePortLabel === 'ui' && label === 'devUi');
  const rewriteBarePort = barePortIsThisLabel && !hasPortsReference;

  if (label === 'api') {
    if (hasInlinePortsObj) portsObjPats.push(`(\\bapi\\s*:\\s*)${NUM}`);  // ports: { api: N }
    if (rewriteBarePort) {
      // The env `PORT` (and its `|| N` fallback) is the runtime API port here.
      blockPats.push(`(${PORT_KEY}[^,}\\n]*?\\|\\|\\s*['"]?)${NUM}`);     // PORT: … || N (fallback)
      blockPats.push(`(${PORT_KEY})${NUM}`);                             // env PORT: N
    }
    if (!hasPortsReference) {
      // Label-specific runtime env var (API_PORT) — PM2 launches with it.
      blockPats.push(`(['"\`]?\\b${LABEL_ENV_KEY}\\b['"\`]?\\s*:\\s*)${NUM}`); // env API_PORT: N
    }
    // A bare lowercase `port:` is parseEcosystemConfig's LAST-RESORT derivation
    // (`directPortMatch`), consulted only when there's no ports object/env. So
    // rewrite it ONLY when there's no explicit ports source — otherwise it'd
    // hit an unrelated same-valued field (e.g. `metadata: { port: 6000 }`) the
    // parser never read as the API port.
    if (!hasExplicitPortsSource) blockPats.push(`(\\bport\\s*:\\s*)${NUM}`); // port: N
  } else {
    const hasDevUiKey = /\bdevUi\s*:\s*\d/.test(block);
    if (hasInlinePortsObj) {
      portsObjPats.push(label === 'devUi' ? `(\\bdevUi\\s*:\\s*)${NUM}` : `(\\bui\\s*:\\s*)${NUM}`); // exact key
      if (label === 'devUi' && !hasDevUiKey) portsObjPats.push(`(\\bui\\s*:\\s*)${NUM}`); // relabeled-from-ui source
    }
    if (!hasPortsReference) {
      // VITE_PORT/--port mirror the runtime UI/dev port: rewrite them alongside
      // an inline ports key (desirable — config + runtime move together) or as
      // the sole source when there's no ports object. But NOT for a ports
      // REFERENCE whose external const the parser actually reads — rewriting
      // only the env/args value there is false success (the unchanged const
      // re-derives the old port on the next refresh).
      blockPats.push(`(['"\`]?\\bVITE_PORT\\b['"\`]?\\s*:\\s*)${NUM}`); // env VITE_PORT: N
      blockPats.push(`(--port\\s+)${NUM}`);                            // args --port N
      // Label-specific runtime env var (UI_PORT / DEV_UI_PORT) — PM2 launches with it.
      blockPats.push(`(['"\`]?\\b${LABEL_ENV_KEY}\\b['"\`]?\\s*:\\s*)${NUM}`); // env UI_PORT: N
    }
    // Bare env `PORT` is the UI port when this is a UI-named process — rewrite it
    // even alongside an inline ports object (it's the runtime port PM2 uses).
    if (rewriteBarePort) blockPats.push(`(${PORT_KEY})${NUM}`); // bare PORT of a UI-named process
  }

  let out = block;
  // Label-key patterns: rewrite only within the `ports: { ... }` object slice.
  if (portsObjPats.length > 0) {
    const open = out.search(/\bports\s*:\s*\{/);
    if (open >= 0) {
      const braceIdx = out.indexOf('{', open);
      const end = findMatchingBrace(out, braceIdx);
      if (end >= 0) {
        let inner = out.slice(braceIdx, end + 1);
        for (const p of portsObjPats) inner = replaceOutsideComments(inner, new RegExp(p, 'g'), ph);
        out = out.slice(0, braceIdx) + inner + out.slice(end + 1);
      }
    }
  }
  // Env/args patterns: rewrite over the whole block.
  for (const p of blockPats) {
    out = replaceOutsideComments(out, new RegExp(p, 'g'), ph);
  }
  const changed = out.includes(ph);
  out = out.split(ph).join(String(newP));
  return { block: out, changed };
}

/**
 * Per-process-label-targeted port rewrite — the disambiguating counterpart to
 * the value-keyed `rewriteEcosystemPorts`. Each edit names the process and the
 * label (`api`/`ui`/`devUi`) to change, so a value shared by two labels in the
 * SAME block (e.g. an explicit `ports: { api: N, ui: N }` map, or a UI process
 * whose bare `PORT` is its only port) is rewritten on exactly the one the user
 * touched. An edit whose label has no rewritable literal inside the process
 * block — e.g. the value lives in an external `const PORTS = {…}` reached via
 * `ports: PORTS.server`, which this in-block rewrite can't see — is returned in
 * `unapplied` (the caller 422s) rather than falsely rewriting a same-valued env
 * literal the parser ignores. Pure (no I/O) for unit-testability.
 *
 * @param {string} content
 * @param {Array<{processName:string,label:string,oldPort:number,newPort:number}>} edits
 * @returns {{ content: string, applied: Array, unapplied: Array }}
 */
export function rewriteEcosystemPortsByProcess(content, edits) {
  const valid = (edits || []).filter(e =>
    e && typeof e.processName === 'string' && typeof e.label === 'string' &&
    Number.isInteger(e.oldPort) && Number.isInteger(e.newPort) &&
    e.oldPort > 0 && e.newPort > 0 && e.oldPort !== e.newPort);
  if (valid.length === 0) return { content, applied: [], unapplied: [] };

  const applied = [];
  const unapplied = [];

  // Group edits by process so a block is sliced once even when several labels
  // in it change (e.g. apiPort + uiPort that currently share a value).
  const byProcess = new Map();
  for (const e of valid) {
    if (!byProcess.has(e.processName)) byProcess.set(e.processName, []);
    byProcess.get(e.processName).push(e);
  }

  const blocks = [];
  for (const [name, es] of byProcess) {
    const range = findAppBlock(content, name);
    if (!range) { es.forEach(e => unapplied.push(e)); continue; }
    blocks.push({ range, edits: es });
  }
  // Rewrite back-to-front so each splice keeps earlier blocks' offsets valid.
  blocks.sort((a, b) => b.range.start - a.range.start);

  let out = content;
  for (const blk of blocks) {
    let inner = out.slice(blk.range.start, blk.range.end + 1);
    for (const e of blk.edits) {
      const r = rewriteLabelInBlock(inner, e.label, e.oldPort, e.newPort, e.processName);
      inner = r.block;
      (r.changed ? applied : unapplied).push(e);
    }
    out = out.slice(0, blk.range.start) + inner + out.slice(blk.range.end + 1);
  }

  return { content: out, applied, unapplied };
}

/**
 * Rewrite port literals in an ecosystem.config content string per a remap of
 * old → new port numbers. Pure (no I/O) so it's unit-testable.
 *
 * `ecosystem.config.cjs` is the source of truth for an app's ports — PortOS
 * *derives* uiPort/apiPort/devUiPort from it via parseEcosystemConfig. Editing
 * ports in the UI therefore has to write back here, or PM2 keeps the old ports
 * and the next config refresh re-derives them and clobbers the edit.
 *
 * Replacements are deliberately narrow so unrelated numbers (watch_delay,
 * timeouts) are never touched:
 *   1. numeric values inside a `const PORTS = {...}` block AND each per-app
 *      `ports: {...}` object (arbitrary keys — matched by value),
 *   2. `--port <n>` tokens in args strings,
 *   3. port-ish env keys (`PORT`, `*_PORT`, `VITE_PORT`) and `port:`,
 *   4. top-level port constants (`const API_PORT = <n>`),
 *   5. fallback-expression defaults (`PORT: process.env.PORT || <n>`).
 *
 * Each old value is first swapped to a unique placeholder, then placeholders
 * resolve to new values — so a remap like 6000→6001, 6001→6002 can't chain.
 * Placeholders are NUL-wrapped so index 1's token can't prefix-match index 10's.
 *
 * @param {string} content
 * @param {Map<number,number>|Array<[number,number]>} remap
 * @returns {string}
 */
export function rewriteEcosystemPorts(content, remap) {
  const pairs = (remap instanceof Map ? [...remap.entries()] : remap || [])
    .map(([o, n]) => [Number(o), Number(n)])
    .filter(([o, n]) => Number.isInteger(o) && Number.isInteger(n) && o > 0 && n > 0 && o !== n);
  if (pairs.length === 0) return content;

  const ph = (i) => `PORT_REMAP_${i}_`;
  // Port-ish env keys: PORT, FOO_PORT, VITE_PORT (and quoted variants), plus `port:`.
  const KEY = `(?:[A-Za-z][A-Za-z0-9_]*_PORT|PORT|port)`;

  // replaceOutsideComments (module scope) skips matches whose port number sits
  // inside a comment, so a commented `// PORT: 5173` never counts as a rewrite.

  let out = content;

  // 1) Within `const PORTS = {...}` and each per-app `ports: {...}` object,
  //    swap any `: <old>` value (keys there are arbitrary — API, UI, api, ui).
  //    Process regions back-to-front so each splice's offsets stay valid for
  //    the earlier (lower-index) regions still to be rewritten.
  const regions = findValuePortRegions(out).sort((a, b) => b.start - a.start);
  for (const region of regions) {
    let inner = out.slice(region.start, region.end + 1);
    pairs.forEach(([oldP], i) => {
      inner = replaceOutsideComments(inner, new RegExp(`(:\\s*)${oldP}\\b`, 'g'), ph(i));
    });
    out = out.slice(0, region.start) + inner + out.slice(region.end + 1);
  }

  // 2) `--port <old>` in args strings.
  pairs.forEach(([oldP], i) => {
    out = replaceOutsideComments(out, new RegExp(`(--port\\s+)${oldP}\\b`, 'g'), ph(i));
  });

  // 3) Port-ish key assignments anywhere (env blocks, ports objects).
  pairs.forEach(([oldP], i) => {
    out = replaceOutsideComments(out, new RegExp(`(['"\`]?\\b${KEY}\\b['"\`]?\\s*:\\s*)${oldP}\\b`, 'g'), ph(i));
  });

  // 4) Top-level port constants — `const API_PORT = 5555` / `let CDP_PORT = …`.
  //    parseEcosystemConfig derives ports from these (a `\w*PORT\w*` name `=`
  //    number), so an edit that skipped them would revert on the next refresh.
  pairs.forEach(([oldP], i) => {
    out = replaceOutsideComments(out, new RegExp(`((?:const|let|var)\\s+\\w*PORT\\w*\\s*=\\s*)${oldP}\\b`, 'g'), ph(i));
  });

  // 5) Fallback-expression defaults — `PORT: process.env.PORT || 4420`.
  //    parseEcosystemConfig resolves the `|| <n>` literal, so it must be
  //    rewritten too. The value isn't adjacent to the key (step 3 misses it),
  //    so match the port-ish key, then any same-value expression up to `||`.
  //    `[^,}\n]*?` keeps the match inside one value (no comma/brace/newline).
  pairs.forEach(([oldP], i) => {
    out = replaceOutsideComments(out, new RegExp(`(['"\`]?\\b${KEY}\\b['"\`]?\\s*:\\s*[^,}\\n]*?\\|\\|\\s*['"]?)${oldP}\\b`, 'g'), ph(i));
  });

  // Resolve placeholders → new values.
  pairs.forEach(([, newP], i) => {
    out = out.split(ph(i)).join(String(newP));
  });

  return out;
}

/**
 * Persist a port remap to an app's on-disk ecosystem config (`.cjs` preferred,
 * then `.js`). Returns `{ file, changed }`. No-op (changed:false) when nothing
 * matched. See rewriteEcosystemPorts for why this is the canonical write path.
 *
 * @param {string} repoPath
 * @param {Map<number,number>|Array<[number,number]>} remap
 */
export async function writeEcosystemPorts(repoPath, remap) {
  // Same resolution order as parseEcosystemFromPath — rewrite the file the
  // reader actually derives ports from (see ECOSYSTEM_CONFIG_FILENAMES).
  for (const name of ECOSYSTEM_CONFIG_FILENAMES) {
    const filePath = join(repoPath, name);
    if (!existsSync(filePath)) continue;
    const content = await readFile(filePath, 'utf-8');
    const updated = rewriteEcosystemPorts(content, remap);
    if (updated !== content) {
      await atomicWrite(filePath, updated);
      return { file: name, changed: true };
    }
    return { file: name, changed: false };
  }
  return { file: null, changed: false };
}

/**
 * Persist a per-process-label-targeted port remap to an app's on-disk ecosystem
 * config (`.cjs` preferred, then `.js`). The disambiguating counterpart to
 * writeEcosystemPorts: use this when a port value is shared by two labels (e.g.
 * `ports: { api: N, ui: N }`) and only one was edited. Returns
 * `{ file, changed, applied, unapplied }`; `unapplied` lists edits whose process
 * block or label literal wasn't found (caller decides whether that's a failure).
 *
 * **All-or-nothing.** The rewrite is computed in full (pure) before any I/O, and
 * the file is written ONLY when every edit applied (`unapplied` is empty). A
 * batch where some labels are rewritable and others aren't (e.g. one port is a
 * literal `PORT: 6000` but a same-valued sibling lives in an external
 * `ports: PORTS.client` reference) must NOT persist its applied subset — the
 * caller turns a non-empty `unapplied` into a 422 and skips the registry update,
 * so a partial on-disk write would leave config and registry inconsistent for a
 * request that "failed". When `unapplied` is non-empty the file is left
 * untouched and `applied` is reported empty (nothing was persisted).
 *
 * @param {string} repoPath
 * @param {Array<{processName:string,label:string,oldPort:number,newPort:number}>} edits
 */
export async function writeEcosystemPortsByProcess(repoPath, edits) {
  for (const name of ECOSYSTEM_CONFIG_FILENAMES) {
    const filePath = join(repoPath, name);
    if (!existsSync(filePath)) continue;
    const content = await readFile(filePath, 'utf-8');
    const { content: updated, applied, unapplied } = rewriteEcosystemPortsByProcess(content, edits);
    // Don't persist a partial batch: if any edit couldn't be applied, the
    // caller rejects the whole request, so writing the applied subset would
    // desync config from the (un-updated) registry.
    if (unapplied.length > 0) {
      return { file: name, changed: false, applied: [], unapplied };
    }
    if (updated !== content) {
      await atomicWrite(filePath, updated);
      return { file: name, changed: true, applied, unapplied };
    }
    return { file: name, changed: false, applied, unapplied };
  }
  return { file: null, changed: false, applied: [], unapplied: edits || [] };
}

/**
 * Persist a mixed port edit — a value-keyed `remap` (distinct ports) AND a set
 * of per-process-label-targeted `edits` (shared-value ports) — to an app's
 * ecosystem config in ONE atomic write.
 *
 * Both rewrites are computed in memory against the same file content, then the
 * file is written exactly once. This is the only way to keep a mixed edit
 * all-or-nothing: writing the value-keyed pass and the targeted pass as two
 * separate `atomicWrite`s lets the first land on disk before the second reports
 * an unpersistable edit — so a request the caller then 422s would still have
 * partially changed the config. Here, if ANY targeted edit is unapplied, the
 * file is left untouched and the whole result is reported as not-persisted, so
 * the caller's reject path never leaves a partial write behind.
 *
 * Returns `{ file, changed, remapApplied, applied, unapplied }`:
 *   - `remapApplied` — true when the value-keyed remap matched a literal
 *   - `applied`/`unapplied` — the targeted edits that did / didn't rewrite
 *
 * @param {string} repoPath
 * @param {Array<[number,number]>} remap
 * @param {Array<{processName:string,label:string,oldPort:number,newPort:number}>} edits
 */
export async function writeEcosystemPortEdits(repoPath, remap, edits) {
  const hasRemap = (remap || []).length > 0;
  const hasEdits = (edits || []).length > 0;
  if (!hasRemap && !hasEdits) return { file: null, changed: false, remapApplied: false, applied: [], unapplied: [] };

  for (const name of ECOSYSTEM_CONFIG_FILENAMES) {
    const filePath = join(repoPath, name);
    if (!existsSync(filePath)) continue;
    const content = await readFile(filePath, 'utf-8');

    // The two passes both run against the in-memory result of the other so a
    // single write reflects both — but whichever runs SECOND can match a literal
    // the first pass just created, chaining one edit into another. That happens
    // when the second pass's match-value equals a value the first produced:
    //   - value-keyed→targeted chains if a targeted OLD value equals a remap NEW
    //     value (forward collision), and
    //   - targeted→value-keyed chains if a remap OLD value equals a targeted NEW
    //     value (reverse collision).
    // Pick the order that avoids the collision present; if BOTH directions
    // collide there's no safe order, so treat the whole batch as unpersistable
    // (the caller 422s — honest, vs. silently corrupting a sibling port).
    const remapOlds = remap.map(([o]) => o);
    const remapNews = remap.map(([, n]) => n);
    const targetedOlds = (edits || []).map(e => e.oldPort);
    const targetedNews = (edits || []).map(e => e.newPort);
    const forwardCollision = hasRemap && hasEdits && targetedOlds.some(o => remapNews.includes(o));
    const reverseCollision = hasRemap && hasEdits && remapOlds.some(o => targetedNews.includes(o));

    // Both directions collide ⇒ neither single ordering is safe (a true value
    // cycle, e.g. swapping ui↔devUi between two same-block ports). Resolving it
    // would need per-edit placeholder staging; that's an exotic intra-block port
    // swap well outside the shared/derived cases this path targets, so we
    // conservatively reject (a safe 422 — no corruption) rather than build it.
    if (forwardCollision && reverseCollision) {
      return { file: name, changed: false, remapApplied: false, applied: [], unapplied: edits || [] };
    }

    let result, applied, unapplied, remapApplied;
    if (forwardCollision) {
      // Run targeted FIRST so the value-keyed pass can't feed it a fresh literal.
      const t = hasEdits ? rewriteEcosystemPortsByProcess(content, edits) : { content, applied: [], unapplied: [] };
      const afterRemap = hasRemap ? rewriteEcosystemPorts(t.content, remap) : t.content;
      result = afterRemap; applied = t.applied; unapplied = t.unapplied;
      remapApplied = hasRemap && afterRemap !== t.content;
    } else {
      // Default: value-keyed first, then targeted (safe when no forward collision).
      const afterRemap = hasRemap ? rewriteEcosystemPorts(content, remap) : content;
      const t = hasEdits ? rewriteEcosystemPortsByProcess(afterRemap, edits) : { content: afterRemap, applied: [], unapplied: [] };
      result = t.content; applied = t.applied; unapplied = t.unapplied;
      remapApplied = hasRemap && afterRemap !== content;
    }

    // Persist NOTHING when ANY part of the request is unpersistable — the caller
    // rejects the whole update (422) in either of these cases, so a partial
    // write would desync config from the un-updated registry:
    //   - a requested value-keyed remap matched no literal (`hasRemap` &&
    //     !remapApplied) — the symmetric twin of an unapplied targeted edit, and
    //   - any targeted edit couldn't be applied (`unapplied`).
    const remapFailed = hasRemap && !remapApplied;
    if (remapFailed || unapplied.length > 0) {
      return { file: name, changed: false, remapApplied: false, applied: [], unapplied };
    }

    if (result !== content) {
      await atomicWrite(filePath, result);
      return { file: name, changed: true, remapApplied, applied, unapplied };
    }
    return { file: name, changed: false, remapApplied, applied, unapplied };
  }
  return { file: null, changed: false, remapApplied: false, applied: [], unapplied: edits || [] };
}

/**
 * Stream detection results to a socket as each step completes
 */
export async function streamDetection(socket, dirPath) {
  const emit = (step, status, data = {}) => {
    socket.emit('detect:step', { step, status, data, timestamp: Date.now() });
  };

  const result = {
    name: '',
    description: '',
    uiPort: null,
    devUiPort: null,
    apiPort: null,
    buildCommand: null,
    startCommands: [],
    pm2ProcessNames: [],
    pm2Status: null,
    processes: [],
    pm2Home: null,
    type: 'unknown',
    appIconPath: null
  };

  // Step 1: Validate path
  emit('validate', 'running', { message: 'Validating directory path...' });

  if (!existsSync(dirPath)) {
    emit('validate', 'error', { message: 'Directory does not exist' });
    socket.emit('detect:complete', { success: false, error: 'Directory does not exist' });
    return;
  }

  const stats = await stat(dirPath);
  if (!stats.isDirectory()) {
    emit('validate', 'error', { message: 'Path is not a directory' });
    socket.emit('detect:complete', { success: false, error: 'Path is not a directory' });
    return;
  }

  emit('validate', 'done', { message: 'Valid directory' });
  result.name = basename(dirPath);

  // Step 2: Read directory contents
  emit('files', 'running', { message: 'Scanning directory...' });
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files = entries.map(e => e.name);
  emit('files', 'done', { message: `Found ${files.length} files`, files: files.slice(0, 20) });

  // Detect Swift/Xcode projects from directory contents
  const hasXcodeproj = files.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
  const hasProjectYml = files.includes('project.yml');
  const hasPackageSwift = files.includes('Package.swift');

  if (hasXcodeproj || hasProjectYml || hasPackageSwift) {
    // Parse project.yml for XcodeGen projects
    if (hasProjectYml) {
      const ymlContent = await readFile(join(dirPath, 'project.yml'), 'utf-8').catch(() => '');
      const nameMatch = ymlContent.match(/^name:\s*(.+)$/m);
      if (nameMatch) result.name = nameMatch[1].trim();

      // Detect platform from targets
      const platformMatch = ymlContent.match(/platform:\s*\[?([^\]\n]+)/);
      if (platformMatch) {
        const platforms = platformMatch[1].toLowerCase();
        if (platforms.includes('ios') && platforms.includes('macos')) {
          result.type = 'xcode';
        } else if (platforms.includes('ios')) {
          result.type = 'ios-native';
        } else if (platforms.includes('macos')) {
          result.type = 'macos-native';
        } else {
          result.type = 'xcode';
        }
      } else {
        result.type = 'xcode';
      }

      // Extract build command
      result.buildCommand = 'xcodebuild -scheme ' + result.name + ' build';
    } else if (hasPackageSwift) {
      result.type = 'swift';
      result.buildCommand = 'swift build';
    } else {
      // .xcodeproj without project.yml
      const xcodeprojDir = files.find(f => f.endsWith('.xcodeproj'));
      const schemeName = xcodeprojDir?.replace('.xcodeproj', '') || result.name;
      result.type = 'xcode';
      result.buildCommand = 'xcodebuild -scheme ' + schemeName + ' build';
    }

    result.startCommands = [];
    result.pm2ProcessNames = [];
    result.editorCommand = process.platform === 'darwin' ? 'xed .' : 'code .';
  }

  // Step 3: Read package.json
  emit('package', 'running', { message: 'Reading package.json...' });
  const pkgPath = join(dirPath, 'package.json');

  if (existsSync(pkgPath)) {
    const content = await tryReadFile(pkgPath);
    if (content) {
      const pkg = safeJSONParse(content, null);
      if (!pkg) {
        emit('package', 'error', { message: 'Invalid package.json format' });
      } else {
        result.name = pkg.name || result.name;
        result.description = pkg.description || '';

        // Detect project type
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vite && deps.express) result.type = 'vite+express';
        else if (deps.vite || deps.react || deps.vue) result.type = 'vite';
        else if (deps.express || deps.fastify || deps.koa) result.type = 'single-node-server';
        else if (deps.next) result.type = 'nextjs';

        // Get start commands and build command
        const scripts = pkg.scripts || {};
        if (scripts.dev) result.startCommands.push('npm run dev');
        if (scripts.start && !scripts.dev) result.startCommands.push('npm start');
        if (scripts.build) result.buildCommand = 'npm run build';

        emit('package', 'done', {
          message: `Found: ${result.name}`,
          name: result.name,
          description: result.description,
          type: result.type,
          startCommands: result.startCommands
        });
      }
    }
  } else {
    emit('package', 'done', { message: 'No package.json found' });
  }

  // Step 4: Check config files for ports
  emit('config', 'running', { message: 'Checking configuration files...' });
  const configFiles = [];

  // Check .env
  const envPath = join(dirPath, '.env');
  if (existsSync(envPath)) {
    const content = await readFile(envPath, 'utf-8').catch(() => '');
    const portMatch = content.match(/PORT\s*=\s*(\d+)/i);
    if (portMatch) result.apiPort = parseInt(portMatch[1], 10);
    const viteMatch = content.match(/VITE_PORT\s*=\s*(\d+)/i);
    if (viteMatch) result.devUiPort = parseInt(viteMatch[1], 10);
    configFiles.push('.env');
  }

  // Check vite.config
  for (const viteConfig of ['vite.config.js', 'vite.config.ts']) {
    const configPath = join(dirPath, viteConfig);
    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8').catch(() => '');
      const portMatch = content.match(/port\s*:\s*(\d+)/);
      if (portMatch) result.devUiPort = parseInt(portMatch[1], 10);
      configFiles.push(viteConfig);
    }
  }

  // Check ecosystem.config.js/cjs for PM2 configuration
  for (const ecosystemFile of ['ecosystem.config.js', 'ecosystem.config.cjs']) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (existsSync(ecosystemPath)) {
      const content = await readFile(ecosystemPath, 'utf-8').catch(() => '');
      if (content) {
        // Parse all processes with their ports using the dedicated parser
        const { processes: parsedProcesses, pm2Home } = parseEcosystemConfig(content);
        if (pm2Home) {
          result.pm2Home = pm2Home;
        }
        if (parsedProcesses.length > 0) {
          // For processes that use vite and don't have a port, check their cwd for vite.config
          for (const proc of parsedProcesses) {
            if (proc.usesVite && !proc.port && proc.cwd) {
              const cwdPath = join(dirPath, proc.cwd);
              for (const viteConfig of ['vite.config.ts', 'vite.config.js']) {
                const viteConfigPath = join(cwdPath, viteConfig);
                if (existsSync(viteConfigPath)) {
                  const viteContent = await readFile(viteConfigPath, 'utf-8').catch(() => '');
                  const port = extractVitePort(viteContent);
                  if (port) {
                    proc.port = port;
                    break;
                  }
                }
              }
            }
            // Clean up internal properties
            delete proc.cwd;
            delete proc.usesVite;
              }

          result.processes = parsedProcesses;
          result.pm2ProcessNames = parsedProcesses.map(p => p.name);

          // Derive ports from parsed processes
          const apiProc = parsedProcesses.find(p => p.ports?.api);
          if (apiProc && !result.apiPort) {
            result.apiPort = apiProc.ports.api;
          }
          const uiProc = parsedProcesses.find(p => p.ports?.ui);
          if (uiProc && !result.uiPort) {
            result.uiPort = uiProc.ports.ui;
          }
          const devUiProc = parsedProcesses.find(p => p.ports?.devUi);
          if (devUiProc && !result.devUiPort) {
            result.devUiPort = devUiProc.ports.devUi;
          }
          // When app has API + Vite dev but no dedicated UI port,
          // the prod UI is served by the API server
          if (!result.uiPort && result.apiPort && result.devUiPort) {
            result.uiPort = result.apiPort;
          }
        }

        // Extract UI port from CLIENT_URL (still needed as it's not in process configs)
        const clientUrlMatch = content.match(/CLIENT_URL\s*:\s*['"]https?:\/\/[^:]+:(\d+)/);
        if (clientUrlMatch && !result.uiPort) {
          result.uiPort = parseInt(clientUrlMatch[1], 10);
        }

        configFiles.push(ecosystemFile);
      }
    }
  }

  // When config-file heuristics found a Vite dev port but no dedicated uiPort,
  // derive uiPort: API serves prod UI if present, otherwise devUiPort is the only UI
  if (!result.uiPort && result.devUiPort) {
    result.uiPort = result.apiPort ?? result.devUiPort;
  }

  emit('config', 'done', {
    message: configFiles.length ? `Found: ${configFiles.join(', ')}` : 'No config files found',
    uiPort: result.uiPort,
    devUiPort: result.devUiPort,
    apiPort: result.apiPort,
    pm2ProcessNames: result.pm2ProcessNames.length > 0 ? result.pm2ProcessNames : undefined,
    processes: result.processes.length > 0 ? result.processes : undefined,
    configFiles
  });

  // Step 5: Check PM2 status (skip for non-PM2 app types)
  if (!usesPm2(result.type)) {
    emit('pm2', 'skipped', { message: `Not applicable for ${result.type} apps` });
  } else {
    emit('pm2', 'running', { message: 'Checking PM2 processes...' });
    // Use custom PM2_HOME if detected from ecosystem config
    const pm2Env = result.pm2Home ? { ...process.env, PM2_HOME: result.pm2Home } : undefined;
    const { stdout } = await execPm2(['jlist'], pm2Env ? { env: pm2Env } : {}).catch(() => ({ stdout: '[]' }));
    // pm2 jlist may output ANSI codes and warnings before JSON
    let jsonStart = stdout.indexOf('[{');
    if (jsonStart < 0) {
      const emptyMatch = stdout.match(/\[\](?![0-9])/);
      jsonStart = emptyMatch ? stdout.indexOf(emptyMatch[0]) : -1;
    }
    const pm2Json = jsonStart >= 0 ? stdout.slice(jsonStart) : '[]';
    const pm2Processes = safeJSONParse(pm2Json, []);

    // Look for processes that might be this app
    const possibleNames = [
      result.name,
      result.name.toLowerCase(),
      result.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      `${result.name}-ui`,
      `${result.name}-api`
    ];

    const matchingProcesses = pm2Processes.filter(p =>
      possibleNames.some(name => p.name.includes(name) || name.includes(p.name))
    );

    if (matchingProcesses.length > 0) {
      result.pm2Status = matchingProcesses.map(p => ({
        name: p.name,
        status: p.pm2_env?.status,
        pid: p.pid
      }));
      // Use actual found PM2 process names
      result.pm2ProcessNames = matchingProcesses.map(p => p.name);
      emit('pm2', 'done', {
        message: `Found ${matchingProcesses.length} running process(es)`,
        pm2Status: result.pm2Status,
        pm2ProcessNames: result.pm2ProcessNames
      });
    } else {
      emit('pm2', 'done', { message: 'No matching PM2 processes found' });
      // Generate PM2 process names only if none found from ecosystem.config
      if (result.pm2ProcessNames.length === 0) {
        const baseName = result.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        if (result.type === 'vite+express') {
          result.pm2ProcessNames = [`${baseName}-ui`, `${baseName}-api`];
        } else {
          result.pm2ProcessNames = [baseName];
        }
      }
    }
  }

  // Step 6: Read README.md for description (fast, no AI needed)
  if (!result.description) {
    emit('readme', 'running', { message: 'Reading README.md...' });
    let foundReadme = false;
    for (const readmeFile of ['README.md', 'readme.md', 'Readme.md']) {
      const readmePath = join(dirPath, readmeFile);
      if (existsSync(readmePath)) {
        const content = await readFile(readmePath, 'utf-8').catch(() => '');
        if (content) {
          // Extract first paragraph or heading as description
          const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
          if (lines.length > 0) {
            result.description = lines[0].trim().substring(0, 200);
          }
          emit('readme', 'done', { message: `Found: ${readmeFile}`, description: result.description });
          foundReadme = true;
          break;
        }
      }
    }
    if (!foundReadme) {
      emit('readme', 'done', { message: 'No README found' });
    }
  } else {
    emit('readme', 'skipped', { message: 'Description already found in package.json' });
  }

  // Step 7: Detect app icon
  emit('icon', 'running', { message: 'Looking for app icon...' });
  const detectedIcon = await detectAppIcon(dirPath, result.type);
  if (detectedIcon) {
    result.appIconPath = detectedIcon;
    emit('icon', 'done', { message: `Found: ${basename(detectedIcon)}`, appIconPath: detectedIcon });
  } else {
    emit('icon', 'done', { message: 'No app icon found' });
  }

  // Complete
  socket.emit('detect:complete', {
    success: true,
    result
  });
}
