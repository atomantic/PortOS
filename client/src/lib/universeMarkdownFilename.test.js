// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { slugifyUniverseName, universeMarkdownFilename } from './universeMarkdownFilename.js';
import { UNIVERSE_MARKDOWN_FILENAME_CASES } from './universeMarkdownFilename.cases.js';

describe('universeMarkdownFilename', () => {
  it.each(UNIVERSE_MARKDOWN_FILENAME_CASES)('matches the server-safe contract for %j', (name, slug, filename) => {
    expect(slugifyUniverseName(name)).toBe(slug);
    expect(universeMarkdownFilename(name)).toBe(filename);
  });
});
