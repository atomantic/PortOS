import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './367-character-evolution-editorial-prompts.js';

const read = (filename) =>
  readFileSync(`${repoRoot}/data.reference/prompts/stages/${filename}`, 'utf8');

describe('migration 367 — character-evolution editorial prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-367-character-evolution-editorial-prompts-',
  });

  it.each(Object.keys(NEW_SHIPPED_MD5))(
    '%s gates the lens behind the variable characterArc.js supplies',
    (filename) => {
      const body = read(filename);
      // Without the mustache SECTION the block would render even with no lens
      // authored — which is exactly the "degrades to today's behavior" promise
      // the epic makes. Without the VARIABLE the section renders empty forever.
      expect(body).toContain('{{#characterEvolution}}');
      expect(body).toContain('{{characterEvolution}}');
      expect(body).toContain('{{/characterEvolution}}');
    },
  );

  it.each(Object.keys(NEW_SHIPPED_MD5))(
    '%s states the causal chain and rules every declared outcome',
    (filename) => {
      const body = read(filename);
      // The chain is what the arcs block alone cannot express; a template that
      // ships the lens data without it leaves the model to guess the mapping.
      for (const stage of [
        'control strategy failing',
        'pressure forces exploration',
        'commitment to change',
        'cost tested',
        'final proof',
      ]) {
        expect(body).toContain(stage);
      }
      // Each declared outcome must be RULED on: an unruled outcome falls back to
      // the pre-lens reading, which is precisely the bug (a tragic refusal or a
      // deliberate flat arc reported as a defect).
      for (const outcome of ['full-change', 'tragic-refusal', 'flat-testing', 'partial-open', 'undeclared']) {
        expect(body).toContain(`\`${outcome}\``);
      }
    },
  );

  it.each(Object.keys(NEW_SHIPPED_MD5))(
    '%s keeps the two failure modes separable and refuses unproven evidence',
    (filename) => {
      const body = read(filename);
      // The issue's core distinction: these demand different repairs, so the
      // finding text must be separable by a reader (and by a downstream filter).
      expect(body).toContain('No authored intent:');
      expect(body).toContain('Authored intent not delivered:');
      // A stale/unverified anchor can never read as verified (epic non-negotiable).
      expect(body).toContain('[stale]');
      expect(body).toContain('[unverified]');
      expect(body).toContain('NOT PROVEN');
      // No fixed percentages / chapter counts / literal-opposite belief.
      expect(body).toContain('NOT a page count, a chapter count');
    },
  );

  it('makes external victory without behavioral proof a climax finding', () => {
    // The single behavior #6418 names as the reason the lens reaches this check
    // at all — a plot the protagonist wins while their declared change is never
    // demonstrated.
    expect(read('pipeline-editorial-climax-agency.md'))
      .toContain('winning the external fight is not');
  });

  it('stops the secondary-arc check flagging a declared flat or tragic cast member', () => {
    const body = read('pipeline-editorial-secondary-arc.md');
    expect(body).toContain('must NOT be reported as a flat arc');
    // The inverse finding the outcome enables, so the declaration is not a mute button.
    expect(body).toContain('flag a declared refusal that was never tested');
  });
});
