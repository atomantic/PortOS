import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { OPERATIONAL_RUN_SOURCES, isCreativeRunSource } from '../../../lib/creativeLatitude.js';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

// The stage side of the IP-latitude clause has a natural census to walk
// (data.reference/prompts/stage-config.json). The run-`source` side has none —
// the tags are inline string literals scattered across services — so this test
// builds that census by scanning for them. Without it the source table rots
// silently: a new creative service ships, nobody adds its tag, and its prompts
// go out watered-down with every existing test still green.

const SERVER_ROOT = join(REPO_ROOT, 'server');
// The shared runners are the only paths the runner-side stamp sits behind.
// runCreativeRefinement and callProviderAISimple are thin wrappers over runPromptThroughProvider, so their sources need classifying too.
const RUNNER_CALL = /\b(runPromptThroughProvider|runStagedLLM|runInlineLLM|runStageScopedInlineLLM|runCreativeRefinement|callProviderAISimple)\s*\(/g;
// A generous window: the `source:` key is inside the same options object, and
// these calls run to a couple dozen lines with comments interleaved.
const CALL_WINDOW = 900;
const SOURCE_LITERAL = /source:\s*'([^']+)'/g;
const SKIP_DIRS = new Set(['node_modules', 'aiToolkit']);

// `callProviderAISimple` falls back to an operational tag when a caller names
// none, so a creative call site that loses its `source` would go out without
// the clause and with every other test green. Each call site is listed with
// the tag it passes (`null` when it passes none).
const SIMPLE_CALL = /\bcallProviderAISimple\s*\(/g;
const SIMPLE_CALL_HOME = join(SERVER_ROOT, 'services', 'aiProvider.js');

function collectSimpleCallSites(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSimpleCallSites(join(dir, entry.name), found);
      continue;
    }
    if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
    const path = join(dir, entry.name);
    // The helper's own definition and its fallback re-entry forward `options`.
    if (path === SIMPLE_CALL_HOME) continue;
    const text = readText(path);
    for (const call of text.matchAll(SIMPLE_CALL)) {
      // Up to the next call, so one site never borrows its neighbour's tag.
      const next = text.indexOf('callProviderAISimple', call.index + 1);
      const window = text.slice(call.index, Math.min(call.index + CALL_WINDOW, next === -1 ? text.length : next));
      // A mention in a comment or an import is not a call with options.
      if (!/^\s*callProviderAISimple\s*\(\s*[\w{]/.test(window) || /^callProviderAISimple\s*\(\s*\)/.test(window)) continue;
      const hit = /source:\s*'([^']+)'/.exec(window);
      found.push({ file: path.slice(SERVER_ROOT.length + 1), source: hit ? hit[1] : null });
    }
  }
  return found;
}

function collectSourceLiterals(dir, found = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceLiterals(join(dir, entry.name), found);
      continue;
    }
    if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
    const path = join(dir, entry.name);
    const text = readText(path);
    for (const call of text.matchAll(RUNNER_CALL)) {
      const window = text.slice(call.index, call.index + CALL_WINDOW);
      // Only literals: a `source: SOME_CONST` reference resolves at runtime and
      // is covered by whichever table its value lands in.
      for (const hit of window.matchAll(SOURCE_LITERAL)) {
        if (!found.has(hit[1])) found.set(hit[1], path);
      }
    }
  }
  return found;
}

describe('run-source census (IP-latitude clause)', () => {
  const literals = collectSourceLiterals(SERVER_ROOT);

  it('finds the source tags to classify', () => {
    // A refactor that renames the shared runners would empty this scan and make
    // the guard below vacuously pass — so assert the census is non-trivial.
    expect(literals.size).toBeGreaterThan(40);
  });

  it('classifies every run source as creative or operational', () => {
    const operational = new Set(OPERATIONAL_RUN_SOURCES);
    const unclassified = [...literals.entries()]
      .filter(([source]) => !isCreativeRunSource(source) && !operational.has(source))
      .map(([source, path]) => `${source} (${path.slice(SERVER_ROOT.length + 1)})`);
    expect(
      unclassified,
      'unclassified run sources — add each to CREATIVE_PREFIXES / CREATIVE_NAMES '
      + `or OPERATIONAL_RUN_SOURCES in creativeLatitude.js: ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('names a run source at every callProviderAISimple call site', () => {
    const sites = collectSimpleCallSites(SERVER_ROOT);
    // Eight services, fifteen call sites when this guard was written; a rename
    // of the helper would empty the scan and pass vacuously.
    expect(sites.length).toBeGreaterThanOrEqual(15);
    expect(sites.filter((site) => site.source === null).map((site) => site.file)).toEqual([]);
  });

  it('keeps the latitude clause on exactly the callProviderAISimple call sites that write creative text', () => {
    const creative = collectSimpleCallSites(SERVER_ROOT)
      .filter((site) => isCreativeRunSource(site.source))
      .map((site) => `${site.file}: ${site.source}`)
      .sort();
    // Reclassifying one of these, or stamping a new one, changes the prompt a
    // provider receives, so it has to be a deliberate edit here too.
    expect(creative).toEqual([
      'services/autobiography.js: autobiography-weave',
      'services/taste-questionnaire.js: taste-deep-question',
      'services/taste-questionnaire.js: taste-summary',
      'services/taste-questionnaire.js: taste-summary',
    ]);
  });

  it('keeps the operational list free of entries the creative table already claims', () => {
    expect(OPERATIONAL_RUN_SOURCES.filter(isCreativeRunSource)).toEqual([]);
  });
});
