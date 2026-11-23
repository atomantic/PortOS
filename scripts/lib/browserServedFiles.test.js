/**
 * The runner's reading of what real-Chromium fixtures served (#17616): one
 * `{ roots, files }` per test, repo-relative, with every path the memo must
 * not key (outside the repository, installed packages, gone files) dropped.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVED_FILES_VERSION, readServedFiles } from './browserServedFiles.js';

describe('readServedFiles', () => {
  const temps = [];
  afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tempDir = (prefix) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(dir); return dir; };
  const touch = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'x\n'); };

  it('unions each test\'s fixtures and keeps only present repository files outside installs, linked ones included', () => {
    const repo = tempDir('served-repo-');
    const outside = tempDir('served-outside-');
    const records = tempDir('served-records-');
    for (const rel of ['client/src/A.browser.test.js', 'client/src/A.jsx', 'client/src/B.jsx', 'server/lib/nav.js', 'client/node_modules/react/index.js']) touch(join(repo, rel));
    touch(join(outside, 'elsewhere.js'));
    // A worktree's install is a link to the primary checkout's, so its files resolve outside the repository.
    touch(join(outside, 'primary/server/node_modules/vite/client.mjs'));
    symlinkSync(join(outside, 'primary/server/node_modules'), join(repo, 'server/node_modules'));
    // A worktree reached through a symlink still maps onto the real paths Vite reports.
    const link = join(tempDir('served-link-'), 'repo');
    symlinkSync(repo, link);
    const record = (name, value) => writeFileSync(join(records, name), JSON.stringify(value));
    const test = join(repo, 'client/src/A.browser.test.js');
    const root = join(repo, 'client');
    record('1.json', { version: SERVED_FILES_VERSION, test, root,
      files: [join(repo, 'client/src/A.jsx'), join(repo, 'client/node_modules/react/index.js'), join(repo, 'server/node_modules/vite/client.mjs'),
        join(outside, 'primary/server/node_modules/vite/client.mjs'), join(outside, 'gone.js'), join(repo, 'client/src/Gone.jsx')] });
    record('2.json', { version: SERVED_FILES_VERSION, test, root, files: [join(repo, 'client/src/B.jsx'), join(repo, 'server/lib/nav.js'), 'relative/path.js'] });
    // Ignored: another format, a test outside the repository, the repository root as the root, unreadable JSON.
    record('3.json', { version: SERVED_FILES_VERSION + 1, test, root, files: [join(repo, 'client/src/Gone.jsx')] });
    record('4.json', { version: SERVED_FILES_VERSION, test: join(outside, 'elsewhere.js'), root, files: [] });
    record('5.json', { version: SERVED_FILES_VERSION, test, root: repo, files: [join(repo, 'server/lib/nav.js')] });
    writeFileSync(join(records, '6.json'), '{ torn');

    expect(readServedFiles(records, link)).toEqual(new Map([['client/src/A.browser.test.js', {
      roots: ['client'], files: ['client/src/A.jsx', 'client/src/B.jsx', 'server/lib/nav.js'],
    }]]));
    expect(readServedFiles(null, repo)).toEqual(new Map());
    // A served file outside the repository that is no installed package cannot be keyed: no record for that test.
    record('7.json', { version: SERVED_FILES_VERSION, test, root, files: [join(outside, 'elsewhere.js')] });
    expect(readServedFiles(records, repo)).toEqual(new Map());
    expect(readServedFiles(join(records, 'missing'), repo)).toEqual(new Map());
  });
});
