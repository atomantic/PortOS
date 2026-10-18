import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Tree-wide guard (#12093): every backticked file name in a tracked AGENTS.md
 * resolves to a file that exists.
 *
 * The AGENTS.md tree is spliced into every API-provider agent prompt, so a
 * stale name there sends every agent hunting for a file that was renamed,
 * retired, or never existed, and nothing else notices: the instruction files
 * are documentation-only to CI's planner, and no code imports them. A rename
 * or deletion anywhere in the tree can strand a reference with no import edge
 * back to this guard, which is why it rides `ALWAYS_RUN_TESTS`.
 *
 * Scope is deliberately narrow and cheap: the basename of each backticked
 * `*.js|jsx|cjs|mjs|md|json|yml|yaml` token must match a tracked file. Runtime
 * files (`data/…`, `~/…`) are never tracked, so a basename no tracked file
 * carries is verified by searching the tracked source for it instead: a
 * runtime file nothing reads or writes is as stale as a deleted module.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitLines = (...args) => git(...args).split('\n').filter(Boolean);

/**
 * Names that are intentionally cited as history: the prose says they are gone
 * and names them so a reader recognizes the retired file in old commits. This
 * list may only shrink — a new stale name gets fixed in the prose, not parked
 * here — and `pins the retired allowlist` below enforces that.
 */
export const RETIRED_NAMES = Object.freeze([
  'apiRouteCatalog.generated.json', // server/AGENTS.md: derive-at-first-use rationale names the manifest it replaced
]);

const FILE_TOKEN = /^(?:\.\/|~\/|<repo-root>\/)?([\w.][\w./-]*\.(?:jsx?|[cm]js|md|json|ya?ml))$/;
/** Example names the prose uses as stand-ins (`foo.js:412`), never real files. */
const PLACEHOLDER_STEM = /^(?:foo|bar|baz|qux|x|y|example)$/;

/**
 * Backticked file names in `text`, each with the line it sits on. A token is
 * taken up to the first `:` or `#` (`file.js:412`, `routes/x.js#schema`);
 * placeholders, globs, and example stems (`<x>`, `*`, `{…}`, `foo.js`) are
 * not file names.
 */
export const extractFileTokens = (text) => {
  const tokens = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const raw = m[1].split(/[:#]/)[0].trim();
      if (/[<>*{}\s]/.test(raw)) continue;
      const match = raw.match(FILE_TOKEN);
      const stem = match ? basename(match[1]).replace(/\.[^.]+$/, '') : '';
      // A bare suffix (`.generated.json`, `.test.js`) names a convention, not a file.
      if (!match || !stem || stem.startsWith('.') || PLACEHOLDER_STEM.test(stem)) continue;
      tokens.push({ line: i + 1, path: match[1] });
    }
  });
  return tokens;
};

const trackedAgentsFiles = () => gitLines('ls-files', '--', 'AGENTS.md', '*/AGENTS.md');

const trackedBasenames = () => new Set(gitLines('ls-files').map((p) => basename(p)));

/** True when some tracked, non-test source names `name` as a string. */
const sourceMentions = (name) => {
  try {
    return git('grep', '-lF', name, '--', '*.js', '*.cjs', '*.mjs', ':!*.test.js', ':!*.md').trim().length > 0;
  } catch (err) {
    if (err.status === 1) return false; // git grep: no match
    throw err;
  }
};

export const findStaleReferences = ({ files, tracked, mentions = sourceMentions, retired = RETIRED_NAMES }) => {
  const stale = [];
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const { line, path } of extractFileTokens(text)) {
      const name = basename(path);
      if (retired.includes(name) || tracked.has(name) || mentions(name)) continue;
      stale.push(`${file}:${line} \`${path}\` (no tracked file has this basename and no tracked source names it)`);
    }
  }
  return stale;
};

describe('instruction file references', () => {
  const files = trackedAgentsFiles();
  const tracked = trackedBasenames();

  it('scans every tracked AGENTS.md', () => {
    expect(files).toContain('AGENTS.md');
    expect(files).toContain('server/AGENTS.md');
    expect(files).toContain('client/src/AGENTS.md');
  });

  it('every backticked file name in an AGENTS.md matches a tracked file', () => {
    expect(findStaleReferences({ files, tracked })).toEqual([]);
  });

  it('pins the retired allowlist: still absent, still cited, never growing', () => {
    expect(RETIRED_NAMES.length).toBeLessThanOrEqual(1);
    const cited = new Set(files.flatMap((f) => extractFileTokens(readFileSync(join(REPO_ROOT, f), 'utf8')).map((t) => basename(t.path))));
    for (const name of RETIRED_NAMES) {
      expect(tracked.has(name), `${name} is tracked again — drop it from RETIRED_NAMES`).toBe(false);
      expect(cited.has(name), `${name} is no longer cited by any AGENTS.md — drop it from RETIRED_NAMES`).toBe(true);
    }
  });

  it('extracts file tokens and skips placeholders, globs, and anchors', () => {
    const text = [
      'Read `server/lib/real.js` and `routes/other.js#schema` at `third.jsx:412`, `./docs/X.md`.',
      'Not files: `data/<x>`, `*.test.js`, `.generated.json`, `.changelog/v{version}.md`, `npm run x`, `foo.js:412`, `@AGENTS.md`.',
      'Runtime: `data/cos/task-schedule.json` and `~/.portos/agent-key.json`.',
    ].join('\n');
    expect(extractFileTokens(text)).toEqual([
      { line: 1, path: 'server/lib/real.js' },
      { line: 1, path: 'routes/other.js' },
      { line: 1, path: 'third.jsx' },
      { line: 1, path: 'docs/X.md' },
      { line: 3, path: 'data/cos/task-schedule.json' },
      { line: 3, path: '.portos/agent-key.json' },
    ]);
  });

  it('reports a stale name with file:line, and a source mention or the retired list clears it', () => {
    const noSource = findStaleReferences({ files: ['server/AGENTS.md'], tracked: new Set(), mentions: () => false, retired: [] });
    expect(noSource.length).toBeGreaterThan(0);
    expect(noSource.every((s) => /^server\/AGENTS\.md:\d+ `[^`]+` \(no tracked file has this basename and no tracked source names it\)$/.test(s))).toBe(true);
    expect(noSource.some((s) => s.includes('`apiRouteCatalog.generated.json`'))).toBe(true);
    expect(findStaleReferences({ files: ['server/AGENTS.md'], tracked: new Set(), mentions: () => true, retired: [] })).toEqual([]);
  });
});
