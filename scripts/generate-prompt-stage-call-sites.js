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
 * Usage:  node scripts/generate-prompt-stage-call-sites.js
 *
 * Output shape: `{ "<stage-key>": ["server/services/foo.js", …] }`, keys and
 * paths both sorted so the file is byte-stable across installs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this script's own location. */
export const REPO_ROOT = resolve(HERE, '..');

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
const LITERAL_CALL_RE =
  /\b(?:getStage|getStageTemplate|buildPrompt|runStage|runStagedLLM|runStageScopedInlineLLM|previewPrompt|resolveStageContext|resolveJudgeForStage)\(\s*(['"])([^'"\n]+)\1/g;

/**
 * One pass over a JS source, in precedence order: block comment, line comment,
 * single-quoted, double-quoted, template literal.
 *
 * Comments are in the alternation only so they can be SKIPPED — a stage key
 * named in a `//` note or a JSDoc block is prose, not a call site, and listing
 * that file under "Referenced in" in the delete dialog would be a lie.
 * Matching them here rather than pre-stripping is what keeps a `'http://…'`
 * literal from being mistaken for the start of a comment.
 *
 * A regex literal containing a quote could still desync the scan. That would
 * be stable, not flaky (the drift test compares two runs of the same scanner),
 * and no `server/` source does it today.
 */
const TOKEN_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;

/**
 * A static hyphenated prefix inside a template literal, followed by an
 * interpolation — `` `pipeline-panel-${personaId}` ``. Stages reached this way
 * (the reader-panel personas) have NO literal key anywhere in source, so a
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
  // A call site may name a stage whose config entry was never shipped; those
  // keys still deserve protection if the user (or a migration) creates them.
  const keys = new Set(shippedStageKeys);
  for (const { source } of sources) {
    for (const [, , key] of source.matchAll(LITERAL_CALL_RE)) keys.add(key);
  }

  const index = new Map();
  const record = (key, path) => {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(path);
  };

  for (const { path, source } of sources) {
    for (const [token] of source.matchAll(TOKEN_RE)) {
      if (token.startsWith('/')) continue; // comment — prose, not a call site
      if (token.startsWith('`')) {
        for (const [, prefix] of token.matchAll(TEMPLATE_PREFIX_RE)) {
          for (const key of keys) {
            if (key.length > prefix.length && key.startsWith(prefix)) record(key, path);
          }
        }
      }
      // An interpolated or escaped literal is never a bare stage key, so the
      // same unwrap covers all three quote styles.
      const literal = token.slice(1, -1);
      if (keys.has(literal)) record(literal, path);
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
