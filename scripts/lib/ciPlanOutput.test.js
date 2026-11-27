import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fansOut,
  emitGitHubPlan,
  formatPlanSummary,
  githubPlanOutput,
  FULL_SUITE_SHARDS,
  CLIENT_FANOUT_TEST_FILES,
  MAX_TARGETED_TEST_FILES,
  shardIndexes,
} from './ciPlanOutput.js';
import { TRACKED } from '../fixtures/ciPlanTrackedFiles.js';
import { buildCiTestPlan } from '../ci-test-plan.js';
import { BROWSER_SUITES } from './browserSuites.js';
import { WINDOWS_CONTRACT_TESTS } from './ciPlanRules.js';

it('fans a test-only client plan out once it names four real-Chromium suites (#17616)', () => {
  const browser = Array.from({ length: 4 }, (_, i) => `client/src/components/s${i}.browser.test.js`);
  const trackedFiles = [...browser, 'client/src/components/plain.test.jsx'];
  const four = buildCiTestPlan(browser, { trackedFiles });
  expect(four.client).toMatchObject({ mode: 'files', files: browser });
  expect(four.shards.client).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.client));
  const three = buildCiTestPlan([...browser.slice(0, 3), 'client/src/components/plain.test.jsx'], { trackedFiles });
  expect(three.shards.client).toEqual([1]);
});

describe('CI plan shard selection', () => {
  it('keeps Windows native contracts on one runner while primary full plans stay sharded', () => {
    expect(FULL_SUITE_SHARDS.windows).toBe(1);
    expect(shardIndexes('full', 3)).toEqual([1, 2, 3]);
    expect(shardIndexes('related', 3)).toEqual([1]);
    expect(shardIndexes('files', 3)).toEqual([1]);
    expect(shardIndexes('skip', 3)).toEqual([1]);
    for (const [runner, count] of Object.entries(FULL_SUITE_SHARDS)) {
      if (runner !== 'windows') expect(count, runner).toBeGreaterThan(1);
    }

    const full = buildCiTestPlan(['server/vitest.config.js'], { trackedFiles: [...TRACKED, ...BROWSER_SUITES] });
    expect(full.shards).toEqual({
      server: [1, 2, 3, 4],
      client: [1, 2, 3, 4, 5, 6],
      browser: [1, 2, 3, 4, 5, 6, 7],
      windows: shardIndexes('full', FULL_SUITE_SHARDS.windows),
    });
    const scoped = buildCiTestPlan(['server/services/auth.js'], { trackedFiles: TRACKED });
    expect(scoped.shards).toEqual({ server: [1], client: [1], browser: [1], windows: [1] });
    const relatedWindows = buildCiTestPlan(['server/lib/bufferedSpawn.js'], { trackedFiles: TRACKED });
    expect(relatedWindows).toMatchObject({ full: false, windowsMode: 'files',
      windowsSources: [],
      shards: { server: [1], client: [1], browser: [1], windows: [1] } });
    expect(relatedWindows.windowsFiles).toEqual(WINDOWS_CONTRACT_TESTS.filter(path => TRACKED.includes(path)).sort());
    const exactWindows = buildCiTestPlan(['server/lib/bufferedSpawn.test.js'], { trackedFiles: TRACKED });
    expect(exactWindows).toMatchObject({ windowsMode: 'files', shards: { windows: [1] } });
    const docsOnly = buildCiTestPlan(['docs/README.md'], { trackedFiles: TRACKED });
    expect(docsOnly.shards).toEqual({ server: [1], client: [1], browser: [1], windows: [1] });
  });

  it.each([
    [0, [1]], [1, [1]], [2, [1, 2]], [3, [1, 2]],
    [4, [1, 2, 3, 4]], [6, [1, 2, 3, 4]], [7, [1, 2, 3, 4, 5, 6, 7]],
  ])('chooses browser runners for %i selected suites without widening coverage', (suiteCount, shards) => {
    const browserFiles = BROWSER_SUITES.slice(0, suiteCount);
    const plan = buildCiTestPlan(browserFiles, { trackedFiles: [...TRACKED, ...BROWSER_SUITES] });
    expect(plan.browserFiles).toEqual([...browserFiles].sort());
    expect(plan.shards.browser).toEqual(shards);
  });

  describe('scoped fan-out instead of a full plan (#11871)', () => {
    const SERVER_FANOUT = shardIndexes('full', FULL_SUITE_SHARDS.server);
    const CLIENT_FANOUT = shardIndexes('full', FULL_SUITE_SHARDS.client);
    const featureTests = (prefix, count, ext = 'js') => Array.from({ length: count },
      (_, i) => `${prefix}/case${String(i).padStart(3, '0')}.test.${ext}`);

    it('keeps an over-cap server selection scoped, runs every selected test, and fans only the server out', () => {
      const source = 'server/services/bigfeature/core.js';
      const tests = featureTests('server/services/bigfeature', MAX_TARGETED_TEST_FILES + 5);
      const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, ...WINDOWS_CONTRACT_TESTS, source, ...tests] });

      expect(plan).toMatchObject({ full: false, reason: 'targeted features: bigfeature',
        server: { mode: 'related', sources: [source] }, client: { mode: 'skip' },
        lint: { mode: 'files', files: [source] }, build: false, smoke: true, windows: false });
      // Sharding partitions the selection; it never drops a selector.
      expect(plan.server.files).toEqual(expect.arrayContaining(tests));
      expect(plan.shards).toEqual({ server: SERVER_FANOUT, client: [1], browser: [1], windows: [1] });
      expect(plan.suiteReasons.server).toMatch(/exceed the 125-file cap, sharded 4 ways/);
      // A broad shared dependency can still reach the slashdo contracts.
      expect(plan.slashdo).toBe(true);
    });

    it('keeps a client selection of 165 files on one runner (the server cap does not apply to the client)', () => {
      const source = 'client/src/components/bigfeature/Panel.jsx';
      const tests = featureTests('client/src/components/bigfeature', 165, 'jsx');
      const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, ...tests] });

      expect(plan).toMatchObject({ full: false, client: { mode: 'related', sources: [source] }, build: true });
      expect(plan.client.files).toEqual(expect.arrayContaining(tests));
      expect(plan.shards.client).toEqual([1]);
      expect(plan.shards.server).toEqual([1]);
    });

    it('fans the client out only when its own selection exceeds CLIENT_FANOUT_TEST_FILES', () => {
      const source = 'client/src/components/bigfeature/Panel.jsx';
      const tests = featureTests('client/src/components/bigfeature', CLIENT_FANOUT_TEST_FILES + 1, 'jsx');
      const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, ...tests] });

      expect(plan.client.files).toEqual(expect.arrayContaining(tests));
      expect(plan.shards.client).toEqual(CLIENT_FANOUT);
      expect(plan.shards.server).toEqual([1]);
      expect(plan.suiteReasons.client).toContain(`exceed the 400-file cap, sharded ${CLIENT_FANOUT.length} ways`);

      // TRACKED adds client selectors of its own, so size the boundary case from the measured floor.
      const floor = plan.client.files.length - tests.length;
      const atCap = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, ...tests.slice(0, CLIENT_FANOUT_TEST_FILES - floor)] });
      expect(atCap.client.files).toHaveLength(CLIENT_FANOUT_TEST_FILES);
      expect(atCap.shards.client).toEqual([1]);
    });

    it('keeps a server related graph and an exact-file plan under the cap on one runner', () => {
      // Record-aware selection (#16424) bounds a related plan's reach, so only the cap fans out.
      const source = 'server/services/flat.js';
      const tests = featureTests('server/services/flatfeature', 3);
      const trackedFiles = [...TRACKED, source, ...tests];
      const related = buildCiTestPlan([source, ...tests.slice(0, 2)], { trackedFiles });
      expect(related.server.mode).toBe('related');
      expect(related.shards.server).toEqual([1]);
      expect(related.suiteReasons.server).not.toMatch(/sharded/);

      const exact = buildCiTestPlan(tests, { trackedFiles });
      expect(exact.server.mode).toBe('files');
      expect(exact.shards.server).toEqual([1]);
    });

    it('fans a server related plan out on measured import reach over the cap, never on a small one (#16547)', () => {
      const source = 'server/services/flat.js';
      const tests = featureTests('server/services/flatfeature', 3);
      const trackedFiles = [...TRACKED, source, ...tests];
      const reach = (selected) => ({ selected, rows: [{ source, dynamicReach: selected, staticReach: 10 }] });

      const broad = buildCiTestPlan([source], { trackedFiles, serverReach: reach(1069) });
      expect(broad.server.mode).toBe('related');
      expect(broad.shards).toEqual({ server: SERVER_FANOUT, client: [1], browser: [1], windows: [1] });
      expect(broad.suiteReasons.server).toMatch(/related import reach of 1069 suites exceeds the 125-file cap, sharded 4 ways/);

      const narrow = buildCiTestPlan([source], { trackedFiles, serverReach: reach(50) });
      expect(narrow.shards.server).toEqual([1]);
      expect(narrow.suiteReasons.server).not.toMatch(/sharded/);

      // Reach only partitions a related walk: an exact-file plan stays put.
      const exact = buildCiTestPlan(tests, { trackedFiles, serverReach: reach(1069) });
      expect(exact.server.mode).toBe('files');
      expect(exact.shards.server).toEqual([1]);
    });

    it('fans a client related plan out on measured import reach over the client cap, never at or under it (#17456)', () => {
      const source = 'client/src/services/apiShared.js';
      const tests = featureTests('client/src/components/sharedfeature', 2, 'jsx');
      const trackedFiles = [...TRACKED, source, ...tests];
      const reach = (selected) => ({ selected, rows: [{ source, dynamicReach: selected, staticReach: 10 }] });

      const broad = buildCiTestPlan([source], { trackedFiles, clientReach: reach(1042) });
      expect(broad.client).toMatchObject({ mode: 'related', sources: [source] });
      expect(broad.shards).toEqual({ server: [1], client: CLIENT_FANOUT, browser: [1], windows: [1] });
      expect(broad.suiteReasons.client).toContain(`related import reach of 1042 suites exceeds the 400-file cap, sharded ${CLIENT_FANOUT.length} ways`);
      expect(broad.suiteReasons.client).toContain(`dynamic-aware fan-out 1042 suite(s): ${source} 1042 (static 10)`);

      // The server's lower cap never applies to client reach.
      for (const selected of [MAX_TARGETED_TEST_FILES + 1, CLIENT_FANOUT_TEST_FILES]) {
        const low = buildCiTestPlan([source], { trackedFiles, clientReach: reach(selected) });
        expect(low.shards.client).toEqual([1]);
        expect(low.suiteReasons.client).not.toMatch(/sharded/);
      }
      expect(fansOut('client', { mode: 'related', files: [] }, CLIENT_FANOUT_TEST_FILES + 1)).toBe(true);
      expect(fansOut('client', { mode: 'files', files: [] }, CLIENT_FANOUT_TEST_FILES + 1)).toBe(false);

      // Each runner reads only its own reach.
      const serverOnly = buildCiTestPlan([source], { trackedFiles, serverReach: reach(1042) });
      expect(serverOnly.shards.client).toEqual([1]);
      const exact = buildCiTestPlan(tests, { trackedFiles, clientReach: reach(1042) });
      expect(exact.client.mode).toBe('files');
      expect(exact.shards.client).toEqual([1]);
    });
  });
});

it('writes the plan, the shard matrices and the step summary through the GitHub command files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-plan-emit-'));
  const env = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    Object.assign(process.env, env);
    const plan = buildCiTestPlan(['docs/README.md'], { linuxContainmentInputs: [], supercolliderLiveInputs: [] });
    emitGitHubPlan(plan, { gatedBaseSha: 'a'.repeat(40) });
    const lines = readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('\n');
    const outputs = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(Object.keys(outputs)).toEqual(['plan', 'server_shards', 'client_shards', 'browser_shards', 'windows_shards']);
    expect(JSON.parse(outputs.plan)).toEqual(githubPlanOutput(plan));
    expect(JSON.parse(outputs.plan)).toMatchObject({ full: false, lint_files: [], browser: false, browser_files: [] });
    expect(JSON.parse(outputs.server_shards)).toEqual(plan.shards.server);
    expect(JSON.parse(outputs.browser_shards)).toEqual([1]);
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    expect(summary).toBe(`${formatPlanSummary(githubPlanOutput(plan), plan.shards, 'a'.repeat(40))}\n`);
    expect(summary).toMatch(/^### CI impact plan\n\n- Reason: `documentation-only change`\n/);
    expect(summary).toContain(`- Native jobs gated against last green main run: \`${'a'.repeat(40)}\``);
    expect(summary).toContain('- Node minimum compatibility: `false`');
    expect(formatPlanSummary(githubPlanOutput(plan), plan.shards)).toContain('main run: `none`');
  } finally {
    log.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
