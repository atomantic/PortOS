import { describe, expect, it } from 'vitest';

import {
  listRelatedCwd,
  parseVitestListOutput,
  shouldSkipRelatedList,
  toRunnerPath,
  unionSelectors,
} from './run-ci-tests.js';

describe('parseVitestListOutput', () => {
  it('collects unique file paths from vitest list lines', () => {
    const stdout = [
      'lib/ports.test.js > PORTS > mirrors every fixed port',
      'lib/ports.test.js > resolvePostgresPort > returns the native port',
      'services/auth.test.js > login > rejects a blank password',
      '',
      'vite v6.0.0 building for test...',
    ].join('\n');

    expect(parseVitestListOutput(stdout)).toEqual([
      'lib/ports.test.js',
      'services/auth.test.js',
    ]);
  });

  it('ignores log lines that are not a file > suite > test row', () => {
    expect(parseVitestListOutput('Running server related tests (2 selector argument(s)).')).toEqual([]);
  });
});

describe('unionSelectors', () => {
  it('dedupes planner files against the related-test list under one ./ prefix', () => {
    expect(unionSelectors(
      ['./services/sprites/atlas.test.js', './lib/index.test.js'],
      ['services/sprites/atlas.test.js', './services/sprites/atlas.test.js'],
    )).toEqual([
      './services/sprites/atlas.test.js',
      './lib/index.test.js',
    ]);
  });

  it('keeps out-of-workspace scripts paths as ../…', () => {
    expect(unionSelectors(
      ['../scripts/changelogFragments.test.js'],
      ['lib/ports.test.js'],
    )).toEqual([
      './lib/ports.test.js',
      '../scripts/changelogFragments.test.js',
    ]);
  });
});

describe('shouldSkipRelatedList', () => {
  it('skips the import-graph walk for always-run-only plans', () => {
    expect(shouldSkipRelatedList('files', [
      'server/services/taskPromptDefaults.test.js',
      'scripts/changelogFragments.test.js',
    ])).toBe(true);
  });

  it('still walks the graph when a real feature test is selected', () => {
    expect(shouldSkipRelatedList('files', [
      'server/services/sprites/atlas.test.js',
      'server/services/taskPromptDefaults.test.js',
    ])).toBe(false);
  });

  it('never skips related mode — that mode is the graph walk', () => {
    expect(shouldSkipRelatedList('related', [
      'server/services/taskPromptDefaults.test.js',
    ])).toBe(false);
  });
});

describe('listRelatedCwd', () => {
  it('lists from the workspace that owns the Vitest config, not the repo root', () => {
    expect(listRelatedCwd('server')).toMatch(/[/\\]server$/);
    expect(listRelatedCwd('client')).toMatch(/[/\\]client$/);
    expect(listRelatedCwd('server')).not.toMatch(/[/\\]server[/\\]server$/);
  });
});

describe('toRunnerPath', () => {
  it('maps repo paths onto each workspace runner root', () => {
    expect(toRunnerPath('client', 'client/src/lib/index.test.js')).toBe('./src/lib/index.test.js');
    expect(toRunnerPath('server', 'server/lib/index.test.js')).toBe('./lib/index.test.js');
    expect(toRunnerPath('server', 'scripts/changelogFragments.test.js')).toBe('../scripts/changelogFragments.test.js');
  });
});
