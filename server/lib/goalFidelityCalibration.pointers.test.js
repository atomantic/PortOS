/**
 * The calibration task's code pointers, checked against the code.
 *
 * `GOAL_FIDELITY_REVIEW_SURFACES` addresses the three places the goal-fidelity
 * reviewer's context is assembled, and every calibration task is handed one of
 * those addresses as its starting point. They are PROSE — nothing compiles
 * against them — so a rename of `evaluateGoalFidelity`, a move of
 * `GOAL_FIDELITY_SYSTEM_PROMPT` out of `codeReview.js`, or a file split leaves
 * the table silently pointing at nothing, in a task whose whole value
 * proposition is "here is the shortest path to the code" and whose reader is an
 * unattended agent that will act on it.
 *
 * Split into its own file rather than folded into `goalFidelityCalibration.test.js`
 * because it reads source off disk: the contract suite stays pure and fast, and
 * this one pays the I/O.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOAL_FIDELITY_CONTEXT_GAPS,
  GOAL_FIDELITY_CONTEXT_GAP_FIXES,
  GOAL_FIDELITY_REVIEW_SURFACES,
  describeGoalFidelityContextGap,
} from './goalFidelityCalibration.js';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const surfaces = Object.entries(GOAL_FIDELITY_REVIEW_SURFACES);

describe('the review-surface pointers', () => {
  it.each(surfaces)('%s names a file that exists and a symbol it still declares', (_name, surface) => {
    const source = readFileSync(join(REPO_ROOT, surface.file), 'utf8');
    // Declaration, not mention: a pointer that only matches because the symbol
    // appears in a comment or an import would survive the move it exists to catch.
    expect(source).toMatch(new RegExp(`(export\\s+(async\\s+)?(function|const)|^(async\\s+)?function|^const)\\s+${surface.symbol}\\b`, 'm'));
  });

  it.each(surfaces)('%s describes itself using the file and symbol it names', (_name, surface) => {
    expect(surface.describe).toContain(surface.file);
    expect(surface.describe).toContain(surface.symbol);
  });

  it('routes every gap onto a real surface, or onto all three', () => {
    for (const gap of GOAL_FIDELITY_CONTEXT_GAPS) {
      const { surface, note } = GOAL_FIDELITY_CONTEXT_GAP_FIXES[gap];
      expect(note, `${gap} has no note`).toBeTruthy();
      if (surface !== null) expect(GOAL_FIDELITY_REVIEW_SURFACES, `${gap} names an unknown surface`).toHaveProperty(surface);
    }
  });

  it('hands every gap an address and a reason, not one or the other', () => {
    for (const gap of GOAL_FIDELITY_CONTEXT_GAPS) {
      const advice = describeGoalFidelityContextGap(gap);
      const { surface, note } = GOAL_FIDELITY_CONTEXT_GAP_FIXES[gap];
      expect(advice).toContain(note);
      // `other` is the all-three case, which is why the assertion is on the set
      // of surfaces the gap maps to rather than on one file name.
      const named = surface ? [GOAL_FIDELITY_REVIEW_SURFACES[surface]] : Object.values(GOAL_FIDELITY_REVIEW_SURFACES);
      for (const entry of named) expect(advice, `${gap} omits ${entry.file}`).toContain(entry.file);
    }
  });
});
