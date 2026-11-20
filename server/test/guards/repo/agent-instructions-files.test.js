import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { lstatSync, existsSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { importGrowthSkipReason, resolveImportGrowthBase } from '../../../../scripts/lib/importGrowth.js';
import { guardCorpus, readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

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
const ROOT_MAX_BYTES = 28 * 1024;
const NESTED_MAX_BYTES = 12 * 1024;
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
export function instructionFileViolations(entries) {
  return entries.flatMap(({ file, size, baseSize, limit }) => {
    if (size > limit) return [`${file}: ${size} bytes > ${limit} byte ceiling; move procedure into a skill or doc`];
    const line = Math.floor(limit * HEADROOM_FRACTION);
    if (baseSize > line && size > baseSize) {
      return [`${file}: grew ${baseSize} -> ${size} bytes while already above 90% (${line}) of its ${limit} ceiling at the merge base; trim as much as you add`];
    }
    return [];
  });
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
  'server/test/guards/repo/agent-instructions-files.test.js',
];

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

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
    const tracked = guardCorpus().indexed(['AGENTS.md', '*/AGENTS.md']).map(({ path }) => path);
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
