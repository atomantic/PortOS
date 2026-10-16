/** Browser profiles select existing assertions; they never change render settings. */
export const BROWSER_FIDELITY_TESTS = {
  'server/services/musicVideo/documentRender.browser.test.js': [
    '[fidelity] matches bounded grades across real composed/document ramps and song-time excerpts',
    '[fidelity] matches bounded grades across real composed/document generated-shots and song-time excerpts',
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
  if (profile === 'full') return [];
  if (profile === 'smoke') return ['--testNamePattern=^(?!.*\\[fidelity\\]).*$'];
  if (profile === 'fidelity') return ['--testNamePattern=\\[fidelity\\]'];
  throw new Error(`Unknown browser test profile: ${profile}`);
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
