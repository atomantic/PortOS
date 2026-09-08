/**
 * A retired shipped default, kept as a literal for the suites that need "a
 * stored prompt an older install is still holding" — the store self-heal and
 * version-inference tests, and the recognition contract in
 * taskPromptDefaults.test.js. Test-only: nothing at runtime imports this file.
 *
 * It is the pre-unification `[Self-Improvement]` console-errors body, chosen
 * because it also hardcodes the legacy `http://localhost:5555` API origin the
 * genericization retired, so one fixture covers both recognition cases: an
 * exact retired body, and a retired body whose embedded origin differs from the
 * install reading it (hashPromptBody normalizes both to one placeholder).
 *
 * Its md5 is pinned in integrity.snapshot.json under
 * PREVIOUS_DEFAULT_PROMPTS["console-errors"], which is what makes it recognized.
 * Edit a byte and promptMatchesShippedDefault stops matching it — that is the
 * recognition test failing, not a reason to touch the snapshot.
 *
 * As a real source file it is scanned by every tree-wide source guard (glab
 * flags, dispatch labels, agent-instruction filenames, …), so this body was
 * also chosen for spelling none of the things those guards ban.
 */
export const RETIRED_CONSOLE_ERRORS_PROMPT = `[Self-Improvement] Console Error Investigation

Use Playwright MCP to find and fix console errors:

1. Navigate to http://localhost:5555/
2. Call browser_console_messages with level: "error"
3. Visit each route and capture errors:
   - /, /apps, /cos, /cos/tasks, /cos/agents
   - /devtools, /devtools/history, /devtools/runner
   - /providers, /usage, /prompts

4. For each error:
   - Identify the source file and line
   - Understand the root cause
   - Implement a fix

5. Test fixes and commit changes`;
