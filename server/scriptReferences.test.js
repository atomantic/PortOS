/**
 * Tree-wide guard: every top-level scripts/ file must be referenced by something
 * live in the repo (code, a workflow, package.json or a doc), so a script no one
 * can find or run is either documented in docs/SCRIPTS.md or deleted (#16089).
 *
 * A file is referenced when another tracked file contains its name as a whole
 * token, or, for a Python module, its stem (`import ltx25_reference`). Exempt:
 * `*.test.js`, which the server Vitest run collects through `../scripts/**` globs.
 * Changelogs and point-in-time records (plans, decisions, research) do not count:
 * a historical mention is not a pointer for the next reader.
 * No allowlist: document the script or delete it.
 */
import { lstatSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { trackedFiles } from '../scripts/lib/trackedFiles.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOP_LEVEL_SCRIPT = /^scripts\/[^/]+$/;
const VITEST_COLLECTED = /\.test\.js$/;
const HISTORICAL = /^(?:\.changelog\/|docs\/(?:plans|decisions|research)\/)/;
const TOKEN = /[\w.-]+/g;

const tokensOf = (text) => new Set(
  [...text.matchAll(TOKEN)].map((match) => match[0].replace(/\.+$/, '')),
);

/** Map each candidate's referencing key (file name, plus stem for Python) to its owner path. */
function referenceKeys(candidates) {
  const keys = new Map();
  for (const path of candidates) {
    const name = basename(path);
    keys.set(name, path);
    if (name.endsWith('.py')) keys.set(name.slice(0, -3), path);
  }
  return keys;
}

/** Candidate scripts that no other live tracked file references. */
export function unreferencedScripts(candidates, corpus) {
  const keys = referenceKeys(candidates);
  const referenced = new Set();
  for (const path of corpus) {
    // Tracked symlinks (.claude/commands/do/*) point into the lib/slashdo submodule; a symlink holds no text of its own.
    const full = join(REPO_ROOT, path);
    if (!lstatSync(full).isFile()) continue;
    const text = readFileSync(full, 'utf8');
    for (const token of tokensOf(text)) {
      const owner = keys.get(token);
      if (owner && owner !== path) referenced.add(owner);
    }
  }
  return candidates.filter((path) => !referenced.has(path));
}

describe('top-level scripts/ reference guard (#16089)', () => {
  it('every top-level scripts/ file is referenced by code, a workflow, package.json or a live doc', () => {
    const files = trackedFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const candidates = files.filter((path) => TOP_LEVEL_SCRIPT.test(path) && !VITEST_COLLECTED.test(path));
    expect(candidates.length).toBeGreaterThan(100);
    const corpus = files.filter((path) => !HISTORICAL.test(path));
    expect(unreferencedScripts(candidates, corpus), 'document in docs/SCRIPTS.md or delete').toEqual([]);
  }, 60_000); // reads every tracked file (~47 MB) once; slower than the default 5 s on a loaded machine
});
