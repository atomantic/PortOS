# Scripts reference

Every top-level file in `scripts/` is either wired into something (CI, a test, a `package.json` script, the server) or listed here with when to run it. The guard in `server/scriptReferences.test.js` fails a top-level script that nothing references, so a new one needs a row here or a caller. Test files (`*.test.js`) are collected by the Vitest run and are not listed.

## npm scripts

| Command | Purpose |
|---------|---------|
| `npm run api -- <cmd> …` | Call this machine's PortOS API from a terminal agent without the instance password. See [AGENT_API_KEY.md](./AGENT_API_KEY.md). |
| `npm run eval:agent-context` | Evaluate the agent instruction context (`server/services/agentContextEval.js`). Takes `--fixture <path>` and `--failure-threshold <n>`. |
| `npm run setup:spotlight` | macOS only. Excludes churny `data/` subdirectories (worktrees, archives, profiles) from Spotlight; user media stays indexed. Also runs from `setup-data.js`. Set `PORTOS_SKIP_SPOTLIGHT_EXCLUDE=1` to opt out. |
| `npm run setup:ghostty` | Installs the PortOS Ghostty themes and adds a source line to `~/.zshrc`. Run once on a machine that uses Ghostty. |
| `npm run setup:hooks` | Points `core.hooksPath` at `.githooks` and makes the pre-commit hook executable. Run once per clone. |
| `npm run reset:password -- <newPassword>` | Recovery when the instance password is lost. Writes `secrets.auth` directly; `--disable` turns the gate off. Stop PortOS first, since the running server caches `settings.json`. |
| `npm run scan:hidden-content` | Fails a diff that hides content from its reviewer; the script header lists the shapes it flags. Use `--base <ref>`, `--worktree`, or `--stdin`. Runs before any model reviews a diff. |

## Operator and maintenance scripts

| Script | When to run it |
|--------|----------------|
| `scripts/backfill-antigravity-usage.js` | Dry run by default; `--apply` repairs Antigravity usage rows in `data/usage.json`. Stop PortOS first. While it runs, use Reconcile now on the Usage page instead. |
| `scripts/backfill-grok-usage.js` | Same contract as the Antigravity backfill, for Grok usage. Accepts `--home` and `--data` overrides. Cache rates are not rewritten. |
| `scripts/repair-orphaned-issues.js --series=<seriesId> [--apply]` | Repairs pipeline issues stranded behind a defunct `seasonId` after an arc regeneration. Dry run by default. |
| `scripts/show-deletions.mjs [--table= --action= --since= --id= --limit=]` | Reads the `record_audit` deletion log to answer what was deleted, when and by what. Connects with the standard `PG*` variables through `psql`. |
| `scripts/jira-create-ticket.js --app <app> --summary "…"` | Creates a JIRA ticket through the PortOS JIRA service, using the app's config in `apps.json`. |
| `scripts/jira-update-ticket.js --app <app> --ticket <KEY> [--transitions\|--transition\|--comment\|…]` | Updates, comments on, transitions or deletes a JIRA ticket. |
| `scripts/seed-readme-demo-data.mjs --root <empty-dir>` | Builds a synthetic data root for README screenshots from `data.reference/`. It never reads the install's `data/`. Give it an empty directory. |
| `scripts/align_lyrics_ctc_accuracy.py --model-dir <dir>` | Opt-in accuracy check of the lyric aligner against the real MMS_FA checkpoint (about 1.2 GB, downloaded on first use). CI never runs it. Run it with the `lyric-align` venv's interpreter. |
