import { describe, expect, it } from 'vitest';

import { runPromptMigrationTests, sampleBody } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './394-factual-extraction-lens-prompts.js';

const read = (filename) => sampleBody(filename);

// Per file: the refrains its lens section must carry. The three bible prompts
// state the non-fiction frame and the absolute no-guess rule; the light stage
// reframes its three kinds instead, pinned separately below.
const NO_GUESS = '**A wrong guess is worse than a gap.**';
const LENS_CONTENT = Object.freeze({
  'writers-room-characters.md': ['## Lens: non-fiction', NO_GUESS],
  'writers-room-places.md': ['## Lens: non-fiction', NO_GUESS],
  'writers-room-objects.md': ['## Lens: non-fiction', NO_GUESS],
  'catalog-ideas-scenes-concepts.md': ['## Lens: non-fiction'],
});

describe('migration 394 — factual extraction lens prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-394-factual-extraction-lens-prompts-',
  });

  it.each(Object.entries(LENS_CONTENT))('%s gates its lens behind the flag catalogExtraction supplies', (filename, refrains) => {
    const body = read(filename);
    // Without the SECTION the non-fiction rules would apply to every Writers
    // Room extraction, which is the opposite of the fix. The flag is the only
    // thing separating a memoir from a novel on this path.
    expect(body).toContain('{{#factual}}');
    expect(body).toContain('{{/factual}}');
    // And the fiction prompts' invent-to-fill instructions become fabrications
    // about something that actually exists, so the no-guess rule is absolute.
    for (const refrain of refrains) expect(body).toContain(refrain);
  });

  it('keeps every managed file in the lens-content table', () => {
    // Otherwise a file added to the migration silently ships with no lens and
    // no test naming it.
    expect(Object.keys(LENS_CONTENT).sort()).toEqual(Object.keys(NEW_SHIPPED_MD5).sort());
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

  it('gives the light stage a Source block on the shared work.* framing', () => {
    const body = read('catalog-ideas-scenes-concepts.md');
    const sourceBlock = body.split('{{#work.kind}}')[1].split('{{/work.kind}}')[0];
    // Reads the same slots the three bible prompts declare, rather than aliases
    // that can drift from them. Gated on the capture kind rather than the title
    // so an UNTITLED paste still tells the model how the text was captured, and
    // gated at all so the block never renders as the empty stub #7609 reports.
    expect(sourceBlock).toContain('{{#work.title}}- Title: {{work.title}}');
    expect(sourceBlock).toContain('- Captured as: {{work.kind}}');
    // It must sit OUTSIDE the factual section — the title frames a novel excerpt
    // just as usefully as a journal entry.
    expect(body.indexOf('{{#work.kind}}')).toBeLessThan(body.indexOf('{{#factual}}'));
  });
});
