/**
 * Slashdo command/lib loading — inlines bundled slashdo markdown (submodule at
 * `lib/slashdo/`) into CoS-agent prompts WITHOUT running slashdo's own
 * per-environment installer, so this module resolves the same `!`cat``
 * include directives and `<!-- if:teams -->` conditionals that installer would
 * otherwise handle. Split out of `fileUtils.js` (a generic file-utilities
 * module) because this is one cohesive feature, not a generic file helper —
 * see `slashdoInvocation.js` for the sibling module covering invocation-style
 * resolution (how a workflow is TYPED per host CLI) rather than loading.
 */
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { atomicWrite, PATHS } from './fileUtils.js';

/**
 * The include name (`<name>` of `lib/<name>.md`) for a matched `!`cat`` directive,
 * with the `.md` extension dropped so callers name libs the way slashdo does
 * (`local-agent-review-loop`, not `local-agent-review-loop.md`).
 */
function slashdoIncludeName(relPath) {
  return relPath.replace(/^.*\//, '').replace(/\.md$/, '');
}

/**
 * Resolve all `!`cat ~/.claude/lib/<name>`` include directives in `content` by
 * inlining the referenced slashdo lib file. Iterates so an inlined lib that
 * itself carries a `!`cat`` include is resolved too (bounded to avoid a cyclic
 * include spinning forever). Shared by loadSlashdoFile and loadSlashdoLib.
 *
 * `skipInclude(name)` (optional) prunes an include the run can never reach —
 * see `loadSlashdoFile`'s `skipIncludes`. A skipped include is replaced with a
 * one-line "not applicable" note rather than deleted, so the agent sees that a
 * section was intentionally withheld instead of silently reading a procedure
 * with a hole in it and improvising the missing branch.
 */
async function resolveSlashdoIncludes(content, libDir, { skipInclude = null } = {}) {
  for (let pass = 0; pass < 5; pass++) {
    const matches = [...content.matchAll(/!`cat ~\/.claude\/lib\/([^`]+)`/g)];
    if (matches.length === 0) break;
    const replacements = await Promise.all(matches.map(async (match) => {
      const name = slashdoIncludeName(match[1]);
      if (skipInclude?.(name)) {
        return { pattern: match[0], content: `_(\`${name}\` omitted — not applicable to this run.)_` };
      }
      const libContent = await readFile(join(libDir, match[1]), 'utf-8').catch(() => null);
      return { pattern: match[0], content: libContent };
    }));
    let changed = false;
    for (const { pattern, content: libContent } of replacements) {
      // Replace via a function, NOT a string: a string replacement makes
      // String.replace interpret `$&`/`$\``/`$'`/`$n` tokens, and the shell-heavy
      // lib files are full of `$` — a bare-string replacement both corrupts the
      // inlined text and balloons it (a `$\`` token splices in everything before
      // the match, blowing a 66KB command up to ~2.5MB). A function replacer
      // inserts libContent verbatim.
      if (libContent) { content = content.replace(pattern, () => libContent); changed = true; }
    }
    if (!changed) break;
  }
  return content;
}

/**
 * Resolve slashdo's `<!-- if:<cap> -->…<!-- else -->…<!-- /if:<cap> -->`
 * conditional blocks — the same templating slashdo's own installer resolves
 * per target environment (see `lib/slashdo/src/transformer.js`). PortOS inlines
 * slashdo markdown into CoS-agent prompts WITHOUT going through that installer,
 * so unless we resolve these here the agent receives BOTH branches verbatim
 * (e.g. the Claude-Code-only "in-process Agent tool" reviewer branch AND the
 * `claude -p` subprocess branch), which is self-contradictory and makes a
 * headless agent improvise its own reviewer invocation.
 *
 * Only the `teams` capability is recognized (matching slashdo's
 * CONDITIONAL_CAPABILITIES). `teams=false` keeps the `else` branch — the
 * subprocess (`claude -p …`) reviewer path that works from any host — which is
 * the correct choice for PortOS's headless CoS agents (they have no in-process
 * Agent tool and are not billing against an interactive Claude Code plan).
 * Unknown capabilities are left untouched so a stray comment never deletes
 * content. Blocks do not nest.
 */
function resolveSlashdoConditionals(content, { teams = false } = {}) {
  const blockRe = /<!--\s*if:([a-zA-Z]+)\s*-->\n?([\s\S]*?)(?:<!--\s*else\s*-->\n?([\s\S]*?))?<!--\s*\/if:\1\s*-->\n?/g;
  return content.replace(blockRe, (match, cap, ifContent, elseContent = '') => {
    if (cap !== 'teams') return match;
    return teams ? ifContent : elseContent;
  });
}

/**
 * Load a slashdo command markdown file, resolving !`cat ~/.claude/lib/...`
 * includes AND the `<!-- if:teams -->` conditional blocks (to the non-teams
 * `else` branch — see resolveSlashdoConditionals). Both are needed because
 * PortOS inlines these command bodies into headless CoS-agent prompts without
 * running slashdo's own installer: e.g. `commands/do/better.md` ships an
 * `if:teams` block, and a `/do:better` CoS dispatch would otherwise hand the
 * agent both contradictory branches. Optionally strips YAML frontmatter.
 *
 * `skipIncludes` prunes named lib includes the run can never reach (issue
 * #3110). Most of a big command body is reviewer/mode VARIANTS — `review` and
 * `better` each pull all five reviewer loops (~152KB of the 258KB body) though a
 * given run drives exactly one of them. Passing the unreachable names here is
 * where the real prompt saving comes from; each skipped include leaves a
 * one-line "not applicable" marker in its place (see `resolveSlashdoIncludes`).
 * Callers derive the set from already-resolved run settings and must default to
 * skipping NOTHING when they can't — an over-pruned prompt that drops the loop
 * the agent actually needs is far worse than a fat one.
 *
 * Cached: slashdo files are static within a server lifetime (submodule updates
 * require restart). Cache resets on process restart, which is the right behavior.
 * The cache key carries the skip set, so two runs with different reviewer sets
 * don't serve each other's pruned body.
 *
 * @param {string} commandName - bare command name (`review`)
 * @param {Object} [opts]
 * @param {boolean} [opts.stripFrontmatter=false]
 * @param {string[]} [opts.skipIncludes=[]] - lib include names to prune
 * @returns {Promise<string|null>} null when the command file doesn't exist
 */
const slashdoFileCache = new Map();
export async function loadSlashdoFile(commandName, { stripFrontmatter = false, skipIncludes = [] } = {}) {
  // Sorted so `[a, b]` and `[b, a]` hit the same cache entry.
  const skipSet = new Set(Array.isArray(skipIncludes) ? skipIncludes.filter(n => typeof n === 'string' && n) : []);
  const skipKey = [...skipSet].sort().join(',');
  const cacheKey = `${commandName}::${stripFrontmatter}::${skipKey}`;
  if (slashdoFileCache.has(cacheKey)) return slashdoFileCache.get(cacheKey);

  const cmdPath = join(PATHS.slashdo, 'commands/do', `${commandName}.md`);
  let content = await readFile(cmdPath, 'utf-8').catch(() => null);
  if (!content) return null;
  if (stripFrontmatter) {
    content = content.replace(/^---[\s\S]*?---\s*/, '');
  }
  content = await resolveSlashdoIncludes(content, join(PATHS.slashdo, 'lib'), {
    skipInclude: skipSet.size ? (name) => skipSet.has(name) : null,
  });
  content = resolveSlashdoConditionals(content);
  slashdoFileCache.set(cacheKey, content);
  return content;
}

/**
 * Write an already-loaded, fully-resolved slashdo command body to disk and return
 * its absolute path, so an agent with file tools can READ the procedure instead of
 * receiving it pasted into its prompt (issue #3110).
 *
 * Why a resolved COPY and not `lib/slashdo/commands/do/<cmd>.md` directly: the
 * shipped file's `` !`cat ~/.claude/lib/…` `` includes are unresolved and a
 * codex/grok host has no `~/.claude/lib` to resolve them against, so pointing at
 * the submodule hands the agent a procedure with holes in it.
 *
 * Takes the body rather than re-loading it, so the caller's single
 * `loadSlashdoFile` result is the one thing written *and* rendered — no way for
 * the file on disk and the size the caller measured to disagree.
 *
 * Written at most once per (command, body) per process: the path→body pair is
 * memoized, so repeat dispatches of the same command skip the write entirely.
 *
 * @param {string} commandName - bare command name (`review`)
 * @param {string} body - the resolved markdown to write
 * @param {Object} [opts]
 * @param {string[]} [opts.skipIncludes=[]] - the prune set that produced `body`;
 *   folded into the filename so two runs with different reviewer sets don't
 *   overwrite each other's copy.
 * @returns {Promise<string|null>} absolute path, or null for an empty body or a
 *   command name that isn't a bare, path-inert segment
 */
const slashdoResolvedPathCache = new Map();
export async function writeResolvedSlashdoBody(commandName, body, { skipIncludes = [] } = {}) {
  if (!body) return null;
  // Callers reach here through `resolveSlashdoInvocation`, which already rejects
  // anything that isn't a bare command — but this one WRITES a file, so it keeps
  // its own guard rather than trusting the call site. Mirrors
  // `isValidSlashdoCommand`'s shape (kept local to avoid an import cycle back
  // into slashdoInvocation.js, which is a consumer of this module's loaders).
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(commandName || '')) {
    console.warn(`⚠️ Refusing to stage a slashdo body for a non-bare command name: ${commandName}`);
    return null;
  }

  // The skip set changes the CONTENT, so it has to change the filename too —
  // otherwise two runs with different reviewer sets fight over one file and the
  // second agent reads the first one's pruned procedure. A short hash keeps the
  // common (unpruned) name clean while staying collision-free.
  const skipKey = [...new Set(Array.isArray(skipIncludes) ? skipIncludes.filter(Boolean) : [])].sort().join(',');
  const suffix = skipKey ? `-${createHash('sha256').update(skipKey).digest('hex').slice(0, 8)}` : '';
  const filePath = join(PATHS.slashdoResolved, `${commandName}${suffix}.md`);

  if (slashdoResolvedPathCache.get(filePath) === body) return filePath;
  await atomicWrite(filePath, body);
  slashdoResolvedPathCache.set(filePath, body);
  return filePath;
}

/**
 * Load a slashdo *lib* file (`lib/slashdo/lib/<name>.md`) — the shared
 * procedure fragments that command files `!`cat``-include — for inlining
 * directly into a CoS-agent prompt. Same include + conditional resolution as
 * loadSlashdoFile; the differences are that this reads the `lib/` dir (not
 * `commands/do/`) and exposes the `teams` override (loadSlashdoFile always
 * resolves to the non-teams branch). Defaults to the non-teams (`else`) branch
 * so a headless agent gets the subprocess reviewer invocation, not both.
 */
const slashdoLibCache = new Map();
export async function loadSlashdoLib(libName, { teams = false } = {}) {
  const cacheKey = `${libName}::${teams}`;
  if (slashdoLibCache.has(cacheKey)) return slashdoLibCache.get(cacheKey);

  const libDir = join(PATHS.slashdo, 'lib');
  let content = await readFile(join(libDir, `${libName}.md`), 'utf-8').catch(() => null);
  if (!content) return null;
  content = await resolveSlashdoIncludes(content, libDir);
  content = resolveSlashdoConditionals(content, { teams });
  slashdoLibCache.set(cacheKey, content);
  return content;
}
