import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, lstatSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every directory that carries the pair. Adding a nested one? Add it here. */
const INSTRUCTION_DIRS = [
  '.',
  'client/src',
  'client/src/components/dashboard',
  'server',
  'server/lib/aiToolkit',
];

/** Entire body of a bridge file. */
const IMPORT_BODY = '@AGENTS.md\n';

// Historical records and frozen data. Rewriting these would falsify history or,
// for the migrations and the prompt-integrity snapshot, break the exact matching
// they perform against what an older version actually wrote.
const EXCLUDED_PREFIXES = [
  '.changelog/',
  'docs/plans/',
  'docs/superpowers/',
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
  'server/services/agentPromptBuilder.test.js',
  'server/services/promptSections/instructions.js',
  'server/lib/agentInstructionsFile.js',
  'server/lib/agentInstructionsFile.test.js',
  'scripts/agent-instructions-files.test.js',
];

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

describe('agent-instructions files (#4852)', () => {
  it('every location has a real AGENTS.md and a real CLAUDE.md holding only the import', () => {
    for (const dir of INSTRUCTION_DIRS) {
      const agentsPath = join(REPO_ROOT, dir, 'AGENTS.md');
      const bridgePath = join(REPO_ROOT, dir, 'CLAUDE.md');

      expect(lstatSync(agentsPath).isFile(), `${dir}/AGENTS.md must be a regular file`).toBe(true);
      expect(lstatSync(bridgePath).isFile(), `${dir}/CLAUDE.md must be a regular file`).toBe(true);
      expect(readFileSync(agentsPath, 'utf8').trim().length, `${dir}/AGENTS.md must carry content`).toBeGreaterThan(0);
      expect(readFileSync(bridgePath, 'utf8'), `${dir}/CLAUDE.md must be exactly the @AGENTS.md import`).toBe(IMPORT_BODY);
    }
  });

  it('no tracked AGENTS.md or CLAUDE.md is a symlink', () => {
    // Mode 120000 is git's symlink mode. It survives a Unix checkout and
    // silently degrades to junk text on a Windows runner, so the ban is on the
    // index entry rather than on what happens to be on this machine's disk.
    const symlinks = git('ls-files', '-s', '--', '*AGENTS.md', '*CLAUDE.md')
      .split('\n')
      .filter((line) => line.startsWith('120000'));

    expect(symlinks).toEqual([]);
  });

  it('no tracked file names CLAUDE.md as the canonical instructions file', () => {
    const hits = git('grep', '-n', '--fixed-strings', 'CLAUDE.md', '--', '.')
      .split('\n')
      .filter(Boolean)
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

  it('the scan actually reads tracked files (detector self-check)', () => {
    // Non-vacuous guard: if the pathspec or the exclusions ever widened to
    // everything, the assertion above would pass by scanning nothing.
    const scanned = git('grep', '-l', '--fixed-strings', 'CLAUDE.md', '--', '.')
      .split('\n')
      .filter(Boolean)
      .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)));

    expect(scanned).toContain('AGENTS.md');
    expect(scanned).toContain('server/services/promptSections/instructions.js');
  });
});
