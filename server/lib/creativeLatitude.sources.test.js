import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { OPERATIONAL_RUN_SOURCES, isCreativeRunSource } from './creativeLatitude.js';

// The stage side of the IP-latitude clause has a natural census to walk
// (data.reference/prompts/stage-config.json). The run-`source` side has none —
// the tags are inline string literals scattered across services — so this test
// builds that census by scanning for them. Without it the source table rots
// silently: a new creative service ships, nobody adds its tag, and its prompts
// go out watered-down with every existing test still green.

const SERVER_ROOT = join(import.meta.dirname, '..');
// The shared runners are the only paths the runner-side stamp sits behind.
// runCreativeRefinement is a thin wrapper over runPromptThroughProvider, so its sources need classifying too.
const RUNNER_CALL = /\b(runPromptThroughProvider|runStagedLLM|runInlineLLM|runStageScopedInlineLLM|runCreativeRefinement)\s*\(/g;
// A generous window: the `source:` key is inside the same options object, and
// these calls run to a couple dozen lines with comments interleaved.
const CALL_WINDOW = 900;
const SOURCE_LITERAL = /source:\s*'([^']+)'/g;
const SKIP_DIRS = new Set(['node_modules', 'aiToolkit']);

function collectSourceLiterals(dir, found = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceLiterals(join(dir, entry.name), found);
      continue;
    }
    if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
    const path = join(dir, entry.name);
    const text = readFileSync(path, 'utf-8');
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

  it('keeps the operational list free of entries the creative table already claims', () => {
    expect(OPERATIONAL_RUN_SOURCES.filter(isCreativeRunSource)).toEqual([]);
  });
});
