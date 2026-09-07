/**
 * Tree-wide guard on the two `glab` flag traps.
 *
 * Both cost real user-visible time before this existed, and both are invisible
 * in review because the wrong spelling LOOKS like the right one:
 *
 *   1. `-F json` on `glab issue list`. `-F` is not one flag across subcommands:
 *      on `mr list` / `mr view` / `issue view` / `repo view` / `label list` it is
 *      the shorthand for `--output` (text|json), but on `issue list` it is
 *      `--output-format` (details|ids|urls) while `--output` carries `-O`. So
 *      `glab issue list -F json` is accepted, IGNORED, and answers with the
 *      human table at exit 0 — parsed as "couldn't fetch", which is how the app
 *      Issues tab told a user with a working, authenticated `glab` to
 *      authenticate it.
 *   2. `--state <x>` on `glab mr list`. That flag does not exist; state is
 *      selected by presence flags (`--merged`, `--closed`, `--all`) and defaults
 *      to open. It exited non-zero on every call, so the GitLab arm of the
 *      zombie-issue reconcile scan skipped every cycle in silence.
 *
 * Per-caller argv assertions cannot cover this: the offenders were spread over
 * five modules and three different CLI runners, and a NEW call site is exactly
 * when the guard needs to fire. So this walks the whole server tree rather than
 * listing known files — the same discover-don't-enumerate shape as
 * `spawnCwd.test.js` and `cliChildEnv.test.js`.
 */

import { describe, it, expect } from 'vitest';
import { collectServerSources, readServerSource } from '../lib/testHelper.js';

// `-F json` as CODE — an argv array element pair, either quote style. Prompt
// prose spells it `-F json` (space-separated inside a template literal), so this
// pattern is naturally scoped to real call sites.
const ARGV_SHORTHAND_JSON = /(['"])-F\1\s*,\s*(['"])json\2/;

// `glab issue list … -F json` as TEXT — the shell form handed to an agent in a
// prompt, on one line.
const PROSE_ISSUE_LIST_SHORTHAND = /glab\s+issue\s+ls?i?s?t?\b[^\n]*?(?:^|\s)-F\s+json/m;

// `glab mr list --state <x>`, in either code or prose.
const PROSE_MR_LIST_STATE = /glab\s+mr\s+ls?i?s?t?\b[^\n]*?--state\b/m;
const ARGV_MR_LIST_STATE = /(['"])mr\1\s*,\s*(['"])list\2[^\n]*?(['"])--state\3/;

/**
 * Drop ONLY whole JSDoc blocks, so `lib/glabArgs.js` — whose entire job is to
 * document these traps — doesn't read as an instance of them.
 *
 * Scoped this tightly on purpose. An earlier version also dropped every line
 * whose first non-whitespace was `//` or `*`, reasoning that those are comment
 * continuations. They are not, in this repo: `agentPromptBuilder.js` builds agent
 * prompts from multi-line template literals containing markdown instruction lines
 * that start with `**` (`**WARNING**: …`), and those are live prompt text sitting
 * in a scanned file. Stripping them meant a trap re-introduced in that style —
 * the single most likely place for it, since prompts are where the flags are
 * spelled as shell commands — would be deleted before the patterns ran and the
 * guard would pass. A stripper that has to GUESS which lines are prose fails
 * toward false negatives, which is the one direction a guard must never fail;
 * `^/**`-anchored block comments need no guessing. Pinned by the
 * template-literal cases in "guard is not vacuous" below.
 */
const stripCommentary = (src) => src.replace(/^[ \t]*\/\*\*[\s\S]*?\*\//gm, '');

const PATTERNS = [
  ['-F json argv pair', ARGV_SHORTHAND_JSON],
  ['glab issue list … -F json', PROSE_ISSUE_LIST_SHORTHAND],
  ['glab mr list --state', PROSE_MR_LIST_STATE],
  ['glab mr list --state argv', ARGV_MR_LIST_STATE],
];

// Nothing is exempt. `taskPromptDefaults/previousDefaults.js` used to be — the
// retired prompt bodies it held were frozen history that had to keep spelling
// the traps byte for byte — until #6480 replaced those bodies with their hashes
// in integrity.snapshot.json, so no file in the tree needs to spell them any
// more. `prompts.js` left the list earlier: a stored prompt default cannot be
// corrected by editing the string alone (each edit needs a PROMPT_VERSIONS bump
// so the outgoing body stays recognized), and issue #4685 did that migration.
// Prose in a prompt body that merely EXPLAINS a trap still reads as an instance
// of it — name the flag without re-spelling the subcommand ahead of it on the
// same line.

const offendingPatterns = (src) => {
  const code = stripCommentary(src);
  return PATTERNS.filter(([, re]) => re.test(code)).map(([name]) => name);
};

describe('glab flag traps are gone tree-wide', () => {
  it('no server source spells either trap', () => {
    const offenders = collectServerSources()
      .map((rel) => [rel, offendingPatterns(readServerSource(rel))])
      .filter(([, hits]) => hits.length > 0);

    expect(
      offenders,
      'ask glab for JSON with withGlabJson()/execGlabJson (lib/glabArgs.js), and select MR state with --merged/--closed/--all',
    ).toEqual([]);
  });

  it('sees a trap embedded in prompt-template prose (guard is not vacuous)', () => {
    // The regression that motivated the narrow stripper: these are the shapes a
    // re-introduced trap actually takes in this repo's prompt builders, and a
    // line-based comment stripper silently deleted every one of them.
    const promptish = [
      '  const prompt = `',
      '**Check for an existing MR**: `glab mr list --state opened -F json`',
      '`;',
    ].join('\n');
    expect(offendingPatterns(promptish).length).toBeGreaterThan(0);

    // A markdown bullet, an indented shell line, and a JS-comment-looking line —
    // all live prompt text inside a template literal, none of them comments.
    for (const line of [
      '- GitLab: `glab issue list --per-page 100 -F json`',
      '   glab issue list --per-page 100 -F json',
      '// then run: glab mr list --state opened',
      '* `glab issue list -F json` lists them',
    ]) {
      expect(offendingPatterns(`x = \`\n${line}\n\`;`).length, line).toBeGreaterThan(0);
    }
  });

  it('still ignores a JSDoc block that only documents the traps', () => {
    // lib/glabArgs.js must not report itself.
    const doc = [
      '/**',
      ' * `glab issue list -F json` is accepted, ignored, and returns the table.',
      ' * `glab mr list --state <x>` does not exist.',
      ' */',
      "export const GLAB_JSON_ARGS = Object.freeze(['--output', 'json']);",
    ].join('\n');
    expect(offendingPatterns(doc)).toEqual([]);
  });

  it('the walk actually reaches the glab call sites (guard is not vacuous)', () => {
    // A scan that silently collected nothing would also report zero offenders.
    const sources = collectServerSources();
    expect(sources).toContain('services/gitlab.js');
    expect(sources).toContain('services/appIssues.js');
    expect(sources).toContain('services/issueReconcile.js');
    expect(sources).toContain('services/perpetualWork.js');
    expect(sources).toContain('services/layeredIntelligence/forgeFiler.js');
  });
});
