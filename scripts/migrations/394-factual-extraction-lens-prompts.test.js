import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './394-factual-extraction-lens-prompts.js';

const read = (filename) =>
  readFileSync(`${repoRoot}/data.reference/prompts/stages/${filename}`, 'utf8');

const BIBLE_FILES = ['writers-room-characters.md', 'writers-room-places.md', 'writers-room-objects.md'];

describe('migration 394 — factual extraction lens prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-394-factual-extraction-lens-prompts-',
  });

  it.each(Object.keys(NEW_SHIPPED_MD5))(
    '%s gates the lens behind the flag catalogExtraction supplies',
    (filename) => {
      const body = read(filename);
      // Without the SECTION the non-fiction rules would apply to every Writers
      // Room extraction, which is the opposite of the fix. The flag is the only
      // thing separating a memoir from a novel on this path.
      expect(body).toContain('{{#factual}}');
      expect(body).toContain('{{/factual}}');
    },
  );

  it.each(BIBLE_FILES)('%s tells the model the material is non-fiction about real subjects', (filename) => {
    const body = read(filename);
    expect(body).toContain('## Lens: non-fiction');
    // The rule every bible kind shares: the fiction prompts' invent-to-fill
    // instructions become fabrications about something that actually exists.
    expect(body).toContain('**A wrong guess is worse than a gap.**');
  });

  it('suspends the character prompt\'s two role-tag / invent-to-fill rules by name', () => {
    const body = read('writers-room-characters.md');
    // These two instructions are what mint `MOM` / `DAD` out of a memoir and
    // what invent a real person's ethnicity and wardrobe. Naming them is the
    // point — a generic "be accurate" line does not override a specific rule.
    expect(body).toContain('THE BARTENDER');
    expect(body).toContain('`Mom`, never `MOM`');
    expect(body).toContain('"commit when prose is silent, then log it" rule is SUSPENDED');
    expect(body).toContain('Do not visually differentiate the cast');
  });

  it('reframes all three light kinds for lived material', () => {
    const body = read('catalog-ideas-scenes-concepts.md');
    const lens = body.split('{{#factual}}')[1].split('{{/factual}}')[0];
    // A factual section that redefined only one kind would leave the other two
    // reading a memoir as invented world-building.
    expect(lens).toContain('**idea**');
    expect(lens).toContain('**scene**');
    expect(lens).toContain('**concept**');
    expect(lens).toContain('remembered moment');
    expect(lens).toContain('NOT a magic system, faction, or piece of world-building lore');
  });

  it('gives the light stage a Source block that renders under both lenses', () => {
    const body = read('catalog-ideas-scenes-concepts.md');
    const sourceBlock = body.split('{{#sourceKind}}')[1].split('{{/sourceKind}}')[0];
    // Gated on sourceKind rather than the title so an UNTITLED paste still tells
    // the model how the text was captured; gated at all so the block never
    // renders as an empty stub (the bug this issue reports on the catalog path).
    expect(sourceBlock).toContain('{{#scrapTitle}}- Title: {{scrapTitle}}');
    expect(sourceBlock).toContain('- Captured as: {{sourceKind}}');
    // It must sit OUTSIDE the factual section — the title frames a novel excerpt
    // just as usefully as a journal entry.
    expect(body.indexOf('{{#sourceKind}}')).toBeLessThan(body.indexOf('{{#factual}}'));
  });
});
