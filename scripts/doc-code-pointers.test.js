import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Guards "`symbol` in `path`" pointers in the instruction and catalog docs
// agents load before editing (#11852). A rename or extraction leaves the
// pointer naming a symbol that no longer lives at the cited path, and nothing
// else notices. Prose docs stay out of scope: they use relative shorthand that
// would false-positive.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOC_FILES = [
  'AGENTS.md',
  'server/AGENTS.md',
  'client/src/AGENTS.md',
  'client/src/components/dashboard/AGENTS.md',
  'server/lib/aiToolkit/AGENTS.md',
  'server/lib/README.md',
  'client/src/lib/README.md',
  'client/src/hooks/README.md',
  'server/services/README.md',
];

const POINTER = /`([A-Za-z_$][\w$]*)(?:\([^`)]*\))?`\s+(?:in|from|at)\s+`([^`\s]+\.jsx?)`/g;

// Root, the doc's own directory, then the two source roots for shorthand paths.
const resolvePointerPath = (docFile, pointerPath) => {
  const bases = ['', dirname(docFile), 'server', 'client/src'];
  return bases.map((b) => join(REPO_ROOT, b, pointerPath)).find((p) => existsSync(p)) ?? null;
};

export const findBrokenPointers = (docFile, text) => {
  const broken = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(POINTER)) {
      const [, ident, path] = m;
      const resolved = resolvePointerPath(docFile, path);
      if (!resolved) broken.push(`${docFile}:${i + 1} \`${ident}\` -> ${path} (file not found)`);
      else if (!new RegExp(`(?<![\\w$])${ident.replace(/\$/g, '\\$')}(?![\\w$])`).test(readFileSync(resolved, 'utf8'))) {
        broken.push(`${docFile}:${i + 1} \`${ident}\` not found in ${path}`);
      }
    }
  });
  return broken;
};

describe('doc code pointers', () => {
  it('every "`symbol` in `path`" pointer resolves', () => {
    const broken = DOC_FILES.filter((f) => existsSync(join(REPO_ROOT, f)))
      .flatMap((f) => findBrokenPointers(f, readFileSync(join(REPO_ROOT, f), 'utf8')));
    expect(broken).toEqual([]);
  });

  it('reports a stale pointer with file:line', () => {
    const stale = 'See `issueWriteTail` in `server/services/pipeline/issues.js`.';
    expect(findBrokenPointers('server/AGENTS.md', `x\n${stale}`)).toEqual([
      'server/AGENTS.md:2 `issueWriteTail` not found in server/services/pipeline/issues.js',
    ]);
  });
});
