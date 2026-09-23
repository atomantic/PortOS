import { describe, expect, it } from 'vitest';
import {
  parseUniverseMarkdown,
  slugifyUniverseName,
  universeMarkdownFilename,
  universeToMarkdown,
} from './universeMarkdown.js';
import { UNIVERSE_MARKDOWN_FILENAME_CASES } from '../../client/src/lib/universeMarkdownFilename.cases.js';

describe('universeToMarkdown', () => {
  it('serializes the full world-bible shape in stored order', () => {
    const markdown = universeToMarkdown({
      name: 'The Bright World',
      logline: 'A world beneath two suns.',
      premise: 'Every map changes when the second sun rises.',
      styleNotes: 'Painted edges and warm copper light.',
      characters: [{ name: 'Mira', role: 'Cartographer', physicalDescription: 'Patient and precise.' }],
      places: [{ name: 'The Archive', description: 'A tower of living maps.' }],
      objects: [{ name: 'Sun Compass', description: 'Points toward the next dawn.' }],
      categories: {
        ziggurats: { kind: 'places', variations: [{ label: 'Old Ziggurat', prompt: 'terraced stone' }] },
        landscapes: { kind: 'places', variations: [{ label: 'Copper Flats', prompt: 'shimmering salt' }] },
      },
      influences: { embrace: ['copper', 'dust'], avoid: ['plastic'] },
      compositeSheets: [{ label: 'Costume Board', imageRefs: ['costume-board.png'], prompt: 'not exported' }],
      styleReferences: [{ title: 'Ink Wash', imageRefs: ['ink-wash.png'], prompt: 'not exported' }],
    });

    expect(markdown).toContain('# The Bright World');
    expect(markdown).toContain('**Logline:** A world beneath two suns.');
    expect(markdown).toContain('**Premise:** Every map changes when the second sun rises.');
    expect(markdown).toContain('## Characters\n\n### Mira');
    expect(markdown).toContain('### Mira\n\n**Role:** Cartographer');
    expect(markdown).toContain('**Physical Description:** Patient and precise.');
    expect(markdown).toContain('## Places\n\n### The Archive');
    expect(markdown).toContain('## Objects\n\n### Sun Compass');
    expect(markdown).toContain('## Categories\n\n### landscapes');
    expect(markdown).toContain('### ziggurats');
    expect(markdown.indexOf('### landscapes')).toBeLessThan(markdown.indexOf('### ziggurats'));
    expect(markdown).toContain('- Embrace: copper');
    expect(markdown).toContain('- Avoid: plastic');
    expect(markdown).toContain('## Composite Sheets\n\n- Costume Board — costume-board.png');
    expect(markdown).toContain('## Style References\n\n- Ink Wash — ink-wash.png');
    expect(markdown).not.toContain('not exported');
  });

  it('omits empty canon sections and auxiliary sections', () => {
    const markdown = universeToMarkdown({
      name: 'Empty World',
      characters: [],
      places: [],
      objects: [],
      categories: {},
      influences: { embrace: [], avoid: [] },
      compositeSheets: [],
      styleReferences: [],
    });

    expect(markdown).toBe('# Empty World\n');
    expect(markdown).not.toContain('## Characters');
    expect(markdown).not.toContain('## Categories');
    expect(markdown).not.toContain('## Influences');
  });

  it('tolerates missing optional fields and malformed list values', () => {
    expect(universeToMarkdown({ name: 'Minimal World' })).toBe('# Minimal World\n');
    expect(universeToMarkdown(null)).toBe('# Untitled Universe\n');
    expect(universeToMarkdown({ name: 'Safe', characters: [null, { name: 'One' }] }))
      .toContain('### One');
  });

  it('omits generated nested metadata so legacy reads stay deterministic', () => {
    const first = universeToMarkdown({
      name: 'Stable World',
      characters: [{
        name: 'Aster',
        props: [{ id: 'prop-old', createdAt: '2020-01-01', name: 'Compass', updatedAt: '2020-02-01' }],
      }],
    });
    const second = universeToMarkdown({
      name: 'Stable World',
      characters: [{
        name: 'Aster',
        props: [{ id: 'prop-new', createdAt: '2030-01-01', name: 'Compass', updatedAt: '2030-02-01' }],
      }],
    });
    expect(first).toBe(second);
    expect(first).toContain('Compass');
    expect(first).not.toContain('prop-old');
    expect(first).not.toContain('2020-01-01');
  });

  it('keeps multiline values inside their Markdown field', () => {
    const markdown = universeToMarkdown({
      name: 'Safe World',
      logline: 'A world\n## Not a heading',
      characters: [{ name: 'Aster', notes: 'a note\n## Not a heading' }],
    });

    expect(markdown).toContain('A world\n\\## Not a heading');
    expect(markdown).toContain('**Notes:** a note\n\\## Not a heading');
    expect(markdown).not.toMatch(/^## Not a heading$/m);
  });

  it('uses a slugline-only place as its heading without repeating the field', () => {
    const markdown = universeToMarkdown({
      name: 'Places World',
      places: [{ slugline: 'INT. TOWER - DAY' }],
    });

    expect(markdown).toContain('### INT. TOWER - DAY');
    expect(markdown).not.toContain('**Slugline:** INT. TOWER - DAY');
  });

  it('protects legacy string-shaped categories and auxiliary lists', () => {
    const markdown = universeToMarkdown({
      name: 'Legacy World',
      categories: { old: ['a line\n## Not a heading'] },
      compositeSheets: ['sheet\n## Not a heading'],
      styleReferences: ['reference\n## Not a heading'],
    });

    expect(markdown).toContain('- a line ## Not a heading');
    expect(markdown).toContain('- sheet ## Not a heading');
    expect(markdown).toContain('- reference ## Not a heading');
    expect(markdown).not.toMatch(/^## Not a heading$/m);
  });
});

describe('universe markdown filenames', () => {
  it.each(UNIVERSE_MARKDOWN_FILENAME_CASES)('matches the client-safe contract for %j', (name, slug, filename) => {
    expect(slugifyUniverseName(name)).toBe(slug);
    expect(universeMarkdownFilename(name)).toBe(filename);
  });
});

describe('parseUniverseMarkdown', () => {
  it('reads the exported editable fields, including multiline values and escaped headings', () => {
    const markdown = universeToMarkdown({
      name: 'The Bright World',
      logline: 'A world beneath two suns.',
      premise: 'Every map changes.\n## A heading inside the text.\n**Logline:** literal text, not a field.',
      styleNotes: 'Warm copper light.',
      characters: [{ name: 'Mira', aliases: ['The Mapper, Jr.', 'M.'], role: 'Cartographer', notes: 'Patient and precise.' }],
      places: [{ slugline: 'INT. THE ARCHIVE - DAY', description: 'A tower of living maps.' }],
      objects: [{ name: 'Sun Compass', description: 'Points toward the next dawn.' }],
      categories: {
        landscapes: { kind: 'places', variations: [{ label: 'Copper Flats', prompt: 'shimmering salt' }] },
      },
      influences: { embrace: ['copper', 'dust'], avoid: ['plastic'] },
    });

    expect(parseUniverseMarkdown(markdown)).toEqual({
      name: 'The Bright World',
      logline: 'A world beneath two suns.',
      premise: 'Every map changes.\n## A heading inside the text.\n**Logline:** literal text, not a field.',
      styleNotes: 'Warm copper light.',
      characters: [{
        name: 'Mira', aliases: ['The Mapper, Jr.', 'M.'], role: 'Cartographer', notes: 'Patient and precise.',
      }],
      places: [{ slugline: 'INT. THE ARCHIVE - DAY', description: 'A tower of living maps.' }],
      objects: [{ name: 'Sun Compass', description: 'Points toward the next dawn.' }],
      categories: {
        landscapes: { kind: 'places', variations: [{ label: 'Copper Flats', prompt: 'shimmering salt' }] },
      },
      influences: { embrace: ['copper', 'dust'], avoid: ['plastic'] },
    });
  });

  it('imports older and hand-authored Markdown prose as the premise', () => {
    expect(parseUniverseMarkdown('# Example Universe\n\nA concise premise.\n\nMore context.')).toEqual({
      name: 'Example Universe',
      premise: 'A concise premise.\n\nMore context.',
    });
  });

  it('rejects Markdown without a top-level universe title', () => {
    expect(() => parseUniverseMarkdown('## Characters\n\n### Mira')).toThrow(
      'Markdown must start with a top-level # universe title.',
    );
  });
});
