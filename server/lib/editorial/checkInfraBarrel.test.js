import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as barrel from './checkInfra.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'checkInfra.js'), 'utf8');
const MODULE_FILES = readdirSync(join(HERE, 'checkInfra'))
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort();

// Issue #2842 split the 2,635-line checkInfra.js into ./checkInfra/* with the
// original file kept as a re-exporting barrel (the same treatment #1152 gave
// arcPlanner.js). This pins that contract: every module export must be
// reachable through the barrel AS THE SAME object, so the ~30 existing
// `from './checkInfra.js'` imports in ./checks/*, checkRegistry.js and the
// pipeline runner survive untouched.
describe('checkInfra barrel re-exports (issue #2842)', () => {
  it('re-exports every module in ./checkInfra/', () => {
    for (const f of MODULE_FILES) {
      expect(BARREL_SRC, `missing barrel re-export for checkInfra/${f}`)
        .toContain(`'./checkInfra/${f}'`);
    }
  });

  it.each(MODULE_FILES)('%s exports are reachable from the barrel as the same objects', async (f) => {
    const mod = await import(`./checkInfra/${f}`);
    const keys = Object.keys(mod);
    expect(keys.length, `${f} exports nothing`).toBeGreaterThan(0);
    for (const key of keys) {
      expect(barrel[key], `barrel re-export of '${key}' (from ${f})`).toBe(mod[key]);
    }
  });

  it('no symbol collides across the split modules (flat `export *` would be ambiguous)', async () => {
    const seen = new Map();
    const collisions = [];
    for (const f of MODULE_FILES) {
      const mod = await import(`./checkInfra/${f}`);
      for (const key of Object.keys(mod)) {
        if (seen.has(key) && seen.get(key).value !== mod[key]) {
          collisions.push(`${key}: ${seen.get(key).file} vs ${f}`);
        } else if (!seen.has(key)) {
          seen.set(key, { file: f, value: mod[key] });
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('keeps the public surface the check files depend on', () => {
    for (const fn of [
      'normalizeCheckScopes', 'primaryCheckScope', 'runManuscriptLlmCheck',
      'runManuscriptLlmCheckInline', 'mapLlmFindings', 'editorialFindingKey',
      'editorialPriorFindingsDigest', 'editorialSetupDigest', 'buildSetupDigestPrompt',
      'buildCustomCheckPrompt', 'canonCharacterTraitsSummary', 'canonCharacterStatesSummary',
      'continuityLedgerSummary', 'characterVoiceProfiles', 'revealGatedCanonSummary',
      'canonRosterNamesSummary', 'canonWorldSummary', 'buildCastIdentities',
      'buildRosterAppearances', 'scenePovSummary', 'sceneGroundingSummary',
      'plotlineCoverageSummary', 'runDensityCheck', 'comicLetteringIssues',
      'proseSyncPairs', 'readingGradeLevel', 'escalateSeverity', 'castNameTokens',
      'relationshipCanon', 'attachmentCanon',
    ]) {
      expect(typeof barrel[fn], fn).toBe('function');
    }
    for (const c of [
      'CHECK_SCOPES', 'CHECK_KINDS', 'CHECK_SEVERITIES', 'SEVERITIES',
      'EDITORIAL_SOURCES', 'CHECK_FIELD_TYPES', 'CUT_TYPES', 'SAFE_CUT_TYPES',
      'ON_THE_NOSE_SUBTYPES', 'POV_PERSON_LABELS',
    ]) {
      expect(barrel[c], c).toBeDefined();
    }
    // The externals hub keeps forwarding zod + the pure sibling scanners.
    expect(typeof barrel.z?.object, 'z.object').toBe('function');
    expect(typeof barrel.estimateTokens, 'estimateTokens').toBe('function');
    expect(typeof barrel.parseComicScript, 'parseComicScript').toBe('function');
  });
});
