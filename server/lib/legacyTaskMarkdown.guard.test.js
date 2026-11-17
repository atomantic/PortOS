import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { trackedFiles } from '../../scripts/lib/trackedFiles.js';

describe('the Markdown format stays out of the runtime (#16407)', () => {
  it('is imported only by db-migration 018 outside tests', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const importers = trackedFiles(root, ['server/**/*.js', 'server/**/*.mjs', 'scripts/**/*.js'])
      .filter((file) => !/\.test\.js$/.test(file) && file !== 'server/lib/legacyTaskMarkdown.js')
      .filter((file) => /from\s+['"][^'"]*legacyTaskMarkdown\.js['"]|import\(\s*['"][^'"]*legacyTaskMarkdown\.js/.test(readFileSync(join(root, file), 'utf8')));
    expect(importers).toEqual(['server/scripts/db-migrations/018-cos-tasks-from-files.js']);
  });
});
