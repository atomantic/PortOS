import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertBrowserProfileExecuted, BROWSER_FIDELITY_ONLY_FILES, BROWSER_FIDELITY_TESTS, browserProfileAcceptedVerdicts, browserTestProfileArgs, browserTestProfileFiles, localPerformanceTagViolations } from './browserTestProfiles.js';

const smokeNames = {
  'server/services/musicVideo/documentRender.browser.test.js': ['propagates a deadline through a pending seek and waits for owned Chrome cleanup'],
  'server/services/musicVideo/documentRenderGeneration.browser.test.js': [
    'generates and exports a Three.js scene with visible authored content',
    'renders a generated 3-second card/still/clip document with the selected performance in-point',
  ],
};
const completeReport = () => ({
  numPassedTests: Object.values(BROWSER_FIDELITY_TESTS).flat().length, numFailedTests: 0,
  testResults: Object.entries(BROWSER_FIDELITY_TESTS).map(([name, titles]) => ({
    name: `/checkout/${name}`, assertionResults: titles.map(title => ({ title, fullName: `suite ${title}`, status: 'passed' })),
  })),
});

describe('browser test profiles', () => {
  it('rejects unknown profiles and receipts with no executed assertions', () => {
    for (const profile of ['', 'fast', null]) expect(() => browserTestProfileArgs(profile)).toThrow('Unknown browser test profile');
    for (const profile of ['smoke', 'fidelity', 'full']) {
      expect(() => assertBrowserProfileExecuted(profile, { numTotalTests: 3, numPassedTests: 0, numFailedTests: 0 })).toThrow('executed no tests');
      expect(() => assertBrowserProfileExecuted(profile, {})).toThrow('executed no tests');
    }
  });

  it('omits only the explicitly fidelity-only suite from smoke selection', () => {
    const mixed = 'server/services/musicVideo/documentRender.browser.test.js';
    const smoke = 'server/lib/musicVideo/musicVideoTitleCard.browser.test.js';
    const files = [mixed, smoke, ...BROWSER_FIDELITY_ONLY_FILES];
    expect(browserTestProfileFiles('smoke', files)).toEqual([mixed, smoke]);
    expect(browserTestProfileFiles('fidelity', files)).toEqual([mixed, ...BROWSER_FIDELITY_ONLY_FILES]);
    expect(browserTestProfileFiles('full', files)).toEqual(files);
    expect(browserTestProfileFiles('smoke', BROWSER_FIDELITY_ONLY_FILES)).toEqual([]);
    expect(() => browserTestProfileFiles('', files)).toThrow('Unknown browser test profile');
  });

  it('requires every fidelity assertion to pass exactly once in its owning file', () => {
    expect(assertBrowserProfileExecuted('fidelity', completeReport())).toBe(4);
    const windows = completeReport();
    windows.testResults.forEach(suite => { suite.name = `D:\\checkout\\${suite.name.slice('/checkout/'.length).replaceAll('/', '\\')}`; });
    expect(assertBrowserProfileExecuted('fidelity', windows)).toBe(4);
    for (const status of ['failed', 'skipped', 'pending', 'todo']) {
      const report = completeReport();
      report.testResults[0].assertionResults[0].status = status;
      expect(() => assertBrowserProfileExecuted('fidelity', report)).toThrow('did not pass');
    }
    for (const mutate of [
      report => report.testResults.pop(),
      report => report.testResults[0].assertionResults.pop(),
      report => { report.testResults[0].name = '/unrelated/documentRender.browser.test.js'; },
      report => report.testResults[0].assertionResults.push(report.testResults[0].assertionResults[0]),
      report => report.testResults[0].assertionResults.push({ title: '[fidelity] new case', status: 'passed' }),
    ]) {
      const report = completeReport(); mutate(report);
      expect(() => assertBrowserProfileExecuted('fidelity', report)).toThrow(/fidelity assertion/i);
    }
  });

  it('lets only smoke reuse a verdict, and only the full profile run that covers its cases', () => {
    expect(browserProfileAcceptedVerdicts('smoke')).toEqual([
      { label: 'full profile', env: { PORTOS_BROWSER_TEST_PROFILE: 'full' }, caseFilter: browserTestProfileArgs('full') },
    ]);
    expect(browserProfileAcceptedVerdicts('full')).toEqual([]);
    expect(browserProfileAcceptedVerdicts('fidelity')).toEqual([]);
    expect(() => browserProfileAcceptedVerdicts('')).toThrow('Unknown browser test profile');
  });

  it('reports a [local-performance] case that smoke would run and full would not', () => {
    const file = 'server/lib/synthetic.browser.test.js';
    const source = (lines) => ({ [file]: lines.join('\n') });
    expect(localPerformanceTagViolations(source([
      "it('[fidelity] [local-performance] covered by both exclusions', () => {});",
      "it('plain smoke case', () => {});",
    ]))).toEqual([]);
    expect(localPerformanceTagViolations(source([
      "it('plain smoke case', () => {});",
      "it('[local-performance] only skipped by full', () => {});",
    ]))).toEqual([`${file}:2`]);
    // A tag kept out of the title literal is reported where it is written.
    expect(localPerformanceTagViolations(source(["const PERF = '[local-performance]';", 'it(`[fidelity] ${PERF} x`, () => {});']))).toEqual([`${file}:1`]);
  });


  // Executes only empty synthetic Node test bodies. This pins Vitest's actual
  // filtering and JSON receipt semantics, without importing browser fixtures.
  it('keeps local playback in required fidelity and out of every hosted profile with real Vitest', () => {
    const temp = mkdtempSync(join(tmpdir(), 'browser-profile-contract-'));
    const require = createRequire(new URL('../../server/package.json', import.meta.url));
    const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    try {
      const host = join(temp, 'host'); mkdirSync(host);
      const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: host, TMP: host, TEMP: host };
      // A nested Vitest run owns its own temp root; it must never reuse or
      // sweep the parent's root while sibling contract tests are still alive.
      delete env.PORTOS_TEST_TEMP_ROOT;
      const config = join(temp, 'vitest.config.mjs');
      writeFileSync(config, `import { bootstrapVitestTempRoot } from ${JSON.stringify(new URL('./vitestTempRoot.js', import.meta.url).href)};
bootstrapVitestTempRoot();
export default { test: { globals: true, maxWorkers: 1, include: ['server/**/*.test.js'],
globalSetup: [${JSON.stringify(new URL('../vitestTempRootSetup.js', import.meta.url).href)}] } };`);
      for (const [file, titles] of Object.entries(BROWSER_FIDELITY_TESTS)) {
        const path = join(temp, file); mkdirSync(dirname(path), { recursive: true });
        const names = [...(smokeNames[file] ?? []), ...titles];
        writeFileSync(path, names.map(title => `it(${JSON.stringify(title)}, () => {});`).join('\n'));
      }
      const passed = {};
      for (const profile of ['smoke', 'fidelity', 'full']) {
        const output = join(temp, `${profile}.json`);
        const run = spawnSync(process.execPath, [cli, 'run', '--config', config, '--configLoader=runner',
          ...browserTestProfileArgs(profile), '--reporter=json', `--outputFile=${output}`], {
          cwd: temp, encoding: 'utf8', timeout: 20000,
          env,
        });
        expect(run.error).toBeUndefined();
        expect(run.status, run.stderr || run.stdout).toBe(0);
        const report = JSON.parse(readFileSync(output, 'utf8'));
        expect(assertBrowserProfileExecuted(profile, report)).toBeGreaterThan(0);
        passed[profile] = report.testResults.flatMap(suite => suite.assertionResults)
          .filter(assertion => assertion.status === 'passed').map(assertion => assertion.title).sort();
      }
      expect(passed.smoke).toEqual(Object.values(smokeNames).flat().sort());
      expect(passed.fidelity).toEqual(Object.values(BROWSER_FIDELITY_TESTS).flat().sort());
      expect([...passed.smoke, ...passed.fidelity.filter(title => !title.includes('[local-performance]'))].sort()).toEqual(passed.full);
      expect(passed.fidelity.filter(title => title.includes('[local-performance]'))).toHaveLength(1);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 70000);
});
