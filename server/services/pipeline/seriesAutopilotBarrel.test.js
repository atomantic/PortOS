import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

// seriesAutopilot pulls in the pipeline + universe graph transitively; stub the
// peer fan-out the way the main autopilot suites do so this pure import-shape
// test stays hermetic.
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

const barrel = await import('./seriesAutopilot.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'seriesAutopilot.js'), 'utf8');
const MODULE_FILES = readdirSync(join(HERE, 'seriesAutopilot'))
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort();

// Issue #2842 split the 2,541-line seriesAutopilot.js into ./seriesAutopilot/*
// with the original file kept as a re-exporting barrel (the same treatment
// #1152 gave arcPlanner.js). This pins that contract so the routes, the CDO
// plan-advance loop and the existing suites keep importing from one path.
describe('seriesAutopilot barrel re-exports (issue #2842)', () => {
  it('re-exports every module in ./seriesAutopilot/', () => {
    for (const f of MODULE_FILES) {
      expect(BARREL_SRC, `missing barrel re-export for seriesAutopilot/${f}`)
        .toContain(`'./seriesAutopilot/${f}'`);
    }
  });

  it.each(MODULE_FILES)('%s exports are reachable from the barrel as the same objects', async (f) => {
    const mod = await import(`./seriesAutopilot/${f}`);
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
      const mod = await import(`./seriesAutopilot/${f}`);
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

  it('keeps the public surface the routes + CDO loop depend on', () => {
    for (const fn of [
      'startSeriesAutopilot', 'cancelSeriesAutopilot', 'isAutopilotActive',
      'attachClient', 'recoverStuckAutopilots', 'resolveNextStep',
      'requiredScriptStages', 'isComicTarget', 'wantsComic', 'wantsVisual',
      'wantsTeaser', 'scriptStructurallyReady', 'visualReady', 'trackConvergence',
      'resolveAutopilotRounds', 'resolveAutopilotFoundationGate',
      'resolveAutopilotFoundationThreshold', 'resolveAutopilotReadinessGate',
      'resolveAutopilotCheckPauseThreshold', 'resolveAutopilotNotifyOnPause',
      'resolveAutopilotProduceTeaser', 'resolveAutopilotRevision',
    ]) {
      expect(typeof barrel[fn], fn).toBe('function');
    }
    for (const c of [
      'autopilotEvents', 'AUTOPILOT_TERMINAL_TYPES', 'MAX_ARC_VERIFY_ROUNDS',
      'MAX_EDITORIAL_ROUNDS', 'MAX_BEAT_CONTINUITY_ROUNDS', 'MAX_FOUNDATION_ROUNDS',
      'MAX_CHILD_RETRIES', 'DIVERGENCE_PATIENCE', 'VISUAL_DRAFT_ENABLED',
    ]) {
      expect(barrel[c], c).toBeDefined();
    }
  });

  it('preserves the __testing internals bundle pulled from the split modules', () => {
    expect(Object.keys(barrel.__testing).sort()).toEqual([
      'buildDryRunPlan', 'meanQualityScore', 'providerIdOpts', 'providerOverrideOpts',
      'runs', 'summarizePlanCost',
    ]);
    expect(barrel.__testing.runs).toBeInstanceOf(Map);
  });
});
