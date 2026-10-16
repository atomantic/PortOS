/**
 * Pure argv conventions for the GitLab CLI (`glab`) — no child-process access,
 * so the three runners that drive `glab` (services/gitlab.js#execGlab,
 * perpetualWork.js#runCli, lib/runCliBounded.js) can share one
 * definition without inheriting each other's timeout policy. Mirrors
 * `cliProviderArgs.js` / `gitArgs.js`.
 */

/**
 * The ONE spelling of "answer in JSON" that every `glab` subcommand accepts.
 *
 * `-F json` is a trap, and it is the trap PortOS fell into: `-F` does NOT mean
 * the same thing on every subcommand. On `mr list`, `mr view`, `issue view`,
 * `repo view` and `label list`, `-F` is the shorthand for `--output`
 * (text|json). On `glab issue list` it is the shorthand for a DIFFERENT flag,
 * `--output-format` (details|ids|urls), while `--output` selects text|json and
 * carries the shorthand `-O`. So `glab issue list -F json` is accepted,
 * silently ignored, and answers with the HUMAN TABLE at exit 0 — which every
 * caller parsed as "couldn't fetch", reporting an authentication problem to a
 * user whose `glab` was authenticated the whole time.
 *
 * The long `--output json` form means text-vs-json on all of them, so it is the
 * only form PortOS code uses. `glab mr list --state <x>` is the sibling trap:
 * there is no `--state` flag on `mr list` at all — state is selected by
 * presence flags (`--merged`, `--closed`, `--all`) and defaults to open.
 * `server/services/gitlab.glabFlags.test.js` walks the tree and fails on either
 * spelling, so this comment is enforced rather than merely asserted.
 *
 * Frozen because it is shared by every `glab` invocation in the process — an
 * importer that pushed onto it would poison all of them.
 */
export const GLAB_JSON_ARGS = Object.freeze(['--output', 'json']);

/** `args` plus the JSON output flag. See GLAB_JSON_ARGS for why not `-F json`. */
export const withGlabJson = (args) => [...args, ...GLAB_JSON_ARGS];
