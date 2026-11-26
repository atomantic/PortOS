import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALWAYS_PUBLIC_API_PATHS } from '../../../lib/apiAccessPolicy.js';
import { getApiRouteCatalog } from '../../../lib/apiRouteGraph.js';
import { ERROR_CODES_BY_STATUS } from '../../../lib/errorHandler.js';
import { NAV_COMMANDS } from '../../../lib/navManifest.js';
import { guardCorpus, readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';
import { importGrowthSkipReason, resolveImportGrowthBase } from '../../../../scripts/lib/importGrowth.js';
import { discoverWorkspaces, workspaceDir } from '../../../../scripts/trusted-rebuilds.js';

const GUARD_PATH = 'server/test/guards/repo/docsIntegrity.test.js';
const MD_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const readDoc = (file) => readText(join(REPO_ROOT, file));
const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const AGENT_FILES = trackedFiles(REPO_ROOT, ['AGENTS.md', '*/AGENTS.md']);
const TRACKED = trackedFiles(REPO_ROOT);
const TRACKED_SET = new Set(TRACKED);

function linkedMarkdownPaths(indexFile, text) {
  const targets = new Set();
  for (const [, , link] of text.matchAll(MD_LINK)) {
    const path = link.split(/[?#]/)[0];
    if (!path.endsWith('.md') || /^(?:\/|[a-z][a-z+.-]*:)/i.test(path)) continue;
    const target = posix.join(posix.dirname(indexFile), path);
    if (!target.startsWith('../')) targets.add(target);
  }
  return targets;
}

const DOC_INDEX_LINKS = linkedMarkdownPaths('docs/README.md', readDoc('docs/README.md'));
const INDEXED_DOCS = new Set([
  'README.md', 'docs/README.md', ...DOC_INDEX_LINKS, ...linkedMarkdownPaths('README.md', readDoc('README.md')),
]);

const markdownIn = (dir) => readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => `${dir}/${entry.name}`);

// Living guides carry present-tense route and size contracts. The index can
// also link decision records, plans, and research that preserve past context.
const LIVING_DOCS = [
  ...markdownIn('docs').filter((file) => file !== 'docs/README.md'),
  ...markdownIn('docs/features'),
];


// Regression guard for #4852. `AGENTS.md` is the cross-vendor agent-instructions
// standard every CLI PortOS drives reads — except Claude Code, whose memory
// discovery hardcodes `CLAUDE.md` with no configurable filename. So each
// location carries both, and the second is a one-line `@AGENTS.md` import.
//
// Two ways that arrangement silently breaks, both guarded here:
//   1. Someone "tidies" the bridge into a symlink. A git symlink checked out on
//      a Windows runner without symlink support materializes as a 9-byte text
//      file containing the literal string `AGENTS.md` — a CLAUDE.md from which
//      Claude Code loads nothing, and the repo's whole memory disappears for
//      that agent with no error anywhere.
//   2. New prose reintroduces `CLAUDE.md` as THE instructions filename, so an
//      agent (or a scaffolded repo) is pointed at a file that may not exist.
//
// Enumeration is via `git grep`, so the scan covers exactly *tracked* files —
// gitignored runtime state (`data/`) and the `lib/slashdo` submodule (a separate
// upstream repo, not ours to police) drop out for free.

/** Every directory that carries the pair. Adding a nested one? Add it here. */
const INSTRUCTION_DIRS = [
  '.',
  'client/src',
  'client/src/components/dashboard',
  'server',
  'server/lib/aiToolkit',
];

/**
 * Byte ceilings (#16087). Root AGENTS.md loads into every session and the whole
 * tree is spliced into API-provider agent prompts, so growth is paid by every
 * task. When a file hits its ceiling, move task-specific procedure into a skill
 * (`.claude/skills/`) or a doc rather than raising the number. Rules guarding
 * data loss, destructive actions, privacy and spend stay in root.
 */
const ROOT_MAX_BYTES = 16 * 1024;
const NESTED_MAX_BYTES = 6 * 1024;
// An absolute 90% line failed concurrent branches: two edits that each fit
// under it merged separately and broke main (five branches on 2026-11-15). The
// headroom rule is therefore relative to the merge base: a file already above
// 90% there may not grow in this change, so it can only shrink toward the line.
// The ceiling itself stays the only absolute failure.
const HEADROOM_FRACTION = 0.9;

/**
 * Pure policy. Each entry is { file, size, baseSize, limit }; `baseSize` is the
 * file's size at the merge base, or 0 when the file did not exist there.
 * Returns one message per violation.
 */
function instructionFileViolations(entries) {
  return entries.flatMap(({ file, size, baseSize, limit }) => {
    if (size > limit) return [`${file}: ${size} bytes > ${limit} byte ceiling; move procedure into a skill or doc`];
    const line = Math.floor(limit * HEADROOM_FRACTION);
    if (baseSize > line && size > baseSize) {
      return [`${file}: grew ${baseSize} -> ${size} bytes while already above 90% (${line}) of its ${limit} ceiling at the merge base; trim as much as you add`];
    }
    return [];
  });
}

const SHARED_WORD_LIMIT = 12;

function instructionWordRuns(markdown) {
  const words = markdown
    .replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .slice(SHARED_WORD_LIMIT - 1)
    .map((_, index) => words.slice(index, index + SHARED_WORD_LIMIT).join(' '));
}

function firstSharedInstructionRun(detailRuns, instruction) {
  const instructionRuns = new Set(instructionWordRuns(instruction));
  return detailRuns.find((run) => instructionRuns.has(run));
}

/** Entire body of a bridge file. */
const IMPORT_BODY = '@AGENTS.md\n';

// Historical records and frozen data. Rewriting these would falsify history or,
// for the migrations and the prompt-integrity snapshot, break the exact matching
// they perform against what an older version actually wrote.
const EXCLUDED_PREFIXES = [
  'docs/plans/',
  'data/',
  'lib/slashdo/',
  'scripts/migrations/',
  'server/services/taskPromptDefaults/integrity.snapshot.json',
];

// The modules whose JOB is to know both names — the discovery walker, its tests
// (whose fixtures are literal `CLAUDE.md` files), the shared filename constants,
// and this test. Everywhere else, a bare `CLAUDE.md` must be paired with
// `AGENTS.md` on the same line.
const DUAL_NAME_IMPLEMENTATION = [
  'server/services/agent/agentPromptBuilder.test.js',
  'server/services/promptSections/instructions.js',
  'server/lib/agent/agentInstructionsFile.js',
  'server/lib/agent/agentInstructionsFile.test.js',
  GUARD_PATH,
];

/**
 * `git cat-file --batch` (or `--batch-check`) over `specs` in one process: a Map
 * from each spec to its object's content (or its `<sha> <type> <size>` header),
 * or null when git reports it missing. One spawn instead of one per file.
 */
const catFileBatch = (specs, { check = false } = {}) => {
  const out = execFileSync('git', ['cat-file', check ? '--batch-check' : '--batch'], {
    cwd: REPO_ROOT, input: specs.map((spec) => `${spec}\n`).join(''), maxBuffer: 64 * 1024 * 1024,
  });
  const found = new Map();
  let at = 0;
  for (const spec of specs) {
    const eol = out.indexOf(10, at);
    const header = out.toString('utf8', at, eol);
    at = eol + 1;
    if (header.endsWith(' missing')) { found.set(spec, null); continue; }
    if (check) { found.set(spec, header); continue; }
    const size = Number(header.split(' ')[2]);
    found.set(spec, out.toString('utf8', at, at + size));
    at += size + 1;
  }
  return found;
};

// One tree grep serves the scan and its self-check below.
let claudeMentions;
const claudeMentionLines = () => (claudeMentions ??= git('grep', '-n', '--fixed-strings', 'CLAUDE.md', '--', '.').split('\n').filter(Boolean));

describe('agent-instructions files (#4852)', () => {
  it('every location has a real AGENTS.md and a real CLAUDE.md holding only the import', () => {
    for (const dir of INSTRUCTION_DIRS) {
      const agentsPath = join(REPO_ROOT, dir, 'AGENTS.md');
      const bridgePath = join(REPO_ROOT, dir, 'CLAUDE.md');

      expect(lstatSync(agentsPath).isFile(), `${dir}/AGENTS.md must be a regular file`).toBe(true);
      expect(lstatSync(bridgePath).isFile(), `${dir}/CLAUDE.md must be a regular file`).toBe(true);
      expect(readText(agentsPath).trim().length, `${dir}/AGENTS.md must carry content`).toBeGreaterThan(0);
      expect(readText(bridgePath), `${dir}/CLAUDE.md must be exactly the @AGENTS.md import`).toBe(IMPORT_BODY);
    }
  });

  it('keeps the rule detail free of repeated 12-word runs', () => {
    const detailFile = 'docs/INSTRUCTION_RULE_DETAIL.md';
    const detailRuns = instructionWordRuns(readText(join(REPO_ROOT, detailFile)));
    for (const dir of INSTRUCTION_DIRS) {
      const agentsFile = join(dir, 'AGENTS.md');
      const sharedRun = firstSharedInstructionRun(detailRuns, readText(join(REPO_ROOT, agentsFile)));
      expect(sharedRun, `${detailFile} repeats ${agentsFile}: "${sharedRun}"`).toBeUndefined();
    }
  });

  it('detects a 12-word copy across markdown formatting and allows an 11-word copy', () => {
    const detailRuns = instructionWordRuns('One **two** [three](example.md) four, five six\nseven eight nine ten eleven twelve.');
    const elevenWords = 'one two three four five six seven eight nine ten eleven';
    expect(firstSharedInstructionRun(detailRuns, `${elevenWords} twelve`)).toBe(`${elevenWords} twelve`);
    expect(firstSharedInstructionRun(detailRuns, `${elevenWords} different`)).toBeUndefined();
  });

  describe('byte budget policy', () => {
    const limit = NESTED_MAX_BYTES;
    const at = (fraction) => Math.floor(limit * fraction);
    const verdict = (baseFraction, headFraction) =>
      instructionFileViolations([{ file: 'x/AGENTS.md', size: at(headFraction), baseSize: at(baseFraction), limit }]);

    it('lets a file below 90% at the base grow past 90%', () => {
      expect(verdict(0.89, 0.93)).toEqual([]);
    });
    it('refuses growth of a file already above 90% at the base', () => {
      expect(verdict(0.93, 0.94)).toHaveLength(1);
    });
    it('lets a file above 90% at the base shrink', () => {
      expect(verdict(0.93, 0.92)).toEqual([]);
    });
    it('fails anything above the ceiling regardless of base', () => {
      expect(verdict(0.5, 1.01)).toHaveLength(1);
      expect(verdict(1.0, 1.01)).toHaveLength(1);
    });
    it('treats a file new at the base as starting from zero', () => {
      expect(instructionFileViolations([{ file: 'n/AGENTS.md', size: at(0.95), baseSize: 0, limit }])).toEqual([]);
    });
  });

  it('fails closed when the base commit cannot be resolved', () => {
    expect(() => resolveImportGrowthBase({ repoRoot: REPO_ROOT, env: { CI_BASE_SHA: '0'.repeat(40) } })).toThrow(/CI_BASE_SHA/);
  });

  it('no AGENTS.md exceeds its ceiling or grows while above 90% of it at the merge base', () => {
    const tracked = AGENT_FILES;
    expect(tracked, 'detector self-check: root AGENTS.md must be tracked').toContain('AGENTS.md');

    // A missing base fails closed, exactly like the import-growth guard, whose
    // base resolution (CI_BASE_SHA, HEAD^1 on Actions, else merge-base with the
    // remote default branch) this reuses. Release-bound runs aggregate a whole
    // cycle of already-gated changes, so they share its skip.
    const skipped = importGrowthSkipReason();
    const baseSha = skipped ? null : resolveImportGrowthBase({ repoRoot: REPO_ROOT }).sha;

    const baseHeaders = baseSha ? catFileBatch(tracked.map((file) => `${baseSha}:${file}`), { check: true }) : new Map();
    const baseSizeOf = (file) => {
      const header = baseHeaders.get(`${baseSha}:${file}`);
      return header ? Number(header.split(' ')[2]) : 0;
    };

    const entries = tracked.map((file) => ({
      file,
      size: statSync(join(REPO_ROOT, file)).size,
      baseSize: baseSizeOf(file),
      limit: file === 'AGENTS.md' ? ROOT_MAX_BYTES : NESTED_MAX_BYTES,
    }));
    expect(instructionFileViolations(entries)).toEqual([]);
  });

  it('no tracked AGENTS.md or CLAUDE.md is a symlink', () => {
    // Mode 120000 is git's symlink mode. It survives a Unix checkout and
    // silently degrades to junk text on a Windows runner, so the ban is on the
    // index entry rather than on what happens to be on this machine's disk.
    const symlinks = guardCorpus().indexed(['*AGENTS.md', '*CLAUDE.md'])
      .filter(({ mode }) => mode === '120000')
      .map(({ path }) => path);

    expect(symlinks).toEqual([]);
  });

  it('no tracked file names CLAUDE.md as the canonical instructions file', () => {
    const hits = claudeMentionLines()
      .map((line) => {
        const firstColon = line.indexOf(':');
        const secondColon = line.indexOf(':', firstColon + 1);
        return { file: line.slice(0, firstColon), line: line.slice(0, secondColon), text: line.slice(secondColon + 1) };
      })
      .filter(({ file }) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
      .filter(({ file }) => !DUAL_NAME_IMPLEMENTATION.includes(file))
      // `~/.claude/CLAUDE.md` (and `.claude/CLAUDE.md`) is Claude Code's OWN
      // user-level memory location, not a repo convention — it keeps its name.
      .filter(({ text }) => !text.includes('.claude/CLAUDE.md'))
      // Dual naming is the accepted form: an agent told to read
      // "AGENTS.md (or CLAUDE.md)" still finds a managed app that has either.
      .filter(({ text }) => !text.includes('AGENTS.md'));

    expect(hits.map((h) => h.line)).toEqual([]);
  });

  it('every tracked .claude/ symlink resolves to an existing file (#11855)', () => {
    // Git symlinks (mode 120000) under .claude/ point into lib/slashdo, which
    // upstream renames or removes. A dangling one fails any tool that enumerates
    // tracked markdown with ENOENT. Targets inside lib/slashdo are skipped when
    // the submodule is not checked out, because CI only initializes it on demand.
    const submoduleReady = existsSync(join(REPO_ROOT, 'lib/slashdo/package.json'));
    const links = guardCorpus().indexed(['.claude'])
      .filter(({ mode }) => mode === '120000')
      .map(({ path }) => path);

    expect(links.length, 'detector self-check: .claude/ must track symlinks').toBeGreaterThan(0);

    // The blob content IS the link target; a Windows checkout without symlink
    // support materializes a text file, so the disk entry can't be trusted.
    const targets = catFileBatch(links.map((link) => `:${link}`));
    const dangling = links.filter((link) => {
      const target = targets.get(`:${link}`);
      if (!submoduleReady && target.includes('lib/slashdo/')) return false;
      return !existsSync(resolve(dirname(join(REPO_ROOT, link)), target));
    });

    expect(dangling).toEqual([]);
  });

  it('the scan actually reads tracked files (detector self-check)', () => {
    // Non-vacuous guard: if the pathspec or the exclusions ever widened to
    // everything, the assertion above would pass by scanning nothing.
    const scanned = [...new Set(claudeMentionLines().filter((line) => line.includes(':')).map((line) => line.slice(0, line.indexOf(':'))))]
      .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)));

    expect(scanned).toContain('AGENTS.md');
    expect(scanned).toContain('server/services/promptSections/instructions.js');
  });
});

const API_DOC = readDoc('docs/API.md');
const CATALOG = getApiRouteCatalog();

const PROBE_HEADING = '## Federated peer-probe contract';
const INDEX_HEADING = '## Route Domain Index';
const EVENTS_HEADING = '## WebSocket Events';

const section = (from, to) => {
  const start = API_DOC.indexOf(from);
  const end = API_DOC.indexOf(to);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`API.md must keep the "${from}" section ahead of "${to}" — this guard slices on those headings`);
  }
  return API_DOC.slice(start, end);
};

/**
 * Route params compare by position, not by name: `/markers/:id` and
 * `/markers/:rsid` are the same operation, and renaming a param is not a
 * change any caller can observe. Query strings are documentation, not path.
 */
const normalizePath = (path) => path
  .replace(/[?#].*$/, '')
  .replace(/:[A-Za-z0-9_]+/g, ':param')
  .replace(/\/+$/, '') || '/';

/** Endpoint cells are written relative to `/api` unless they name the mount themselves. */
const absolutePath = (path) => (path.startsWith('/api/') || path.startsWith('/sdapi/') ? path : `/api${path}`);

const isApiPath = (path) => path.startsWith('/api/') || path.startsWith('/sdapi/');

/** `| METHOD | \`/path\` | ... |` rows of the peer-probe contract table. */
const documentedOperations = [...section(PROBE_HEADING, INDEX_HEADING).matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/gm)]
  .map(([, method, path]) => ({ method, path: absolutePath(path) }));

/** Every backticked prefix in the route-domain index table, `/api/*` and `/sdapi/*` only. */
const indexedPrefixes = [...section(INDEX_HEADING, EVENTS_HEADING).matchAll(/^\|\s*((?:`[^`]+`(?:,\s*)?)+)\s*\|/gm)]
  .flatMap(([, cell]) => [...cell.matchAll(/`([^`]+)`/g)].map(([, prefix]) => prefix))
  .filter(isApiPath);

const liveOperations = new Set(CATALOG.routes.map(({ method, path }) => `${method} ${normalizePath(path)}`));
const livePaths = CATALOG.routes.map(({ path }) => normalizePath(path));

const isUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

describe('docs/API.md matches the mounted route graph', () => {
  it('parses the tables it guards', () => {
    // A regex that silently matches nothing would pass every assertion below.
    expect(documentedOperations).toHaveLength(3);
    expect(indexedPrefixes.length).toBeGreaterThan(50);
    expect(CATALOG.routes.length).toBeGreaterThan(500);
  });

  it('documents no peer-probe endpoint the server does not mount', () => {
    const phantom = documentedOperations
      .filter(({ method, path }) => !liveOperations.has(`${method} ${normalizePath(path)}`))
      .map(({ method, path }) => `${method} ${path}`);
    expect(phantom, [
      'docs/API.md documents peer-probe endpoints no router declares. Fix the row or delete it —',
      'the live inventory is GET /api/api-docs/catalog.json (or buildApiRouteCatalog()).',
    ].join('\n')).toEqual([]);
  });

  it('indexes no route-domain prefix that has no live operation under it', () => {
    const phantom = indexedPrefixes.filter((prefix) => {
      const wanted = normalizePath(prefix);
      return !livePaths.some((path) => isUnder(path, wanted));
    });
    expect(phantom, 'docs/API.md route-domain index lists prefixes the server no longer mounts').toEqual([]);
  });

  it('indexes every mounted API prefix', () => {
    const indexed = indexedPrefixes.map(normalizePath);
    const uncovered = CATALOG.mounts
      .filter(isApiPath)
      .filter((mount) => {
        const wanted = normalizePath(mount);
        return !indexed.some((prefix) => isUnder(prefix, wanted));
      });
    expect(uncovered, 'server/index.js mounts API prefixes the route-domain index never lists — add an index row').toEqual([]);
  });

  it('documents the status-to-code vocabulary the error envelope actually emits', () => {
    // The table is a published contract (`apiToolResource.js` advertises the same
    // map). A code listed here that no route emits — `COMMAND_NOT_ALLOWED` was one;
    // a disallowed command answers 403 `FORBIDDEN` — sends a client branching on
    // a value it can never receive.
    const documented = Object.fromEntries(
      [...API_DOC.slice(API_DOC.indexOf('## Error Responses'))
        .matchAll(/^\|\s*(\d{3})\s*\|\s*`([A-Z_]+)`/gm)]
        .map(([, status, code]) => [status, code]),
    );
    expect(documented).toEqual(ERROR_CODES_BY_STATUS);
  });
});

describe('auth-exempt path documentation', () => {
  it('AGENTS.md Auth bullet names every always-public path and its source file', () => {
    const bullet = readDoc('AGENTS.md')
      .split('\n')
      .find((line) => line.startsWith('- **Auth**'));
    expect(bullet).toBeDefined();
    expect(bullet).toContain('server/lib/apiAccessPolicy.js');
    for (const path of ALWAYS_PUBLIC_API_PATHS) expect(bullet).toContain(`\`${path}\``);
  });

  it('no tracked file cites the retired bare PUBLIC_API_PATHS identifier', () => {
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        ['grep', '-nw', 'PUBLIC_API_PATHS', '--', `:!${GUARD_PATH}`],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      if (err.status !== 1) throw err; // 1 = no matches
    }
    expect(hits).toBe('');
  });
});

const DEPS_DOC = readDoc('docs/DEPS.md');
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const WORKSPACES = discoverWorkspaces();
const DECLARED = new Set();
for (const workspace of WORKSPACES) {
  const pkg = JSON.parse(readText(join(workspaceDir(workspace), 'package.json')));
  for (const group of GROUPS) {
    for (const name of Object.keys(pkg[group] ?? {})) {
      DECLARED.add(`${workspace} ${group}: ${name}`);
    }
  }
}

function quickReferenceRows(markdown) {
  const section = markdown.split('## Quick Reference Table\n')[1]?.split('\n## ')[0] ?? '';
  const rows = [];
  let scope = '';
  for (const line of section.split('\n')) {
    const [, cell] = line.split('|').map(part => part.trim());
    const heading = /^\*\*(\S+) (\w+)\*\*$/.exec(cell ?? '');
    if (heading) scope = `${heading[1].toLowerCase()} ${heading[2]}`;
    const name = /`([^`]+)`/.exec(cell ?? '')?.[1];
    if (name) rows.push(`${scope}: ${name}`);
  }
  return rows;
}

describe('docs/DEPS.md', () => {
  const documented = quickReferenceRows(DEPS_DOC);

  it('documents every direct dependency under the workspace and manifest group that declares it', () => {
    expect([...DECLARED].filter(entry => !documented.includes(entry))).toEqual([]);
  });

  it('requires deletion of rows for removed declarations and rejects duplicates', () => {
    expect(documented.filter(entry => !DECLARED.has(entry))).toEqual([]);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('includes the install workspaces and their current declarations as dependencies are retired', () => {
    expect(WORKSPACES).toEqual(expect.arrayContaining(['root', 'client', 'server', 'browser']));
    expect(DECLARED.size).toBeGreaterThan(0);
    expect(documented.length).toBe(DECLARED.size);
  });

  it('counts rows in the right scope regardless of verdict', () => {
    const sample = [
      '## Quick Reference Table',
      '| **Client dependencies** | | | | |',
      '| `legacy` | 1 | REPLACED | | |',
      '| `old` | 2 | REMOVED (direct) | | |',
      '| `current` | 1 | KEEP | | |',
      '| **Server devDependencies** | | | | |',
      '| `current` | 1 | KEEP | | |',
    ].join('\n');
    expect(quickReferenceRows(sample)).toEqual([
      'client dependencies: legacy',
      'client dependencies: old',
      'client dependencies: current',
      'server devDependencies: current',
    ]);
  });
});

const MODULE_GUIDES = [
  'server/lib/README.md', 'client/src/lib/README.md', 'client/src/hooks/README.md',
];

// Guards "`symbol` in `path`" pointers in the instruction and catalog docs
// agents load before editing (#11852). A rename or extraction leaves the
// pointer naming a symbol that no longer lives at the cited path, and nothing
// else notices. Prose docs stay out of scope: they use relative shorthand that
// would false-positive.

const CODE_POINTER_DOCS = new Set([
  ...AGENT_FILES,
  '.claude/skills/portos-add-module/SKILL.md',
  '.claude/skills/portos-ship/SKILL.md',
  'server/services/README.md',
  ...MODULE_GUIDES,
]);

const POINTER = /`([A-Za-z_$][\w$]*)(?:\([^`)]*\))?`\s+(?:in|from|at)\s+`([^`\s]+\.jsx?)`/g;

// Root, the doc's own directory, then the two source roots for shorthand paths.
const resolvePointerPath = (docFile, pointerPath) => {
  const bases = ['', dirname(docFile), 'server', 'client/src'];
  return bases.map((b) => join(REPO_ROOT, b, pointerPath)).find((p) => existsSync(p)) ?? null;
};

const findBrokenPointers = (docFile, text) => {
  const broken = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(POINTER)) {
      const [, ident, path] = m;
      const resolved = resolvePointerPath(docFile, path);
      if (!resolved) broken.push(`${docFile}:${i + 1} \`${ident}\` -> ${path} (file not found)`);
      else if (!new RegExp(`(?<![\\w$])${ident.replace(/\$/g, '\\$')}(?![\\w$])`).test(readText(resolved))) {
        broken.push(`${docFile}:${i + 1} \`${ident}\` not found in ${path}`);
      }
    }
  });
  return broken;
};

describe('doc code pointers', () => {
  it('every "`symbol` in `path`" pointer resolves', () => {
    expect(documentationFindings().brokenPointers).toEqual([]);
  });

  it('reports a stale pointer with file:line', () => {
    const stale = 'See `issueWriteTail` in `server/services/pipeline/issues.js`.';
    expect(findBrokenPointers('server/AGENTS.md', `x\n${stale}`)).toEqual([
      'server/AGENTS.md:2 `issueWriteTail` not found in server/services/pipeline/issues.js',
    ]);
  });
});

/** Records that name an endpoint which does not (or does not yet) exist, on purpose. */
const DELIBERATE_NON_ROUTES = [
  { file: 'docs/features/eidoverse-guest-travel.md', method: 'GET', path: '/api/eidoverse/world/contributions', reason: 'recorded as a removed endpoint' },
  { file: 'docs/features/chief-of-staff.md', method: 'POST', path: '/api/cos/merge-admission/external', reason: 'recorded as a removed endpoint (#14320)' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'POST', path: '/api/openclaw/sessions', reason: 'proposed but not built' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'GET', path: '/api/openclaw/jobs', reason: 'proposed but not built' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'GET', path: '/api/openclaw/subagents', reason: 'proposed but not built' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'POST', path: '/api/openclaw/context/compose', reason: 'proposed but not built' },
];

const MENTION = /(?<![\w/])(GET|POST|PUT|PATCH|DELETE)(\s*\/\s*(?:GET|POST|PUT|PATCH|DELETE))*\s+`?(\/api\/[^\s`<>]+)/g;

const PLACEHOLDER = /[*{}[\]]/;

const findMentions = (file, text) => {
  const mentions = [];
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(MENTION)) {
      const path = match[3].replace(/[).,;:\]]+$/, '');
      if (match[2] || PLACEHOLDER.test(path)) continue;
      mentions.push({ file, line: i + 1, method: match[1], path });
    }
  });
  return mentions;
};

const isRoutable = ({ method, path }) => liveOperations.has(`${method} ${normalizePath(path)}`);

const isAllowed = (m) => DELIBERATE_NON_ROUTES.some((a) => a.file === m.file && a.method === m.method && a.path === m.path);

describe('endpoint mentions in docs name a route the server mounts', () => {
  const mentions = () => documentationFindings().mentions;
  it('parses a meaningful number of mentions', () => {
    // A regex that silently matches nothing would pass every assertion below.
    expect(mentions().length).toBeGreaterThan(50);
    expect(CATALOG.routes.length).toBeGreaterThan(500);
  });

  it('names no method/path pair that no router declares', () => {
    const drift = mentions()
      .filter((m) => !isRoutable(m) && !isAllowed(m))
      .map((m) => `${m.file}:${m.line} ${m.method} ${m.path}`);
    expect(drift, [
      'These docs name a method/path no router declares. Fix the mention, or — if the doc deliberately',
      'records a removed/proposed endpoint — add it to DELIBERATE_NON_ROUTES with a reason.',
      'The live inventory is GET /api/api-docs/catalog.json (or buildApiRouteCatalog()).',
    ].join('\n')).toEqual([]);
  });

  it('keeps every allowlist entry honest', () => {
    const stale = DELIBERATE_NON_ROUTES.flatMap((a) => {
      if (!a.reason) return [`${a.file} ${a.method} ${a.path}: missing reason`];
      if (isRoutable(a)) return [`${a.file} ${a.method} ${a.path}: now routable — drop the entry`];
      if (!mentions().some((m) => isAllowed(m) && m.file === a.file && m.method === a.method && m.path === a.path)) {
        return [`${a.file} ${a.method} ${a.path}: mention no longer present — drop the entry`];
      }
      return [];
    });
    expect(stale).toEqual([]);
  });

  it('skips slash shorthand and brace/glob placeholders', () => {
    const text = 'x `GET/PUT/DELETE /api/foo` y `GET /api/foo/{id}` z `POST /api/foo/*` `PATCH /api/foo/bar`';
    expect(findMentions('f.md', text)).toEqual([{ file: 'f.md', line: 1, method: 'PATCH', path: '/api/foo/bar' }]);
  });

  it('reports a wrong verb with file:line', () => {
    const line = 'writes through `PATCH /api/cos/config` only';
    const [m] = findMentions('docs/features/chief-of-staff.md', `a\n${line}`);
    expect(m).toMatchObject({ file: 'docs/features/chief-of-staff.md', line: 2, method: 'PATCH', path: '/api/cos/config' });
    expect(isRoutable(m)).toBe(false);
    expect(isRoutable({ method: 'PUT', path: '/api/cos/config' })).toBe(true);
  });
});

const MAX_DOC_BYTES = 40 * 1024;
const RATCHET_SLACK_BYTES = 2 * 1024;

// Grandfathered byte ceilings for living docs that currently exceed 40 KB.
// Each ceiling must stay within 2 KB of the file's actual size so shrinking
// a doc forces its entry down or out.
const SIZE_RATCHET_CEILINGS = {
  'BACKUP.md': 48200,
  'BACKUP_PUBLICATION_ADMISSION.md': 41800,
  'HTML_COMPOSITIONS.md': 67233,
  'TROUBLESHOOTING.md': 46000,
  'FEDERATED_MEDIA_PROVIDERS.md': 45625,
  'QUOTA-BURN.md': 44909,
};

describe('docs/README.md index coverage', () => {
  it('discovers the living docs it guards', () => {
    expect(LIVING_DOCS).toContain('docs/JEV_SETUP.md');
    expect(LIVING_DOCS).toContain('docs/features/tailcat-peers.md');
  });

  it('links every living document by its relative path', () => {
    expect(LIVING_DOCS.filter((doc) => !DOC_INDEX_LINKS.has(doc)), 'add these docs to docs/README.md').toEqual([]);
  });

  it('resolves only repository-relative markdown links and ignores fragments and external links', () => {
    const text = '[Guide](./GUIDE.md#section) [Local](../AGENTS.md) [Jump](#section) [External](https://example.com/file.md)';
    expect([...linkedMarkdownPaths('docs/README.md', text)]).toEqual(['docs/GUIDE.md', 'AGENTS.md']);
  });
});

describe('living doc size ratchet', () => {
  it('only lists existing living docs above 40 KB', () => {
    for (const [doc, ceiling] of Object.entries(SIZE_RATCHET_CEILINGS)) {
      expect(LIVING_DOCS, `${doc} is not a living doc`).toContain(`docs/${doc}`);
      expect(ceiling, `${doc} ceiling should be > ${MAX_DOC_BYTES}`).toBeGreaterThan(MAX_DOC_BYTES);
    }
  });

  it('keeps every living doc within its byte ceiling', () => {
    const violations = [];
    for (const file of LIVING_DOCS) {
      const doc = file.slice('docs/'.length);
      const size = statSync(join(REPO_ROOT, file)).size;
      const ceiling = SIZE_RATCHET_CEILINGS[doc] ?? MAX_DOC_BYTES;
      if (size > ceiling) violations.push(`${file}: ${size} B exceeds ${ceiling} B; split by topic`);
      if (doc in SIZE_RATCHET_CEILINGS && ceiling - size > RATCHET_SLACK_BYTES) {
        violations.push(`${file}: shrank to ${size} B; lower or remove the ${ceiling} B ceiling`);
      }
    }
    expect(violations).toEqual([]);
  });
});

const SURFACE_DOC = readDoc('docs/features/product-surfaces.md');

const SECTION_HEADING = '## 6. Communications, Voice, Social, & Spatial UI';

// Pre-existing gaps this change did not introduce — see the file comment above.
const KNOWN_UNRELATED_GAPS = new Set([
  '/messages/config',
  '/messages/imessage?settings=1',
]);

/**
 * Every backticked path in the Route(s) column of the Comms/messaging section's
 * table rows. Scoped to that one section (between its heading and the next
 * `## `) rather than the whole document, so a path documented somewhere else
 * entirely (a Settings or Digital Twin row reusing similar wording) can't be
 * mistaken for coverage here.
 */
function commsSectionDocumentedPaths() {
  const start = SURFACE_DOC.indexOf(SECTION_HEADING);
  const afterHeading = SURFACE_DOC.slice(start + SECTION_HEADING.length);
  const end = afterHeading.indexOf('\n## ');
  const section = end === -1 ? afterHeading : afterHeading.slice(0, end);
  const paths = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const routeCell = line.split('|')[2] ?? '';
    for (const match of routeCell.matchAll(/`([^`]+)`/g)) {
      paths.add(match[1]);
    }
  }
  return paths;
}

describe('docs/features/product-surfaces.md — Comms route inventory', () => {
  it('documents every Comms nav-manifest path not already tracked as a pre-existing gap', () => {
    const documented = commsSectionDocumentedPaths();
    const commsPaths = NAV_COMMANDS
      .filter((command) => command.section === 'Comms')
      .map((command) => command.path)
      .filter((path) => !KNOWN_UNRELATED_GAPS.has(path));

    const missing = commsPaths.filter((path) => !documented.has(path));
    expect(missing).toEqual([]);
  });

  it('scans a non-empty set of manifest paths and documented routes (detector self-check)', () => {
    expect(NAV_COMMANDS.filter((command) => command.section === 'Comms').length).toBeGreaterThan(0);
    expect(commsSectionDocumentedPaths().size).toBeGreaterThan(0);
  });
});

const FILE_TOKEN = /^(?:\.\/|~\/|<repo-root>\/)?([\w.][\w./-]*\.(?:jsx?|[cm]js|md|json|ya?ml))$/;
/** Example names the prose uses as stand-ins (`foo.js:412`), never real files. */
const PLACEHOLDER_STEM = /^(?:foo|bar|baz|qux|x|y|example)$/;

/**
 * Backticked file names in `text`, each with the line it sits on. A token is
 * taken up to the first `:` or `#` (`file.js:412`, `routes/x.js#schema`);
 * placeholders, globs, and example stems (`<x>`, `*`, `{…}`, `foo.js`) are
 * not file names.
 */
const extractFileTokens = (text) => {
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

/** Find untracked runtime basenames in one grep of the tracked source. */
function sourceMentions(names) {
  if (!names.length) return new Set();
  let matches;
  try {
    matches = git('grep', '-hF', ...names.flatMap((name) => ['-e', name]),
      '--', '*.js', '*.cjs', '*.mjs', ':!*.test.js', ':!*.md');
  } catch (error) {
    if (error.status === 1) return new Set();
    throw error;
  }
  return new Set(names.filter((name) => matches.includes(name)));
}

function findStaleReferences({ files, tracked, mentions }) {
  const tokens = files.flatMap((file) => extractFileTokens(readDoc(file))
    .map(({ line, path }) => ({ file, line, path, name: basename(path) })))
    .filter(({ name }) => !tracked.has(name));
  const names = [...new Set(tokens.map(({ name }) => name))];
  const mentioned = mentions ? new Set(names.filter(mentions)) : sourceMentions(names);
  return tokens.filter(({ name }) => !mentioned.has(name)).map(({ file, line, path }) =>
    `${file}:${line} \`${path}\` (no tracked file has this basename and no tracked source names it)`);
}

/**
 * Links in `text` whose label names one or more `.md` files, none of which
 * is the target's basename. Anchor-only targets (`#section`) are skipped.
 */
const findMislabelledLinks = (text) => {
  const bad = [];
  text.split('\n').forEach((line, i) => {
    for (const [, label, target] of line.matchAll(MD_LINK)) {
      const named = [...label.replace(/`/g, '').matchAll(/([\w.-]+\.md)\b/g)].map((m) => m[1].toLowerCase());
      const path = target.split(/[#?]/)[0];
      if (!named.length || !path) continue;
      if (!named.includes(basename(path).toLowerCase())) bad.push({ line: i + 1, label, target });
    }
  });
  return bad;
};

const LONG_SENTENCE = 120;

/** Sentences over LONG_SENTENCE characters, list markers stripped. */
const longSentences = (text) => text.split('\n')
  .flatMap((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').split(/(?<=[.!?])\s+/))
  .map((s) => s.trim())
  .filter((s) => s.length > LONG_SENTENCE);

const sharedLongSentences = (a, b) => {
  const inA = new Set(longSentences(a));
  return longSentences(b).filter((s) => inA.has(s));
};

describe('instruction file references', () => {
  const files = AGENT_FILES;
  const tracked = new Set(TRACKED.map((path) => basename(path)));

  it('scans every tracked AGENTS.md', () => {
    expect(files).toContain('AGENTS.md');
    expect(files).toContain('server/AGENTS.md');
    expect(files).toContain('client/src/AGENTS.md');
  });

  it('every backticked file name in an AGENTS.md matches a tracked file', () => {
    expect(findStaleReferences({ files, tracked })).toEqual([]);
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

  it('reports a stale name with file:line, and a source mention clears it', () => {
    const noSource = findStaleReferences({ files: ['server/AGENTS.md'], tracked: new Set(), mentions: () => false });
    expect(noSource.length).toBeGreaterThan(0);
    expect(noSource.every((s) => /^server\/AGENTS\.md:\d+ `[^`]+` \(no tracked file has this basename and no tracked source names it\)$/.test(s))).toBe(true);
    expect(noSource.some((s) => s.includes('`server/lib/pgJson.js`'))).toBe(true);
    expect(findStaleReferences({ files: ['server/AGENTS.md'], tracked: new Set(), mentions: () => true })).toEqual([]);
  });

  it('checks filename labels in README-linked markdown and AGENTS.md', () => {
    expect(documentationFindings().mislabelledLinks).toEqual([]);
  });

  it('flags a label naming a different .md file than the target', () => {
    const text = [
      'See [docs/CONTRIBUTING.md](docs/INSTRUCTION_RULE_DETAIL.md#agent-instruction-files).',
      'Fine: [VERSIONING.md](./VERSIONING.md#regular-development), [detail](docs/X.md), [`server/AGENTS.md`](server/AGENTS.md), [ETHOS.md](#ethos).',
    ].join('\n');
    expect(findMislabelledLinks(text)).toEqual([
      { line: 1, label: 'docs/CONTRIBUTING.md', target: 'docs/INSTRUCTION_RULE_DETAIL.md#agent-instruction-files' },
    ]);
  });

  it('the rule-detail doc restates no long root sentence verbatim', () => {
    const root = readDoc('AGENTS.md');
    const detail = readDoc('docs/INSTRUCTION_RULE_DETAIL.md');
    expect(sharedLongSentences(root, detail)).toEqual([]);
    const restated = 'Every reusable-code directory is cataloged from module headers, and this sentence is long enough to count as a rule restatement.';
    expect(sharedLongSentences(`- ${restated} Short.`, `Intro. ${restated}`)).toEqual([restated]);
  });
});

const ENDPOINT_DOCS = new Set([
  ...LIVING_DOCS.filter((file) => DOC_INDEX_LINKS.has(file)), ...AGENT_FILES, ...MODULE_GUIDES,
  'client/src/utils/README.md', 'client/src/services/README.md',
]);
// The README indexes define the supported documentation surface for link labels.
const LINK_LABEL_DOCS = new Set([...INDEXED_DOCS, ...AGENT_FILES]);

let findings;
function documentationFindings() {
  if (findings) return findings;
  const mentions = [];
  const brokenPointers = [];
  const mislabelledLinks = [];
  for (const file of new Set([...ENDPOINT_DOCS, ...CODE_POINTER_DOCS, ...LINK_LABEL_DOCS])) {
    const path = join(REPO_ROOT, file);
    if (!TRACKED_SET.has(file) || !lstatSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    const text = readDoc(file);
    if (ENDPOINT_DOCS.has(file)) mentions.push(...findMentions(file, text));
    if (CODE_POINTER_DOCS.has(file)) brokenPointers.push(...findBrokenPointers(file, text));
    if (LINK_LABEL_DOCS.has(file)) {
      for (const { line, label, target } of findMislabelledLinks(text)) {
        mislabelledLinks.push(`${file}:${line} [${label}](${target})`);
      }
    }
  }
  findings = { mentions, brokenPointers, mislabelledLinks };
  return findings;
}
