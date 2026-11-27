#!/usr/bin/env node
/**
 * Generate `server/lib/promptStageCallSites.generated.json` — the DERIVED
 * deletion-protection set for prompt stages (#3335).
 *
 * Why a second set at all: `server/lib/promptSystemStages.js` holds the
 * CURATED system-stage table, which drives the Prompt Manager's SYSTEM badge
 * and its "System only" filter. Roughly 100 of the 127 shipped stages are also
 * resolved by literal key somewhere in `server/`, and deleting one silently
 * breaks the feature that names it — but badging ~100 of 127 rows would make
 * the badge and the filter meaningless. So the two concerns are split: the
 * curated table stays small and user-facing, and THIS manifest is the
 * machine-derived "referenced by source" index the DELETE guard also consults.
 *
 * Why generated rather than hand-maintained: a hand list is exactly the drift
 * this exists to end, and a runtime source scan on every DELETE is slow and
 * unavailable in a packaged build. `scripts/generate-prompt-stage-call-sites.test.js`
 * regenerates and fails on drift, so a new literal-key call site can't land
 * without the manifest catching up.
 *
 * Why a real parse rather than a regex tokenizer (#6624): the previous scanner
 * walked comments and quoted spans with one alternation, which could LOSE
 * PHASE — a backtick inside a regex literal opened a phantom template that ran
 * to the next backtick, several lines and one `//` comment later, swallowing
 * every call site in between. That failure is stable rather than flaky, so the
 * drift test reports it as "the manifest is stale" and the documented fix
 * ("run the generator and commit the result") ACCEPTS the wrong manifest,
 * quietly unprotecting a shipped stage. It cost `cos-agent-briefing` its only
 * reference during a refactor that changed no call site at all. A parser
 * cannot lose phase, and comments simply aren't in the AST, so the scanner's
 * comment-skipping special case disappears with it.
 *
 * Usage:  node scripts/generate-prompt-stage-call-sites.js
 *
 * Output shape: `{ "<stage-key>": ["server/services/foo.js", …] }`, keys and
 * paths both sorted so the file is byte-stable across installs.
 */

import { trackedFiles } from './lib/trackedFiles.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { escapeRegExp } from '../server/lib/textUtils.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this script's own location. */
export const REPO_ROOT = resolve(HERE, '..');

/**
 * `@babel/parser` is a devDependency of the `server` workspace, not of the
 * repo root. A bare `import '@babel/parser'` from `scripts/` would search the
 * root and miss the server installation. Anchoring the resolver at
 * `server/package.json` finds it under both plain Node and Vitest.
 */
const requireFromServerWorkspace = createRequire(join(REPO_ROOT, 'server', 'package.json'));
const { parse } = requireFromServerWorkspace('@babel/parser');

/** Manifest location, repo-relative (posix) so it reads the same on Windows. */
export const MANIFEST_RELATIVE_PATH = 'server/lib/promptStageCallSites.generated.json';

/** The command a failing drift test tells the author to run. */
export const REGENERATE_COMMAND = 'node scripts/generate-prompt-stage-call-sites.js';

/** Redacted, phase-level evidence, including when synchronous work overruns. */
export function createStageScanDiagnostics({ budgetMs = Infinity, onProgress = () => {}, now = () => performance.now() } = {}) {
  const started = now();
  const initialCpu = process.cpuUsage();
  const phaseMs = {};
  let counts = { sources: 0, sourceBytes: 0, scannedSources: 0, nodes: 0 };
  let lastReport = started;
  let peakHeapBytes = 0;
  let peakRssBytes = 0;
  let phase = 'initialization';

  const snapshot = () => {
    const memory = process.memoryUsage();
    peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    const cpu = process.cpuUsage(initialCpu);
    return {
      phase, ...counts, elapsedMs: Math.round(now() - started),
      phaseMs: Object.fromEntries(Object.entries(phaseMs).map(([name, ms]) => [name, Math.round(ms)])),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      sampledPeakHeapMiB: Math.round(peakHeapBytes / 1024 / 1024),
      sampledPeakRssMiB: Math.round(peakRssBytes / 1024 / 1024),
    };
  };
  const report = () => {
    lastReport = now();
    const progress = snapshot();
    onProgress(progress);
    return progress;
  };
  return {
    measure(name, operation) {
      phase = name;
      const start = now();
      let result;
      try {
        result = operation();
      } finally {
        phaseMs[name] = (phaseMs[name] ?? 0) + now() - start;
      }
      if (now() - started > budgetMs) {
        throw new Error(`Prompt-stage scan exceeded ${budgetMs}ms during ${name}: ${JSON.stringify(report())}`);
      }
      if (now() - lastReport >= 5000) report();
      return result;
    },
    checkpoint(update) {
      counts = { ...counts, ...update };
      // Sampling every file adds an OS memory query to each parse. Keep
      // periodic samples without charging the scan for thousands of queries.
      if (update.scannedSources && update.scannedSources % 64 === 0) snapshot();
    },
    finish: report,
  };
}

/**
 * Call shapes whose FIRST argument is a stage key. These are only used to
 * discover keys that the shipped `stage-config.json` doesn't list (a call site
 * for a stage whose config entry was never shipped); the reference index
 * itself is built from string-literal matching, which is agnostic to how the
 * key reaches the resolver (direct call, a `{ idea: 'pipeline-idea-expansion' }`
 * lookup table, a `const STAGE = '…'` module constant, …).
 */
const STAGE_CALL_NAMES = new Set([
  'getStage',
  'getStageTemplate',
  'buildPrompt',
  'runStage',
  'runStagedLLM',
  'runStageScopedInlineLLM',
  'previewPrompt',
  'resolveStageContext',
  'resolveJudgeForStage',
]);
const STAGE_CALL_RE = new RegExp([...STAGE_CALL_NAMES].join('|'));

/**
 * A static hyphenated prefix immediately before an interpolation —
 * `` `pipeline-panel-${personaId}` ``. Stages reached this way (the
 * reader-panel personas) have NO literal key anywhere in source, so a
 * literal-only scan would leave them unprotected. Every known key under the
 * prefix counts as referenced by that file.
 *
 * This deliberately over-matches: a `` source: `writers-room-${kind}` ``
 * telemetry tag counts too. Over-protection is the safe failure mode here —
 * the cost is an extra path in the delete-confirm dialog, versus a silently
 * deletable stage that breaks a feature.
 */
const TEMPLATE_PREFIX_RE = /(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+-)\$\{/g;

/**
 * Files excluded from the scan. `promptSystemStages.js` is the curated
 * registry (plus prose naming example stages) — listing itself as a "call
 * site" for the ten curated keys is noise, not a reference.
 */
const EXCLUDED_SOURCES = new Set(['server/lib/promptSystemStages.js']);

/** Stage keys PortOS ships, from the reference stage config. */
export function readShippedStageKeys(repoRoot = REPO_ROOT) {
  const configPath = join(repoRoot, 'data.reference', 'prompts', 'stage-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return Object.keys(config.stages || {});
}

/**
 * Git-tracked, non-test `.js` sources under `server/`, read into memory.
 *
 * Scoped to `git ls-files` rather than a filesystem walk on purpose: a raw
 * walk picks up `node_modules`, build output, and CoS-agent worktrees under
 * `data/`, which would make the manifest non-deterministic across installs.
 */
export function collectServerSources(repoRoot = REPO_ROOT, { diagnostics = createStageScanDiagnostics() } = {}) {
  const tracked = diagnostics.measure('inventory', () => trackedFiles(repoRoot, ['server/*.js', ':!server/*.test.js'])
    .filter((p) => !EXCLUDED_SOURCES.has(p)));

  diagnostics.checkpoint({ sources: tracked.length });
  return diagnostics.measure('read', () => tracked.map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') })));
}

// These ubiquitous Babel nodes are leaves with the module + JSX parser below.
// Avoid allocating a values array just to inspect their scalar/position metadata.
// Other node shapes, including parser additions, still use the generic walk.
const LEAF_NODE_TYPES = new Set([
  'BigIntLiteral', 'BooleanLiteral', 'Identifier', 'JSXIdentifier', 'JSXText',
  'NullLiteral', 'NumericLiteral', 'RegExpLiteral', 'StringLiteral', 'TemplateElement',
]);

/** Visit each node in one traversal without building a flat node list. */
function walkNodes(root, visit) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    if (LEAF_NODE_TYPES.has(node.type)) continue;
    // Babel's node metadata has no type and cannot contain references.
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (typeof item?.type === 'string') pending.push(item);
        }
      } else if (typeof child?.type === 'string') {
        pending.push(child);
      }
    }
  }
}

/**
 * Parse a candidate source.
 *
 * A candidate that fails to parse throws with the file name so the scan
 * cannot silently drop its possible references.
 */
function parseSource(path, source) {
  // Babel's error location omits the source path.
  try {
    // References come from syntax nodes, so attaching comments to them is wasted work.
    return parse(source, { sourceType: 'module', plugins: ['jsx'], attachComment: false, locations: false }).program;
  } catch (err) {
    throw new Error(`${path}: ${err.message}`, { cause: err });
  }
}

/** The callee name of a call expression, for both `fn(…)` and `obj.fn(…)`. */
function calleeName(callee) {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed) return callee.property?.name ?? null;
  return null;
}

const STRING_ESCAPE_RE = /\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g;
const SIMPLE_ESCAPES = new Map([
  ['0', '\0'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'],
  ['\r', ''], ['\n', ''], ['\r\n', ''], ['\u2028', ''], ['\u2029', ''],
]);

// Decode potential string escapes for the prefilter only. Running across the
// whole source can add candidates, since only Babel decides which text is code.
function decodeSourceEscapes(source) {
  return source.replace(STRING_ESCAPE_RE, (match) => {
    const sequence = match.slice(1);
    if (sequence.length === 1 || sequence === '\r\n') return SIMPLE_ESCAPES.get(sequence) ?? sequence;

    const hex = sequence.startsWith('u{') ? sequence.slice(2, -1) : sequence.slice(1);
    const point = Number.parseInt(hex, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

/**
 * Build the `stageKey -> [source paths]` index.
 *
 * @param {object} args
 * @param {string[]} args.shippedStageKeys keys from the reference stage config
 * @param {{path: string, source: string}[]} args.sources server sources to scan
 * @returns {Record<string, string[]>} sorted keys, sorted paths, keys with zero
 *   references omitted
 */
export function buildStageCallSites({ shippedStageKeys, sources, diagnostics = createStageScanDiagnostics() }) {
  // A call site may name a stage whose config entry was never shipped; those
  // keys still deserve protection if the user (or a migration) creates them.
  const keys = new Set(shippedStageKeys);
  const literals = new Map();
  const prefixes = new Map();
  const record = (references, key, path) => {
    const current = references.get(key);
    if (current === undefined) references.set(key, path);
    else if (typeof current !== 'string') current.add(path);
    else if (current !== path) references.set(key, new Set([current, path]));
  };
  // Most literal values occur in only one file; only shared values need sets.
  const pathsFor = (value) => typeof value === 'string' ? [value] : value ?? [];
  let nodes = 0;
  let scannedSources = 0;
  diagnostics.checkpoint({ sources: sources.length, sourceBytes: sources.reduce((n, { source }) => n + Buffer.byteLength(source), 0) });
  // Discover all unshipped keys first, retaining candidate ASTs for pass two.
  const candidatesWithCalls = new Map();
  const parseCandidate = ({ path, source }) => {
    const ast = diagnostics.measure('parse', () => parseSource(path, source));
    scannedSources += 1;
    return ast;
  };
  for (const entry of sources) {
    const { source } = entry;
    // An escaped identifier can name a resolver without spelling it in source.
    if (!STAGE_CALL_RE.test(source)
      && !(source.includes('\\u') && STAGE_CALL_RE.test(decodeSourceEscapes(source)))) continue;
    const ast = parseCandidate(entry);
    candidatesWithCalls.set(entry, ast);
    diagnostics.measure('discover', () => walkNodes(ast, (node) => {
      nodes += 1;
      if (node.type !== 'CallExpression' || !STAGE_CALL_NAMES.has(calleeName(node.callee))) return;
      const [first] = node.arguments;
      if (first?.type === 'StringLiteral') keys.add(first.value);
    }));
    diagnostics.checkpoint({ nodes, scannedSources });
  }

  // Quote boundaries avoid parsing files that only mention a key as a substring.
  const quote = /['"`]/.source;
  const keyPattern = keys.size
    ? new RegExp(`${quote}(?:${[...keys].map(escapeRegExp).join('|')})${quote}`)
    : /(?!)/;
  const hasTemplatePrefix = (source) => {
    if (!source.includes('-${')) return false;
    for (const [, prefix] of source.matchAll(TEMPLATE_PREFIX_RE)) {
      for (const key of keys) {
        if (key.length > prefix.length && key.startsWith(prefix)) return true;
      }
    }
    return false;
  };
  for (const entry of sources) {
    const { path, source } = entry;
    const astWithCalls = candidatesWithCalls.get(entry);
    if (!astWithCalls && !diagnostics.measure('prefilter', () =>
      keyPattern.test(source) || hasTemplatePrefix(source)
      // JSX attribute entity references are cooked by Babel as string literals.
      || /&(?:#\w+|[A-Za-z]+);/.test(source)
      || ((source.includes('\\') || source.includes('\r'))
        && keyPattern.test(decodeSourceEscapes(source.replace(/\r\n?/g, '\n'))))
    )) continue;

    const ast = astWithCalls ?? parseCandidate(entry);
    candidatesWithCalls.delete(entry);
    diagnostics.measure('walk', () => walkNodes(ast, (node) => {
      nodes += 1;
      if (node.type === 'StringLiteral' && keys.has(node.value)) {
        record(literals, node.value, path);
        return;
      }
      if (node.type !== 'TemplateLiteral') return;

      // A template with no interpolation is just a string spelled differently.
      if (node.expressions.length === 0) {
        const only = node.quasis[0]?.value?.cooked;
        if (keys.has(only)) record(literals, only, path);
        return;
      }

      // Rebuild the template's SHAPE — static chunks with a placeholder where
      // each interpolation sat — so a prefix is still recognized as sitting
      // immediately before a `${`, wherever in the template it appears.
      const shape = node.quasis.map((quasi) => quasi.value.raw).join('${}');
      for (const [, prefix] of shape.matchAll(TEMPLATE_PREFIX_RE)) {
        record(prefixes, prefix, path);
      }
    }));
    diagnostics.checkpoint(astWithCalls ? { nodes } : { nodes, scannedSources });
  }

  // Combine exact literal matches with interpolated prefix references.
  return diagnostics.measure('resolve', () => {
    const index = new Map();
    for (const key of keys) {
      const paths = new Set(pathsFor(literals.get(key)));
      for (const [prefix, references] of prefixes) {
        if (key.length > prefix.length && key.startsWith(prefix)) {
          for (const path of pathsFor(references)) paths.add(path);
        }
      }
      if (paths.size) index.set(key, paths);
    }
    return Object.fromEntries([...index.keys()].sort().map((key) => [key, [...index.get(key)].sort()]));
  });
}

/** Full generation pass against a checkout. */
export function generateStageCallSites(repoRoot = REPO_ROOT, { diagnostics = createStageScanDiagnostics() } = {}) {
  return buildStageCallSites({
    shippedStageKeys: diagnostics.measure('config', () => readShippedStageKeys(repoRoot)),
    sources: collectServerSources(repoRoot, { diagnostics }),
    diagnostics,
  });
}

/** The manifest as currently checked in. */
export function readStageCallSitesManifest(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(join(repoRoot, MANIFEST_RELATIVE_PATH), 'utf8'));
}

/** Serialized form — one place so the writer and the drift test agree. */
export const serializeManifest = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

function main() {
  const manifest = generateStageCallSites();
  writeFileSync(join(REPO_ROOT, MANIFEST_RELATIVE_PATH), serializeManifest(manifest), 'utf8');
  const paths = new Set(Object.values(manifest).flat());
  console.log(`📜 Wrote ${MANIFEST_RELATIVE_PATH}: ${Object.keys(manifest).length} stages across ${paths.size} files`);
}

if (isDirectlyInvoked(import.meta.url)) main();
