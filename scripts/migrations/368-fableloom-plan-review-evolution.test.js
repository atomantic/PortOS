import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './368-fableloom-plan-review-evolution.js';

// Wrap-insensitive: the template is hard-wrapped at 80 columns, so a phrase
// assertion keyed to today's line breaks would fail on a pure re-wrap that
// changed no guidance at all.
const body = () => readFileSync(
  `${repoRoot}/data.reference/prompts/stages/fableloom-review-series-plan.md`,
  'utf8',
).replace(/\s+/g, ' ');

describe('migration 368 — FableLoom plan review evolution lens', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-368-fableloom-plan-review-evolution-',
  });

  it('gates the lens behind the variable weave.js supplies', () => {
    // Without the mustache SECTION the block renders even with no lens authored
    // — which breaks the "unchanged review for a plan with no lens" promise.
    // Without the VARIABLE the section renders empty forever.
    const md = body();
    expect(md).toContain('{{#characterEvolutions}}');
    expect(md).toContain('{{characterEvolutions}}');
    expect(md).toContain('{{/characterEvolutions}}');
  });

  it('states the causal chain and rules every declared outcome', () => {
    const md = body();
    // The chain is what the plan digest alone cannot express; shipping the lens
    // data without it leaves the model to guess the mapping.
    for (const stage of [
      'control strategy failing',
      'pressure forces exploration',
      'commitment to change',
      'cost tested',
      'final proof',
    ]) {
      expect(md).toContain(stage);
    }
    // An unruled outcome falls back to the pre-lens reading, which is the bug:
    // a tragic refusal or a deliberate flat arc reported as an arc gap.
    for (const outcome of ['full-change', 'tragic-refusal', 'flat-testing', 'partial-open', 'undeclared']) {
      expect(md).toContain(`\`${outcome}\``);
    }
    expect(md).toContain('do not report it as a flat arc');
    expect(md).toContain('UNEARNED CLAIM OF COMPLETION');
  });

  it('makes an external victory with no behavioral proof a risk, not a strength', () => {
    // The single behavior #6418 names as the reason the lens reaches the plan
    // review at all.
    const md = body();
    expect(md).toContain('not the defeat of an external obstacle');
    expect(md).toContain('is a risk, not a strength');
  });

  it('keeps the two failure modes separable and demands a concrete repair', () => {
    const md = body();
    // They need different repairs, so the risk text must stay separable by a
    // reader (and by a downstream filter).
    expect(md).toContain('`No authored intent:`');
    expect(md).toContain('`Authored intent not delivered:`');
    expect(md).toContain('must name a concrete scene or plan repair');
    // A stale/unverified anchor can never read as verified (epic non-negotiable).
    expect(md).toContain('[stale]');
    expect(md).toContain('[unverified]');
    expect(md).toContain('NOT PROVEN');
  });

  it('lets a satisfied lens end the planning loop', () => {
    // `editorialAutopilot.runPlanning()` re-runs feedback while `risks` is
    // non-empty. A prompt that always emits an evolution risk turns that into a
    // maxRounds spin, so the template has to say the empty answer is correct.
    const md = body();
    expect(md).toContain('this pass contributes nothing');
    expect(md).toContain('An empty `risks` array is the correct answer');
    // No page counts / episode quotas / literal-opposite belief.
    expect(md).toContain('NOT a page count, a chapter count, an episode quota');
  });
});
