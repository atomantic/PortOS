import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir, userInfo } from 'os';
import { tokenize } from '../../scripts/lib/sourceTokens.js';
import { analyzeEcosystemPorts, planEcosystemPortEdits } from '../lib/ecosystemPortEdits.js';
import { listProcessesStrict } from './pm2.js';
import { safeJSONParse, tryReadFile, atomicWrite } from '../lib/fileUtils.js';
import { parseEnvContents } from '../lib/portosEnv.js';
import { detectAppIcon } from './appIconDetect.js';
import { NON_PM2_TYPES, usesPm2, DESKTOP_TYPES, isDesktopType } from './appProcessTypes.js';
export { NON_PM2_TYPES, usesPm2, DESKTOP_TYPES, isDesktopType };

/**
 * Language markers, checked FIRST: a repo's LANGUAGE beats its packaging, so a
 * Python service that also ships a `Dockerfile` classifies as `python` (the
 * common case) rather than as a Docker stack.
 */
const LANGUAGE_MARKERS = [
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']],
  ['go', ['go.mod']]
];

/** Compose/Dockerfile markers — only reached when no language marker matched. */
const DOCKER_MARKERS = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile'];

/**
 * Node entry points meaning "a process runs here". Checked BEFORE the docker
 * and static rules, and mapped to *no* classification rather than to a type: a
 * package-less repo shipping `server.mjs` is a Node app someone containerized
 * (or that also serves a page), and classifying it `docker`/`static` would
 * withdraw standardization from an app that genuinely wants it — the exact
 * false negative this predicate exists to avoid.
 *
 * The basename list is deliberately just `server`, the one name that can only
 * mean a server. `index`, `app`, and `main` are all at least as common as
 * browser scripts loaded by an `index.html`, and treating those as evidence
 * would leave real static sites unclassified (and still offered the Node
 * standardizer) — trading this rule's false negative for the very false
 * positive the issue was filed about.
 */
const SERVER_ENTRY_BASENAMES = ['server'];
const SERVER_ENTRY_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

const hasNodeServerEntry = (present) =>
  // ECOSYSTEM_CONFIG_FILENAMES (below) is the one list of PM2 config names — a
  // repo carrying one is unambiguously a PM2-managed process app.
  ECOSYSTEM_CONFIG_FILENAMES.some(name => present.has(name)) ||
  SERVER_ENTRY_BASENAMES.some(base => SERVER_ENTRY_EXTENSIONS.some(ext => present.has(`${base}${ext}`)));

/** The non-Node app types `classifyNonNodeType` can emit. */
export const NON_NODE_TYPES = new Set([...LANGUAGE_MARKERS.map(([type]) => type), 'docker', 'static']);

/**
 * Classify a repo's runtime from its top-level filenames, for repos that
 * carried no Node or Apple signal. Returns `null` when nothing matched — the
 * caller keeps `unknown` rather than guessing.
 *
 * @param {string[]} files Top-level entry names (from `readdir`).
 * @returns {'python'|'go'|'docker'|'static'|null}
 */
export function classifyNonNodeType(files) {
  const present = new Set(files || []);
  for (const [type, markers] of LANGUAGE_MARKERS) {
    if (markers.some(marker => present.has(marker))) return type;
  }
  if (hasNodeServerEntry(present)) return null;
  if (DOCKER_MARKERS.some(marker => present.has(marker))) return 'docker';
  if (present.has('index.html')) return 'static';
  return null;
}

/**
 * App types the PM2 standardizer must REFUSE: the Apple types (never PM2 at
 * all) plus the non-Node runtimes above. The standardizer's prompt opens with
 * "You are analyzing a Node.js application" — on a Python/Go/Docker/static repo
 * it doesn't fail, it confidently writes a Node ecosystem config into someone
 * else's project. That is what this predicate exists to stop.
 *
 * It is a DENY list rather than an allowlist of Node types because `type` is a
 * free-form string (`appSchema` in `server/lib/validation.js` defaults it to
 * `express` and accepts any value) PERSISTED on the app record. Installs
 * upgrade on their own schedule, so app records in the wild carry values this
 * file has never heard of — `unknown` from before this classification existed,
 * `node`/`react`/`web` from older detection, whatever a user typed. An
 * allowlist would silently withdraw standardization from every one of them.
 * Only a type we have positively identified as non-Node is refused; anything
 * unrecognized degrades to the previous behavior (offer it, and let the user
 * decide) instead of a button that quietly disappears on upgrade.
 */
export const NON_STANDARDIZABLE_TYPES = new Set([...NON_PM2_TYPES, ...NON_NODE_TYPES]);

/** Whether the PM2 standardizer (which writes a NODE ecosystem config) applies. */
export const isStandardizable = (type) => !NON_STANDARDIZABLE_TYPES.has(type);

/**
 * Detect an optional native Godot launch target alongside the repo's normal
 * web-process configuration.
 *
 * Mixed repos keep their ecosystem/Vite ports as the standard browser Launch,
 * while this target opens the game through a separate autorestart-off process.
 */
export function detectGodotNativeLaunch(dirPath) {
  const launcherPath = join(dirPath, 'scripts', 'game');
  const hasLauncher = existsSync(launcherPath);
  let projectPath = null;
  if (existsSync(join(dirPath, 'project.godot'))) {
    projectPath = 'project.godot';
  } else if (hasLauncher && existsSync(join(dirPath, 'game', 'project.godot'))) {
    projectPath = join('game', 'project.godot');
  }
  if (!projectPath) return null;

  const projectDir = dirname(projectPath);
  const slug = basename(dirPath)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    label: 'Godot',
    command: hasLauncher
      ? './scripts/game run'
      : `godot --path ${projectDir === '.' ? '.' : projectDir}`,
    processName: `${slug || 'godot'}-game`
  };
}

/**
 * Ecosystem config filenames in the order they're resolved. The READER
 * (parseEcosystemFromPath) and the WRITER (writeEcosystemPorts) must agree on
 * this order: if a repo has both, the writer has to rewrite the same file the
 * reader derives ports from, or a port edit lands in a file detection ignores
 * and silently reverts on the next refresh.
 */
const ECOSYSTEM_CONFIG_FILENAMES = ['ecosystem.config.js', 'ecosystem.config.cjs'];

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
 * Literal entries of apps arrays, shared by discovery and targeted writes.
 * The dependency-free source lexer keeps regexes and nested templates opaque.
 */
function ecosystemAppBlocks(content) {
  let tokens;
  try {
    tokens = tokenize(content, new Set(), { jsx: false });
  } catch {
    return [];
  }
  const punctuation = index => tokens[index]?.t === 'p' ? tokens[index].v : null;
  const isWord = (index, word) => tokens[index]?.t === 'id' && tokens[index].v === word;
  const isKey = (index, key) => ['id', 's'].includes(tokens[index]?.t) && tokens[index].v === key;
  const stack = [];
  const matching = new Map();
  const closes = { '}': '{', ']': '[', ')': '(' };
  for (let i = 0; i < tokens.length; i++) {
    const symbol = punctuation(i);
    if (['{', '[', '('].includes(symbol)) stack.push(i);
    else if (Object.hasOwn(closes, symbol)) {
      const open = stack.pop();
      if (punctuation(open) !== closes[symbol]) return [];
      matching.set(open, i);
    }
  }
  if (stack.length) return [];

  // Only module-scope bindings can supply the exported literal configuration.
  // Reading unrelated objects as apps would let an example shadow the real app.
  const bindings = new Map();
  const declarations = new Set();
  let exported = null;
  const isCompleteStatementValue = start => {
    const end = (matching.get(start) ?? start) + 1;
    const next = tokens[end];
    const continuesExpression = next?.t === 'tpl' ||
      (next?.t === 'id' && ['in', 'instanceof'].includes(next.v)) ||
      ['.', '?.', '[', '(', '+', '-', '*', '/', '%', '<', '>', '=', '&', '|', '^', '?'].includes(punctuation(end)) ||
      (punctuation(end) === '!' && punctuation(end + 1) === '=');
    return !next || [';', ',', '}'].includes(punctuation(end)) ||
      (!continuesExpression && /[\r\n]/.test(content.slice(tokens[end - 1].i, next.i)));
  };
  for (let i = 0; i < tokens.length; i++) {
    if (['const', 'let', 'var'].some(word => isWord(i, word)) && tokens[i + 1]?.t === 'id' && punctuation(i + 2) === '=') {
      const start = i + 3;
      // Resolve only a whole initializer, never the literal prefix of an expression.
      if (isCompleteStatementValue(start)) {
        bindings.set(tokens[i + 1].v, start);
        declarations.add(i + 1);
      }
    }
    if (isWord(i, 'module') && punctuation(i + 1) === '.' && isWord(i + 2, 'exports') && punctuation(i + 3) === '=') {
      exported = i + 4;
    } else if (isWord(i, 'export') && isWord(i + 1, 'default')) {
      exported = i + 2;
    }
    i = matching.get(i) ?? i;
  }
  // A declaration initializer is not a reliable name after any write. Be
  // conservative even for writes inside functions: configuration is never run.
  const openings = new Map([...matching].map(([open, close]) => [close, open]));
  const invalidate = (index, mutation = false) => {
    if (tokens[index]?.t !== 'id' || declarations.has(index) || ['.', '?.'].includes(punctuation(index - 1))) return;
    let name = tokens[index].v;
    const seen = new Set();
    while (name && !seen.has(name)) {
      seen.add(name);
      const value = bindings.get(name);
      bindings.delete(name);
      name = mutation && tokens[value]?.t === 'id' ? tokens[value].v : null;
    }
  };
  const invalidateTarget = index => {
    let root = index;
    let mutation = false;
    while (root >= 0) {
      const open = openings.get(root);
      if (punctuation(root) === ']' && open !== undefined &&
          (tokens[open - 1]?.t === 'id' || [']', ')'].includes(punctuation(open - 1)))) {
        root = open - 1;
        mutation = true;
      } else if (['.', '?.'].includes(punctuation(root - 1))) {
        root -= 2;
        mutation = true;
      } else break;
    }
    invalidate(root, mutation);
  };
  for (let i = 0; i < tokens.length; i++) {
    if (['++', '--'].includes(punctuation(i))) {
      invalidateTarget(i - 1);
      invalidate(i + 1);
    }
    if (punctuation(i) !== '=' || ['=', '>'].includes(punctuation(i + 1)) ||
        ['=', '!'].includes(punctuation(i - 1)) ||
        (['<', '>'].includes(punctuation(i - 1)) && punctuation(i - 2) !== punctuation(i - 1))) continue;
    let target = i - 1;
    while (['+', '-', '*', '/', '%', '&', '|', '^', '?', '<', '>'].includes(punctuation(target))) target--;
    const open = openings.get(target);
    if (['}', ']'].includes(punctuation(target)) && open !== undefined &&
        !(punctuation(target) === ']' && (tokens[open - 1]?.t === 'id' || [']', ')'].includes(punctuation(open - 1))))) {
      for (let j = open + 1; j < target; j++) invalidate(j);
    } else {
      invalidateTarget(target);
    }
  }
  const resolve = (index, seen = new Set()) => {
    const token = tokens[index];
    if (token?.t !== 'id') return index;
    if (seen.has(token.v) || !bindings.has(token.v)) return null;
    seen.add(token.v);
    return resolve(bindings.get(token.v), seen);
  };
  const expressionEnd = (start, limit) => {
    let end = start;
    while (end < limit && punctuation(end) !== ',') end = (matching.get(end) ?? end) + 1;
    return end;
  };
  const property = (object, key) => {
    let found = null;
    const limit = matching.get(object);
    for (let i = object + 1; i < limit;) {
      if (punctuation(i) === ',') { i++; continue; }
      const end = expressionEnd(i, limit);
      if (isKey(i, key)) {
        if (punctuation(i + 1) === ':') found = { start: i + 2, end };
        else if (tokens[i].t === 'id' && end === i + 1) found = { start: i, end };
      }
      i = end;
    }
    return found;
  };

  if (exported === null || !isCompleteStatementValue(exported)) return [];
  const config = resolve(exported);
  if (config === null) return [];
  const appsProperty = punctuation(config) === '{' ? property(config, 'apps') : null;
  if (appsProperty && (matching.get(appsProperty.start) ?? appsProperty.start) + 1 !== appsProperty.end) return [];
  const apps = appsProperty ? resolve(appsProperty.start) : config;
  if (punctuation(apps) !== '[') return [];
  const blocks = [];
  const limit = matching.get(apps);
  for (let i = apps + 1; i < limit;) {
    if (punctuation(i) === ',') { i++; continue; }
    const end = expressionEnd(i, limit);
    const object = (matching.get(i) ?? i) + 1 === end ? resolve(i) : null;
    if (punctuation(object) === '{') {
      const name = property(object, 'name');
      const token = name && name.end === name.start + 1 ? tokens[resolve(name.start)] : null;
      const value = token?.t === 's' ? token.v
        : token?.t === 'tpl' && token.exprs.length === 0 ? token.quasis[0] : null;
      if (value) {
        blocks.push({ start: tokens[object].i, end: tokens[matching.get(object)].i, name: value });
      }
    }
    i = end;
  }
  return blocks;
}

// Comment spans for best-effort PM2_HOME discovery when source tokenization fails.
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
 * Extract and resolve PM2_HOME path from ecosystem config content.
 * Supports optional declaration keywords (const|let|var), handles single, double,
 * and backtick quote styles, ignores commented lines and string literals containing
 * assignments, gives declarations precedence over environment properties, decodes
 * escapes in string literals, and expands template variables only on backtick template literals.
 *
 * @param {string} content
 * @param {Function} [currentUsername]
 * @returns {string|null}
 */
function extractPm2Home(content, currentUsername = () => {
  try {
    return userInfo()?.username || process.env.USERNAME || process.env.USER || 'user';
  } catch {
    return process.env.USERNAME || process.env.USER || 'user';
  }
}) {
  let tokens;
  try {
    tokens = tokenize(content, new Set(), { jsx: false });
  } catch {
    tokens = null;
  }

  if (tokens) {
    const resolveTemplate = (tok) => {
      let result = tok.quasis[0] ?? '';
      for (let k = 0; k < tok.exprs.length; k++) {
        const expr = tok.exprs[k].map(t => t.v).join('');
        if (expr === 'require(os).homedir()' || expr === 'require(node:os).homedir()' || expr === 'process.env.HOME') {
          result += homedir();
        } else if (expr === 'require(os).userInfo().username' || expr === 'require(node:os).userInfo().username') {
          result += currentUsername();
        } else {
          result += '${' + expr + '}';
        }
        result += tok.quasis[k + 1] ?? '';
      }
      return result;
    };

    const resolveValueToken = (tok) => {
      if (!tok) return null;
      if (tok.t === 's') return tok.v;
      if (tok.t === 'tpl') return resolveTemplate(tok);
      return null;
    };

    // 1. First pass: look for declarations / assignments (PM2_HOME = ...)
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.t === 'id' && tok.v === 'PM2_HOME') {
        if (tokens[i + 1]?.t === 'p' && tokens[i + 1]?.v === '=') {
          const val = resolveValueToken(tokens[i + 2]);
          if (val !== null) return val;
        }
      }
    }

    // 2. Second pass: look for object properties (PM2_HOME: ...)
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if ((tok.t === 'id' || tok.t === 's') && tok.v === 'PM2_HOME') {
        if (tokens[i + 1]?.t === 'p' && tokens[i + 1]?.v === ':') {
          const val = resolveValueToken(tokens[i + 2]);
          if (val !== null) return val;
        }
      }
    }

    return null;
  }

  // Regex fallback if tokenization failed on malformed JS
  const comments = commentRanges(content);
  const inComment = (pos) => comments.some(([s, e]) => pos >= s && pos < e);

  // First give precedence to actual PM2_HOME variable declarations / assignments:
  // e.g. const PM2_HOME = `...`, let PM2_HOME = '...', var PM2_HOME = "...", PM2_HOME = `...`
  const declRegex = /(?:(?:\bconst|\blet|\bvar)\s+)?\bPM2_HOME\b\s*=\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")/g;
  for (const match of content.matchAll(declRegex)) {
    if (inComment(match.index)) continue;
    if (match[1] !== undefined) {
      let homePath = match[1];
      homePath = homePath.replace(/\$\{require\(\s*['"](?:node:)?os['"]\s*\)\.homedir\(\)\}/g, homedir());
      homePath = homePath.replace(/\$\{require\(\s*['"](?:node:)?os['"]\s*\)\.userInfo\(\)\.username\}/g, currentUsername());
      homePath = homePath.replace(/\$\{process\.env\.HOME\}/g, homedir());
      return homePath;
    }
    return match[2] ?? match[3];
  }

  // Fallback to property assignment in env / object blocks:
  // e.g. PM2_HOME: `...`, PM2_HOME: '...', "PM2_HOME": "..."
  const propRegex = /['"]?\bPM2_HOME\b['"]?\s*:\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")/g;
  for (const match of content.matchAll(propRegex)) {
    if (inComment(match.index)) continue;
    if (match[1] !== undefined) {
      let homePath = match[1];
      homePath = homePath.replace(/\$\{require\(\s*['"](?:node:)?os['"]\s*\)\.homedir\(\)\}/g, homedir());
      homePath = homePath.replace(/\$\{require\(\s*['"](?:node:)?os['"]\s*\)\.userInfo\(\)\.username\}/g, currentUsername());
      homePath = homePath.replace(/\$\{process\.env\.HOME\}/g, homedir());
      return homePath;
    }
    return match[2] ?? match[3];
  }

  return null;
}

/**
 * Parse ecosystem.config.js/cjs to extract all processes with their ports
 * Uses AST analysis when attributable, with best-effort legacy discovery for
 * unsupported configuration. Writers never use the legacy fallback.
 * @returns {{ processes: Array, pm2Home: string|null }}
 */
export function parseEcosystemConfig(content) {
  const processes = [];

  const currentUsername = () => {
    try {
      return userInfo()?.username || process.env.USERNAME || process.env.USER || 'user';
    } catch {
      return process.env.USERNAME || process.env.USER || 'user';
    }
  };

  const pm2Home = extractPm2Home(content, currentUsername);
  const analyzed = analyzeEcosystemPorts(content);
  if (analyzed) return { pm2Home, processes: analyzed.map(({ sources, ...proc }) => ({
    ...proc, port: Object.values(proc.ports)[0] ?? null,
  })) };


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
    const flatEntries = portsBlock.matchAll(/(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\w+))\s*:\s*(\d+)/g);
    for (const entry of flatEntries) {
      const key = entry[1] ?? entry[2] ?? entry[3] ?? entry[4];
      portConstants[`PORTS.${key}`] = parseInt(entry[5], 10);
    }

    // Parse nested entries: key: { subkey: 5550 }
    const nestedMatches = portsBlock.matchAll(/(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\w+))\s*:\s*\{([^}]+)\}/g);
    for (const nestedMatch of nestedMatches) {
      const parentKey = nestedMatch[1] ?? nestedMatch[2] ?? nestedMatch[3] ?? nestedMatch[4];
      const nestedContent = nestedMatch[5];
      const nestedPorts = {};
      const subEntries = nestedContent.matchAll(/(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\w+))\s*:\s*(\d+)/g);
      for (const subEntry of subEntries) {
        const key = subEntry[1] ?? subEntry[2] ?? subEntry[3] ?? subEntry[4];
        const port = parseInt(subEntry[5], 10);
        portConstants[`PORTS.${parentKey}.${key}`] = port;
        nestedPorts[key] = port;
      }
      // Also store the whole nested object for `ports: PORTS.server` references
      portConstants[`PORTS.${parentKey}`] = nestedPorts;
    }
  }

  for (const { start, end, name: processName } of ecosystemAppBlocks(content)) {
    const appBlock = content.substring(start, end + 1);

    // Extract ports - first try the PortOS standard 'ports' object
    let ports = {};

    // Look for ports: { label: port, ... } object with literal values
    const portsObjMatch = appBlock.match(/\bports\s*:\s*\{([^}]+)\}/);
    if (portsObjMatch) {
      const portsContent = portsObjMatch[1];
      const portEntries = portsContent.matchAll(/(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\w+))\s*:\s*(\d+)/g);
      for (const entry of portEntries) {
        const key = entry[1] ?? entry[2] ?? entry[3] ?? entry[4];
        ports[key] = parseInt(entry[5], 10);
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

/** vite config filenames probed inside a PM2 process's `cwd`, in probe order. */
const VITE_CONFIG_FILENAMES = ['vite.config.ts', 'vite.config.js'];

/**
 * Resolve the dev-server port for a single parsed PM2 process by reading the
 * vite config in its `cwd`, relative to the app root `dirPath`.
 *
 * Only applies to a process that runs Vite and carries no port of its own — any
 * other process resolves to `null` so callers can assign unconditionally. The
 * first config file that yields a port wins; an unreadable file is treated as
 * empty (no port) and the next candidate is probed.
 *
 * @param {string} dirPath - app root the process's `cwd` is relative to
 * @param {{ usesVite?: boolean, port?: number|null, cwd?: string }} proc
 * @returns {Promise<number|null>} the resolved port, or null when none applies
 */
export async function resolveViteConfigPortForProcess(dirPath, proc) {
  if (!proc?.usesVite || proc.port || !proc.cwd) return null;
  const cwdPath = join(dirPath, proc.cwd);
  for (const viteConfig of VITE_CONFIG_FILENAMES) {
    const viteConfigPath = join(cwdPath, viteConfig);
    if (!existsSync(viteConfigPath)) continue;
    const viteContent = await readFile(viteConfigPath, 'utf-8').catch(() => '');
    const port = extractVitePort(viteContent);
    if (port) return port;
  }
  return null;
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
        const vitePort = await resolveViteConfigPortForProcess(dirPath, proc);
        if (vitePort) proc.port = vitePort;
        // Clean up internal properties before returning
        delete proc.cwd;
        delete proc.usesVite;
      }

      return { processes, pm2Home, portsEditable: analyzeEcosystemPorts(content) !== null };
    }
  }
  return { processes: [], pm2Home: null };
}

/** Pure compatibility writers use the same attributable, atomic edit plan. */
export function rewriteEcosystemPortsByProcess(content, edits) {
  const { content: updated, applied, unapplied } = planEcosystemPortEdits(content, [], edits);
  return { content: updated, applied, unapplied };
}

export function rewriteEcosystemPorts(content, remap) {
  return planEcosystemPortEdits(content, remap).content;
}

export async function writeEcosystemPorts(repoPath, remap) {
  const { file, changed } = await writeEcosystemPortEdits(repoPath, remap, []);
  return { file, changed };
}

export async function writeEcosystemPortsByProcess(repoPath, edits) {
  const { file, changed, applied, unapplied } = await writeEcosystemPortEdits(repoPath, [], edits);
  return { file, changed, applied, unapplied };
}

/** Plan every requested process/label against one original snapshot, then write once. */
export async function writeEcosystemPortEdits(repoPath, remap, edits) {
  for (const name of ECOSYSTEM_CONFIG_FILENAMES) {
    const filePath = join(repoPath, name);
    if (!existsSync(filePath)) continue;
    const content = await readFile(filePath, 'utf-8');
    const { content: updated, ...result } = planEcosystemPortEdits(content, remap, edits);
    const changed = updated !== content;
    if (changed) await atomicWrite(filePath, updated);
    return { file: name, changed, ...result };
  }
  return { file: null, changed: false, remapApplied: false, applied: [], unapplied: edits || [] };
}

// Each detection step mutates the shared `result` and emits its own `detect:step`
// frames. A step returning `false` means the stream must stop (validate only).

async function validateStep(socket, dirPath, result, emit) {
  emit('validate', 'running', { message: 'Validating directory path...' });

  const fail = (message) => {
    emit('validate', 'error', { message });
    socket.emit('detect:complete', { success: false, error: message });
    return false;
  };

  if (!existsSync(dirPath)) return fail('Directory does not exist');
  const stats = await stat(dirPath);
  if (!stats.isDirectory()) return fail('Path is not a directory');

  emit('validate', 'done', { message: 'Valid directory' });
  result.name = basename(dirPath);
  return true;
}

/** XcodeGen `project.yml`: name, platform-derived type, and build command. */
async function applyXcodeGenProject(dirPath, result) {
  const ymlContent = await readFile(join(dirPath, 'project.yml'), 'utf-8').catch(() => '');
  const nameMatch = ymlContent.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const platformMatch = ymlContent.match(/platform:\s*\[?([^\]\n]+)/);
  const platforms = platformMatch ? platformMatch[1].toLowerCase() : '';
  if (platforms.includes('ios') && !platforms.includes('macos')) result.type = 'ios-native';
  else if (platforms.includes('macos') && !platforms.includes('ios')) result.type = 'macos-native';
  else result.type = 'xcode';

  result.buildCommand = 'xcodebuild -scheme ' + result.name + ' build';
}

/** Swift/Xcode projects are recognized from directory contents alone. */
async function detectSwiftProject(dirPath, files, result) {
  const hasXcodeproj = files.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
  const hasProjectYml = files.includes('project.yml');
  const hasPackageSwift = files.includes('Package.swift');
  if (!hasXcodeproj && !hasProjectYml && !hasPackageSwift) return;

  if (hasProjectYml) {
    await applyXcodeGenProject(dirPath, result);
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

/** Returns the directory entry names so later steps can reuse them. */
async function filesStep(dirPath, result, emit) {
  emit('files', 'running', { message: 'Scanning directory...' });
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files = entries.map(e => e.name);
  emit('files', 'done', { message: `Found ${files.length} files`, files: files.slice(0, 20) });
  await detectSwiftProject(dirPath, files, result);
  return files;
}

function applyPackageJson(pkg, result) {
  result.name = pkg.name || result.name;
  result.description = pkg.description || '';

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vite && deps.express) result.type = 'vite+express';
  else if (deps.vite || deps.react || deps.vue) result.type = 'vite';
  else if (deps.express || deps.fastify || deps.koa) result.type = 'single-node-server';
  else if (deps.next) result.type = 'nextjs';

  const scripts = pkg.scripts || {};
  if (scripts.dev) result.startCommands.push('npm run dev');
  if (scripts.start && !scripts.dev) result.startCommands.push('npm start');
  if (scripts.build) result.buildCommand = 'npm run build';
}

async function packageStep(dirPath, files, result, emit) {
  emit('package', 'running', { message: 'Reading package.json...' });
  const pkgPath = join(dirPath, 'package.json');

  if (!existsSync(pkgPath)) {
    // No package.json ⇒ nothing Node owns this repo, so fall back to marker-file
    // classification for the common non-Node runtimes. Without this, a Python
    // service / Go binary / Docker stack / static site all landed on `unknown`
    // and were offered Node PM2 standardization. Guarded on `unknown` so an
    // Apple type already resolved in the files step (a Swift repo that also ships a
    // Dockerfile) isn't overwritten.
    const nonNodeType = result.type === 'unknown' ? classifyNonNodeType(files) : null;
    if (nonNodeType) result.type = nonNodeType;
    emit('package', 'done', {
      message: nonNodeType ? `No package.json — detected ${nonNodeType} project` : 'No package.json found',
      type: result.type
    });
    return;
  }

  const content = await tryReadFile(pkgPath);
  if (!content) return;
  const pkg = safeJSONParse(content, null);
  if (!pkg) {
    emit('package', 'error', { message: 'Invalid package.json format' });
    return;
  }
  applyPackageJson(pkg, result);
  emit('package', 'done', {
    message: `Found: ${result.name}`,
    name: result.name,
    description: result.description,
    type: result.type,
    startCommands: result.startCommands
  });
}

async function applyEnvPorts(dirPath, result, configFiles) {
  const envPath = join(dirPath, '.env');
  if (!existsSync(envPath)) return;
  const content = await readFile(envPath, 'utf-8').catch(() => '');
  const env = parseEnvContents(content);
  const readTcpPort = (key) => {
    const value = env.get(key);
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  };
  const apiPort = readTcpPort('PORT');
  if (apiPort !== null) result.apiPort = apiPort;
  const devUiPort = readTcpPort('VITE_PORT');
  if (devUiPort !== null) result.devUiPort = devUiPort;
  configFiles.push('.env');
}

async function applyViteConfigPorts(dirPath, result, configFiles) {
  for (const viteConfig of ['vite.config.js', 'vite.config.ts']) {
    const configPath = join(dirPath, viteConfig);
    if (!existsSync(configPath)) continue;
    const content = await readFile(configPath, 'utf-8').catch(() => '');
    const portMatch = content.match(/port\s*:\s*(\d+)/);
    if (portMatch) result.devUiPort = parseInt(portMatch[1], 10);
    configFiles.push(viteConfig);
  }
}

/** Fold the parsed ecosystem processes into `result`, deriving any unset ports. */
async function applyParsedProcesses(dirPath, parsedProcesses, result) {
  // For processes that use vite and don't have a port, check their cwd for vite.config
  for (const proc of parsedProcesses) {
    const vitePort = await resolveViteConfigPortForProcess(dirPath, proc);
    if (vitePort) proc.port = vitePort;
    // Clean up internal properties
    delete proc.cwd;
    delete proc.usesVite;
  }

  result.processes = parsedProcesses;
  result.pm2ProcessNames = parsedProcesses.map(p => p.name);

  const apiProc = parsedProcesses.find(p => p.ports?.api);
  if (apiProc && !result.apiPort) result.apiPort = apiProc.ports.api;
  const uiProc = parsedProcesses.find(p => p.ports?.ui);
  if (uiProc && !result.uiPort) result.uiPort = uiProc.ports.ui;
  const devUiProc = parsedProcesses.find(p => p.ports?.devUi);
  if (devUiProc && !result.devUiPort) result.devUiPort = devUiProc.ports.devUi;
  // When app has API + Vite dev but no dedicated UI port,
  // the prod UI is served by the API server
  if (!result.uiPort && result.apiPort && result.devUiPort) result.uiPort = result.apiPort;
}

async function applyEcosystemConfig(dirPath, result, configFiles) {
  for (const ecosystemFile of ECOSYSTEM_CONFIG_FILENAMES) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (!existsSync(ecosystemPath)) continue;
    const content = await readFile(ecosystemPath, 'utf-8').catch(() => '');
    if (!content) continue;

    const { processes: parsedProcesses, pm2Home } = parseEcosystemConfig(content);
    if (pm2Home) result.pm2Home = pm2Home;
    if (parsedProcesses.length > 0) await applyParsedProcesses(dirPath, parsedProcesses, result);

    // Extract UI port from CLIENT_URL (still needed as it's not in process configs)
    const clientUrlMatch = content.match(/CLIENT_URL\s*:\s*['"]https?:\/\/[^:]+:(\d+)/);
    if (clientUrlMatch && !result.uiPort) result.uiPort = parseInt(clientUrlMatch[1], 10);

    configFiles.push(ecosystemFile);
  }
}

async function configStep(dirPath, result, emit) {
  emit('config', 'running', { message: 'Checking configuration files...' });
  const configFiles = [];

  await applyEnvPorts(dirPath, result, configFiles);
  await applyViteConfigPorts(dirPath, result, configFiles);
  await applyEcosystemConfig(dirPath, result, configFiles);

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
}

/** Generate PM2 process names only when the ecosystem config supplied none. */
function defaultPm2ProcessNames(result) {
  const baseName = result.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return result.type === 'vite+express' ? [`${baseName}-ui`, `${baseName}-api`] : [baseName];
}

async function pm2Step(result, emit) {
  if (!usesPm2(result.type)) {
    emit('pm2', 'skipped', { message: `Not applicable for ${result.type} apps` });
    return;
  }

  emit('pm2', 'running', { message: 'Checking PM2 processes...' });
  // `listProcessesStrict()` returns `null` when the read itself FAILED (vs
  // `[]` for a successful read with no processes) — the absent-vs-empty
  // contract from issue #968, now the one non-test owner of raw `pm2 jlist`
  // execution/parsing alongside `autofixer/shared.js` (#8164). Use custom
  // PM2_HOME if detected from ecosystem config.
  const pm2Processes = await listProcessesStrict(result.pm2Home || null);

  if (pm2Processes === null) {
    // A failed read must not be reported as "no matching processes" — that
    // would silently drop the pm2ProcessNames the ecosystem config already
    // found. Leave result.pm2Status/pm2ProcessNames as already derived and
    // surface the read failure on its own stage.
    emit('pm2', 'error', { message: 'PM2 process read failed — status is unavailable' });
    return;
  }

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

  if (matchingProcesses.length === 0) {
    emit('pm2', 'done', { message: 'No matching PM2 processes found' });
    if (result.pm2ProcessNames.length === 0) result.pm2ProcessNames = defaultPm2ProcessNames(result);
    return;
  }

  result.pm2Status = matchingProcesses.map(p => ({ name: p.name, status: p.status, pid: p.pid }));
  // Use actual found PM2 process names
  result.pm2ProcessNames = matchingProcesses.map(p => p.name);
  emit('pm2', 'done', {
    message: `Found ${matchingProcesses.length} running process(es)`,
    pm2Status: result.pm2Status,
    pm2ProcessNames: result.pm2ProcessNames
  });
}

/** Fast, no-AI description: the first non-heading, non-image README line. */
async function readmeStep(dirPath, result, emit) {
  if (result.description) {
    emit('readme', 'skipped', { message: 'Description already found in package.json' });
    return;
  }

  emit('readme', 'running', { message: 'Reading README.md...' });
  for (const readmeFile of ['README.md', 'readme.md', 'Readme.md']) {
    const readmePath = join(dirPath, readmeFile);
    if (!existsSync(readmePath)) continue;
    const content = await readFile(readmePath, 'utf-8').catch(() => '');
    if (!content) continue;
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
    if (lines.length > 0) result.description = lines[0].trim().substring(0, 200);
    emit('readme', 'done', { message: `Found: ${readmeFile}`, description: result.description });
    return;
  }
  emit('readme', 'done', { message: 'No README found' });
}

async function iconStep(dirPath, result, emit) {
  emit('icon', 'running', { message: 'Looking for app icon...' });
  const detectedIcon = await detectAppIcon(dirPath, result.type);
  if (!detectedIcon) {
    emit('icon', 'done', { message: 'No app icon found' });
    return;
  }
  result.appIconPath = detectedIcon;
  emit('icon', 'done', { message: `Found: ${basename(detectedIcon)}`, appIconPath: detectedIcon });
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
    nativeLaunch: null,
    appIconPath: null
  };

  if (!await validateStep(socket, dirPath, result, emit)) return;

  const files = await filesStep(dirPath, result, emit);
  const godotNativeLaunch = detectGodotNativeLaunch(dirPath);
  await packageStep(dirPath, files, result, emit);
  // Native game launch is additive: web ports/processes remain the standard
  // managed app while the game gets its own explicit action.
  if (godotNativeLaunch) result.nativeLaunch = godotNativeLaunch;

  await configStep(dirPath, result, emit);
  await pm2Step(result, emit);
  await readmeStep(dirPath, result, emit);
  await iconStep(dirPath, result, emit);

  socket.emit('detect:complete', { success: true, result });
}
