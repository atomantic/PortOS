import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as barrel from './layeredIntelligence.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'layeredIntelligence.js'), 'utf8');
const MODULE_FILES = readdirSync(join(HERE, 'layeredIntelligence'))
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort();

// Issue #2842 split the 2,631-line layeredIntelligence.js into
// ./layeredIntelligence/* with the original file kept as a re-exporting barrel
// (the same treatment #1152 gave arcPlanner.js). This pins that contract so the
// handler, routes and the existing suites keep importing from one path.
describe('layeredIntelligence barrel re-exports (issue #2842)', () => {
  it('re-exports every module in ./layeredIntelligence/', () => {
    for (const f of MODULE_FILES) {
      expect(BARREL_SRC, `missing barrel re-export for layeredIntelligence/${f}`)
        .toContain(`'./layeredIntelligence/${f}'`);
    }
  });

  it.each(MODULE_FILES)('%s exports are reachable from the barrel as the same objects', async (f) => {
    const mod = await import(`./layeredIntelligence/${f}`);
    const keys = Object.keys(mod);
    expect(keys.length, `${f} exports nothing`).toBeGreaterThan(0);
    for (const key of keys) {
      expect(barrel[key], `barrel re-export of '${key}' (from ${f})`).toBe(mod[key]);
    }
  });

  it('no symbol collides across the split modules', async () => {
    const seen = new Map();
    const collisions = [];
    for (const f of MODULE_FILES) {
      const mod = await import(`./layeredIntelligence/${f}`);
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

  it('keeps the public surface the handler + routes depend on', () => {
    for (const fn of [
      'defaultLayeredIntelligenceConfig', 'getEffectiveConfig', 'isScopeAllowed',
      'slugMarker', 'extractSlugFromBody', 'normalizeSlug', 'isProposalDuplicate',
      'findSemanticDuplicate', 'checkSemanticDuplicate', 'isAppParked',
      'validateReasonerResponse', 'resolveBlockOnIssue', 'isHandoffEligible',
      'buildHandoffTask', 'filerForTracker', 'trackerSupportsPause',
      'deriveOutcome', 'computeOutcomesReport', 'computeSelfEvalSummary',
      'computeScopeAwareness', 'computeProposalExecutionAwareness',
      'computeCrossReferenceAnalysis', 'computeHandoffRouting',
      'computeHardExclusionGate', 'computeHardExclusionNotice', 'buildPrompt',
      'gatherSources', 'gatherPlannedWork', 'readLiTaskMetrics',
      'listForgeIssues', 'fileProposalToForge', 'listJiraIssues',
      'fileProposalToJira', 'appendProposalToPlan', 'extractPlanSlugs',
    ]) {
      expect(typeof barrel[fn], fn).toBe('function');
    }
    for (const c of [
      'LI_LABEL', 'LI_BLOCKING_LABEL', 'PLANNED_WORK_LABEL', 'LI_JOB_ID',
      'PROPOSAL_SCOPES', 'PORTOS_ONLY_SCOPES', 'PROPOSAL_COMPLEXITIES',
      'LI_SCHEDULED_TASK_TYPE', 'LI_TASK_TYPE', 'PROPOSAL_OUTCOMES',
      'SELF_IMPROVE_SCOPES',
    ]) {
      expect(barrel[c], c).toBeDefined();
    }
    // The playbook is read synchronously at module load from a path relative to
    // the module file — the split moved the module a directory deeper, so this
    // guards the `..` hop back to server/services/.
    expect(typeof barrel.LI_PROPOSAL_PLAYBOOK).toBe('string');
    expect(barrel.LI_PROPOSAL_PLAYBOOK.length).toBeGreaterThan(100);
  });
});
