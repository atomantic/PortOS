/** `GLAB_JSON_ARGS`, `withGlabJson(args)` — pure `glab` argv conventions shared by the three `glab` runners. */

/** Use `--output json`, never `-F json` (on `glab issue list` `-F` is `--output-format`, so it exits 0 with the human table) or `mr list --state` (no such flag); enforced by `server/test/guards/runtime/gitlab.glabFlags.test.js`. Frozen: shared process-wide. */
export const GLAB_JSON_ARGS = Object.freeze(['--output', 'json']);

/** `args` plus the JSON output flag. See GLAB_JSON_ARGS for why not `-F json`. */
export const withGlabJson = (args) => [...args, ...GLAB_JSON_ARGS];
