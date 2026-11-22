# Scripts reference

Top-level scripts, ML runners, operator tools, and fixtures or experiments need a caller or a live documentation entry. The guard in `server/test/guards/repo/scriptReferences.test.js` checks these references. Vitest collects `*.test.js` files directly.

Python ML runners and probes live under `scripts/ml/`. Their input and lock files live under `scripts/ml/requirements/`. Manual maintenance and demo scripts live under `scripts/ops/`. npm entry points and setup wrappers run from `scripts/`.

## npm scripts

| Command | Purpose |
|---------|---------|
| `npm run api -- <cmd> …` | Call this machine's PortOS API from a terminal agent without the instance password. See [AGENT_API_KEY.md](./AGENT_API_KEY.md). |
| `npm run portos-acp -- [--mode ask\|mind\|--check]` | `scripts/portos-acp.js`, the Agent Client Protocol stdio adapter an ACP editor launches to reach Ask Yourself or the Persistent Mind. See [ACP.md](./ACP.md). |
| `npm run lint` | Biome over client, server, scripts, lib and autofixer, the same command pregate and CI run (`scripts/run-ci-lint.js`). Exits non-zero on any diagnostic. Use it as the local lint step, e.g. `npm run lint && npm test`. |
| `npm run eval:agent-context` | Evaluate the agent instruction context (`server/services/agent/agentContextEval.js`). Takes `--fixture <path>` and `--failure-threshold <n>`. |
| `npm run setup` | The first-run install pipeline, `scripts/setup.js`; `install:all` is an alias and `setup.sh` / `setup.ps1` call the same file, so all three run the same ordered steps: version checks, git submodules, root/client/server dependency installs (cwd-based `npm install --no-save`, no `--prefix`, via the installer in `scripts/ensure-deps.js`) with the trusted native rebuilds, then data, database, local LLM, managed browser and certificate setup, then ffmpeg, slash-do and the setup walkthrough. It imports only Node builtins so it runs on a fresh clone. ffmpeg and slash-do are fail-soft. `PORTOS_DEFER_SETUP_GUIDE=1` holds the walkthrough back for the caller to print. |
| `node scripts/ensure-ffmpeg.js [--non-interactive]` | The one ffmpeg installer (Homebrew, apt-get, dnf or pacman; a manual hint on Windows). Called by `scripts/setup.js`, `update.sh` and `update.ps1`; `--non-interactive` limits Linux to passwordless `sudo -n`. Always exits 0. |
| `node scripts/install-slashdo.js` | The one slash-do installer: runs `npx slash-do@<version>` for the version pinned in `scripts/SLASHDO_VERSION`. Called by `scripts/setup.js`, `update.sh` and `update.ps1`. Always exits 0. |
| `npm run setup:data` | `scripts/setup-data.js`. Seeds `data/` from `data.reference/` (copies missing files, merges missing keys into structured JSON, expands `__PORTOS_ROOT__` in `apps.json`) and tidies legacy migration-ledger layout. Idempotent; `setup` runs it. Run it by hand after pulling changes that add seed files. |
| `npm run setup:db` | `scripts/setup-db.js`. Ensures PostgreSQL is available in the mode from `.env` (`PGMODE=native` or `docker`) and provisions the role and database. `PGMODE=file` is an unsupported escape hatch and only prints guidance. `setup`, `update`, `start` and `dev` call it; run it by hand to repair a database that will not connect. See [STORAGE.md](./STORAGE.md). |
| `npm run smoke` | `scripts/smoke-boot.js`. Boots `server/start.js` hermetically (disposable data root, allowlisted environment, no schedulers or agent spawning), waits for readiness, requires it to stay alive for `SMOKE_WINDOW_MS` (default 4000), then a clean shutdown. Run it after changing server startup code; unit tests miss top-level initialization failures. It never touches your real `data/`. |
| `npm run update` | `scripts/deferred-update.mjs`, the engine behind `update.sh` / `update.ps1`. Without a flag it stops when running work needs acknowledgement; `--interrupt` acknowledges interrupting that work and `--automatic` waits for idle. Prefer `./update.sh` (or the in-app updater), which wraps it with the dependency, data and database steps. |
| `npm run setup:spotlight` | macOS only. Excludes churny `data/` subdirectories (worktrees, archives, profiles) from Spotlight; user media stays indexed. Also runs from `setup-data.js`. Set `PORTOS_SKIP_SPOTLIGHT_EXCLUDE=1` to opt out. |
| `npm run setup:ghostty` | Installs the PortOS Ghostty themes and adds a source line to `~/.zshrc`. Run once on a machine that uses Ghostty. |
| `npm run reset:password -- <newPassword>` | Recovery when the instance password is lost. Writes `secrets.auth` directly; `--disable` turns the gate off. Stop PortOS first, since the running server caches `settings.json`. |
| `npm run scan:hidden-content` | Fails a diff that hides content from its reviewer; the script header lists the shapes it flags. Use `--base <ref>`, `--worktree`, or `--stdin`. Runs before any model reviews a diff. |

## Operator and maintenance scripts

| Script | When to run it |
|--------|----------------|
| `scripts/ops/backfill-antigravity-usage.js` | Dry run by default; `--apply` repairs Antigravity usage rows in `data/usage.json`. Stop PortOS first. While it runs, use Reconcile now on the Usage page instead. |
| `scripts/ops/backfill-codex-image-usage.js --data-dir <dir> --report <file>` | Builds a Codex image usage recovery report. A separate run with `--apply <file> --journal <file>` applies a reviewed report. |
| `scripts/ops/backfill-grok-usage.js` | Same contract as the Antigravity backfill, for Grok usage. Accepts `--home` and `--data` overrides. Cache rates are not rewritten. |
| `scripts/ops/repair-orphaned-issues.js --series=<seriesId> [--apply]` | Repairs pipeline issues stranded behind a defunct `seasonId` after an arc regeneration. Dry run by default. |
| `scripts/ops/show-deletions.mjs [--table= --action= --since= --id= --limit=]` | Reads the `record_audit` deletion log to answer what was deleted, when and by what. Connects with the standard `PG*` variables through `psql`. |
| `scripts/ops/recover-synced-test-fixtures.mjs` | Identifies previously synced test fixture records. Dry run by default. |
| `scripts/ops/jira-create-ticket.js --app <app> --summary "…"` | Creates a JIRA ticket through the PortOS JIRA service, using the app's config in `apps.json`. |
| `scripts/ops/jira-update-ticket.js --app <app> --ticket <KEY> [--transitions\|--transition\|--comment\|…]` | Updates, comments on, transitions or deletes a JIRA ticket. |
| `scripts/ops/seed-readme-demo-data.mjs --root <empty-dir>` | Builds a synthetic data root for README screenshots from `data.reference/`. It never reads the install's `data/`. Give it an empty directory. |
| `scripts/ml/align_lyrics_ctc_accuracy.py --model-dir <dir>` | Opt-in accuracy check of the lyric aligner against the real MMS_FA checkpoint (about 1.2 GB, downloaded on first use). CI never runs it. Run it with the `lyric-align` venv's interpreter. |
| `scripts/prune-model-comparison-seed.js [--check]` | Prunes `data.reference/model-comparison.json` to models in provider scope and public benchmark observations. Run with `--check` in CI or after modifying `providers.json`. |
| `scripts/ml/diagnose_minimax_h3.py --output-dir <dir> [--run]` | Reproduces MiniMax H3 continuity scenarios (#8867) on synthetic keyframes without private inputs. See `docs/research/minimax-h3-continuity.md`. |
| `scripts/ml/diagnose_minimax_h3_processor.py --cases <all\|production\|undersized>` | Compares H3 torchvision vs PIL image-processor backends across synthetic canvas resolutions. |
| `scripts/ml/diagnose_minimax_h3_vision.py <torch\|mlx> --output-dir <dir>` | Inspects H3 vision precision across backends/devices with cached weights and synthetic inputs. |
| `scripts/ml/compare_minimax_h3_vision.py --actual <dir> --reference <dir>` | Compares synthetic H3 vision traces produced by `diagnose_minimax_h3_vision.py`. |
