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

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this script's own location. */
export const REPO_ROOT = resolve(HERE, '..');

/**
 * `@babel/parser` is a devDependency of the `server` workspace, not of the
 * repo root — CI installs `server/`, `client/`, and `autofixer/` and never the
 * root, so a bare `import '@babel/parser'` from `scripts/` would resolve
 * against the (pm2-only) root tree and fail. Anchoring the resolver at
 * `server/package.json` finds it under both plain Node and Vitest.
 */
const requireFromServerWorkspace = createRequire(join(REPO_ROOT, 'server', 'package.json'));
const { parse } = requireFromServerWorkspace('@babel/parser');

/** Manifest location, repo-relative (posix) so it reads the same on Windows. */
export const MANIFEST_RELATIVE_PATH = 'server/lib/promptStageCallSites.generated.json';

/** The command a failing drift test tells the author to run. */
export const REGENERATE_COMMAND = 'node scripts/generate-prompt-stage-call-sites.js';

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
export function collectServerSources(repoRoot = REPO_ROOT) {
  const tracked = execFileSync('git', ['ls-files', '--', 'server'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((p) => p.endsWith('.js') && !p.endsWith('.test.js') && !EXCLUDED_SOURCES.has(p));

  return tracked.map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }));
}

/** Keys babel hangs off a node that are never child AST nodes worth walking. */
const NON_AST_KEYS = new Set(['loc', 'leadingComments', 'trailingComments', 'innerComments', 'extra']);

/** Every node in a parsed program, depth-first. Avoids a `@babel/traverse` dependency. */
function* walkNodes(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walkNodes(child);
    return;
  }
  if (typeof node.type !== 'string') return;
  yield node;
  for (const key of Object.keys(node)) {
    if (NON_AST_KEYS.has(key)) continue;
    yield* walkNodes(node[key]);
  }
}

/**
 * Parse one source into its node list.
 *
 * A source that will not parse throws, naming the file: contributing nothing
 * would silently drop every call site in it, which is the exact failure this
 * rewrite exists to end.
 */
function parseNodes(path, source) {
  // Outside any request lifecycle, and babel's message names a line/column but
  // not the file — which of 500 sources broke is the only useful half.
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
    return [...walkNodes(ast.program)];
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

/**
 * Build the `stageKey -> [source paths]` index.
 *
 * @param {object} args
 * @param {string[]} args.shippedStageKeys keys from the reference stage config
 * @param {{path: string, source: string}[]} args.sources server sources to scan
 * @returns {Record<string, string[]>} sorted keys, sorted paths, keys with zero
 *   references omitted
 */
export function buildStageCallSites({ shippedStageKeys, sources }) {
  const parsed = sources.map(({ path, source }) => ({ path, nodes: parseNodes(path, source) }));

  // A call site may name a stage whose config entry was never shipped; those
  // keys still deserve protection if the user (or a migration) creates them.
  const keys = new Set(shippedStageKeys);
  for (const { nodes } of parsed) {
    for (const node of nodes) {
      if (node.type !== 'CallExpression') continue;
      if (!STAGE_CALL_NAMES.has(calleeName(node.callee))) continue;
      const [first] = node.arguments;
      if (first?.type === 'StringLiteral') keys.add(first.value);
    }
  }

  const index = new Map();
  const record = (key, path) => {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(path);
  };

  for (const { path, nodes } of parsed) {
    for (const node of nodes) {
      if (node.type === 'StringLiteral') {
        if (keys.has(node.value)) record(node.value, path);
        continue;
      }
      if (node.type !== 'TemplateLiteral') continue;

      // A template with no interpolation is just a string spelled differently.
      if (node.expressions.length === 0) {
        const only = node.quasis[0]?.value?.cooked;
        if (only != null && keys.has(only)) record(only, path);
        continue;
      }

      // Rebuild the template's SHAPE — static chunks with a placeholder where
      // each interpolation sat — so a prefix is still recognized as sitting
      // immediately before a `${`, wherever in the template it appears.
      const shape = node.quasis.map((quasi) => quasi.value.raw).join('${}');
      for (const [, prefix] of shape.matchAll(TEMPLATE_PREFIX_RE)) {
        for (const key of keys) {
          if (key.length > prefix.length && key.startsWith(prefix)) record(key, path);
        }
      }
    }
  }

  return Object.fromEntries(
    [...index.keys()].sort().map((key) => [key, [...index.get(key)].sort()]),
  );
}

/** Full generation pass against a checkout. */
export function generateStageCallSites(repoRoot = REPO_ROOT) {
  return buildStageCallSites({
    shippedStageKeys: readShippedStageKeys(repoRoot),
    sources: collectServerSources(repoRoot),
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
