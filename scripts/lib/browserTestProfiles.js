/** Browser profiles select existing assertions; they never change render settings. */
export const BROWSER_FIDELITY_TESTS = {
  'server/services/musicVideo/documentRender.browser.test.js': [
    '[fidelity] matches bounded grades across real composed/document ramps and song-time excerpts',
    '[fidelity] matches bounded grades across real composed/document generated-shots and song-time excerpts',
  ],
  'server/services/musicVideo/documentRenderGeneration.browser.test.js': [
    '[fidelity] [local-performance] authors a local Three.js world and renders the same deterministic scene through module preview and export',
  ],
  'server/routes/musicVideoRichAuthoring.browser.test.js': [
    '[fidelity] authors and accepts a Three.js world through the real UI and renders its reviewed proof',
  ],
};
export const BROWSER_FIDELITY_FILES = Object.keys(BROWSER_FIDELITY_TESTS);
// This suite has one fidelity case and no smoke assertions. Other registered
// suites retain smoke work, even when they also contain fidelity cases.
export const BROWSER_FIDELITY_ONLY_FILES = ['server/routes/musicVideoRichAuthoring.browser.test.js'];

export function browserTestProfileArgs(profile = 'full') {
  // Hosted full coverage includes fidelity, but hardware-sensitive playback is local.
  if (profile === 'full') return ['--testNamePattern=^(?!.*\\[local-performance\\]).*$'];
  if (profile === 'smoke') return ['--testNamePattern=^(?!.*\\[fidelity\\]).*$'];
  if (profile === 'fidelity') return ['--testNamePattern=\\[fidelity\\]'];
  throw new Error(`Unknown browser test profile: ${profile}`);
}

/**
 * Settings whose green memo entry also proves `profile`'s cases, for
 * `planTestMemo`'s `acceptVerdictsFrom`. `smoke` runs every case but
 * `[fidelity]` and `full` every case but `[local-performance]`; every
 * `[local-performance]` case is also `[fidelity]`
 * (`localPerformanceTagViolations`), so smoke's cases in a file are a subset
 * of full's and a full verdict covers them. Nothing proves `full` or
 * `fidelity` but their own run. Pull requests run `smoke` and only trusted
 * runs, which run `full`, save the memo, so without this a PR never skips one.
 */
export function browserProfileAcceptedVerdicts(profile) {
  browserTestProfileArgs(profile);
  if (profile !== 'smoke') return [];
  return [{ label: 'full profile', env: { PORTOS_BROWSER_TEST_PROFILE: 'full' }, caseFilter: browserTestProfileArgs('full') }];
}

/**
 * Lines of registered browser suites (`sources`: file -> source) that mention
 * `local-performance` without `[fidelity]` on the same line. Such a case would
 * run under `smoke` but not `full`, which breaks the subset
 * `browserProfileAcceptedVerdicts` relies on. Line-based on purpose: a tag
 * held in a constant, split across lines or put on a `describe` is reported
 * too, which only asks for it to be written next to `[fidelity]`.
 */
export function localPerformanceTagViolations(sources) {
  const violations = [];
  for (const [file, source] of Object.entries(sources)) {
    source.split('\n').forEach((line, index) => {
      if (line.includes('local-performance') && !line.includes('[fidelity]')) violations.push(`${file}:${index + 1}`);
    });
  }
  return violations;
}

export function browserTestProfileFiles(profile, files) {
  browserTestProfileArgs(profile);
  if (profile === 'smoke') return files.filter(file => !BROWSER_FIDELITY_ONLY_FILES.includes(file));
  if (profile === 'fidelity') return files.filter(file => BROWSER_FIDELITY_FILES.includes(file));
  return [...files];
}

/** A successful process with only skipped tests is not a profile receipt. */
export function assertBrowserProfileExecuted(profile, report) {
  browserTestProfileArgs(profile);
  const executed = Number(report?.numPassedTests) + Number(report?.numFailedTests);
  if (!Number.isSafeInteger(executed) || executed < 1) {
    throw new Error(`Browser ${profile} profile executed no tests`);
  }
  if (profile !== 'fidelity') return executed;

  // Require every named fidelity assertion, including parameter-expanded cases.
  // Also reject new/unregistered tags so adding a case cannot silently leave
  // the receipt's expected inventory behind.
  const remaining = new Set(Object.entries(BROWSER_FIDELITY_TESTS)
    .flatMap(([file, titles]) => titles.map(title => `${file}\n${title}`)));
  if (!Array.isArray(report.testResults)) throw new Error('Fidelity test results are missing');
  for (const suite of report.testResults) {
    const path = String(suite.name ?? '').replaceAll('\\', '/');
    const file = BROWSER_FIDELITY_FILES.find(file => path === file || path.endsWith(`/${file}`));
    if (!Array.isArray(suite.assertionResults)) throw new Error('Fidelity assertions are missing');
    for (const assertion of suite.assertionResults) {
      if (!String(assertion.fullName ?? assertion.title ?? '').includes('[fidelity]')) continue;
      const key = `${file}\n${assertion.title}`;
      if (!remaining.delete(key)) throw new Error(`Unexpected or duplicate fidelity assertion: ${assertion.title}`);
      if (assertion.status !== 'passed') throw new Error(`Fidelity assertion did not pass: ${assertion.title}`);
    }
  }
  if (remaining.size) throw new Error(`Missing fidelity assertions: ${[...remaining].join(', ')}`);
  return executed;
}
