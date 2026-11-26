import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_SUITES } from '../../../../scripts/lib/browserSuites.js';
import { BROWSER_FIDELITY_ONLY_FILES, BROWSER_FIDELITY_TESTS, localPerformanceTagViolations } from '../../../../scripts/lib/browserTestProfiles.js';
import { readText, REPO_ROOT as root, workingTreeFiles } from '../../../../scripts/lib/guardCorpus.js';

// Scans the working tree, so it is derived into the always-run set (#10312).
describe('cross-workspace browser suite registry', () => {
  it('lists exactly the suites that gate on real Chrome (browserSuiteCanRun or resolveTestChrome)', () => {
    // Real browser contracts also use legacy .test.js names. Discover every
    // gated fixture, excluding only the gate's own unit tests and the structural
    // guard checks (they run inside their runner, and this one names the gates).
    // Pregate includes untracked sources; a new registered suite must not look
    // missing merely because it has not been staged yet. NULs preserve paths.
    const paths = workingTreeFiles(root, ['server/**/*.test.js', ':!server/lib/browserSuiteGate*.test.js', ':!server/test/guards']);
    // A bare resolveTestChrome( with skipIf runs unguarded in the unit job (#16799).
    // `.db.test.js` suites are owned by the DB job (scripts/lib/dbTestFiles.js), not this registry.
    const gated = paths.filter((file) => { const source = readText(join(root, file)); return source.includes('browserSuiteCanRun(') || (!file.endsWith('.db.test.js') && source.includes('resolveTestChrome(')); }).sort();
    expect(gated).toEqual([...BROWSER_SUITES].sort());
  });

  it('keeps the source tags bound to the manifest and the short render/export/cancel cases untagged', () => {
    expect(Object.keys(BROWSER_FIDELITY_TESTS).every(file => BROWSER_SUITES.includes(file))).toBe(true);
    for (const file of BROWSER_SUITES) {
      const expected = BROWSER_FIDELITY_TESTS[file] ?? [];
      const source = readText(join(root, file));
      const declarations = [...source.matchAll(/\b(?:it|threeIt)\((['"`])(\[fidelity\][^\n]*?)\1/g)];
      // Catch a marker in any registered suite, including a new registration
      // shape this small literal-title extractor does not understand yet.
      expect(source.match(/\[fidelity\]/g)?.length ?? 0, file).toBe(declarations.length);
      const tags = declarations.flatMap(([, , title]) =>
        title.includes('${fixture}') ? ['ramps', 'generated-shots'].map(fixture => title.replace('${fixture}', fixture)) : [title]);
      expect(tags, file).toEqual(expected);
      if (BROWSER_FIDELITY_ONLY_FILES.includes(file)) {
        const all = [...source.matchAll(/\b(?:it|threeIt)\((['"`])([^\n]*?)\1/g)].map(([, , title]) => title);
        expect(all, `${file} must not hide a newly added smoke case`).toEqual(expected);
      }
    }
    const documentSource = readText(join(root, 'server/services/musicVideo/documentRenderTemplates.browser.test.js'));
    const generationSource = readText(join(root, 'server/services/musicVideo/documentRenderGeneration.browser.test.js'));
    expect(documentSource).toContain("('propagates a deadline through a pending seek and waits for owned Chrome cleanup',");
    expect(generationSource).toContain("('generates and exports a Three.js scene with visible authored content',");
    expect(generationSource).toContain("('renders a generated 3-second card/still/clip document with the selected performance in-point',");
  });

  // Smoke reuses a full-profile memo verdict (browserProfileAcceptedVerdicts),
  // which is sound only while every case full skips is one smoke skips too.
  it('tags every [local-performance] case [fidelity] too, so smoke runs a subset of full', () => {
    const sources = Object.fromEntries(BROWSER_SUITES.map(file => [file, readText(join(root, file))]));
    expect(Object.values(sources).some(source => source.includes('[local-performance]'))).toBe(true);
    expect(localPerformanceTagViolations(sources)).toEqual([]);
  });
});
