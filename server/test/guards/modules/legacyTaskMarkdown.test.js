
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

describe('the Markdown format stays out of the runtime (#16407)', () => {
  it('is imported only by db-migration 018 outside tests', () => {
    const importers = trackedFiles(REPO_ROOT, ['server/**/*.js', 'server/**/*.mjs', 'scripts/**/*.js'])
      .filter((file) => !/\.test\.js$/.test(file) && file !== 'server/lib/legacyTaskMarkdown.js')
      .filter((file) => /from\s+['"][^'"]*legacyTaskMarkdown\.js['"]|import\(\s*['"][^'"]*legacyTaskMarkdown\.js/.test(readText(join(REPO_ROOT, file))));
    expect(importers).toEqual(['server/scripts/db-migrations/018-cos-tasks-from-files.js']);
  });
});
