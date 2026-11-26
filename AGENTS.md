# AGENTS.md

## Don't leave trash on the floor

Fix and verify each discovered problem or file it in the owning tracker.

- Fix bounded issues in scope. Preserve unrelated work and keep test assertions aligned with the contract.
- Route shared slashdo defects to `atomantic/slashdo`, PortOS defects here and managed-app or fork defects to their configured remote. Use the run's assigned forge identity only.
- Search before filing and reuse existing issues. Follow [portos-file-issue](.claude/skills/portos-file-issue/SKILL.md) for redacted evidence, dispatch labels and batching.
- Report fixes and tracker links. If filing fails, report the blocker and supply a ready-to-file body.

## Platform support and issue triage

macOS is the primary browser target and Windows is secondary. Linux browser-only findings require supported-target reproduction or shared-code, server, security or data impact.

## Resolve every accepted finding

Fix every accepted finding, including warnings and nits. Document false positives or rejected rules. Retained lint rules are errors.

Reassess rules before retirement and give rationale. Never suppress findings, weaken useful tests or retry until green. Document external blockers with evidence, an owner and a tracked next step.

Reject speculative durability or concurrency findings on regenerable state. Avoid receipt ledgers and quarantine archives for them.

## Commands

Non-obvious invocations only; the rest are `package.json` scripts.

```bash
npm run install:all              # includes git submodule update --init --recursive
npm test                         # server then client, CI's worker cap
npm test --prefix server|client   # Vitest (node | happy-dom); server also globs ../scripts, ../lib, ../autofixer
npm run test:db                  # DB-backed suites → portos_test ONLY
npm run pregate                  # BEFORE EVERY PUSH; -- --full for CI's plan
node scripts/pregate.js [--full] # same gate on Windows
```

Vitest sets `NODE_ENV=test`. Set `PORTOS_TEST_MEMO=off` to bypass passed-input reuse ([test memo](docs/TEST_MEMO.md)). Distinguish focused runs from full suites.

**Run pregate before every push and again after rebasing.** Run a focused public-boundary regression and require hosted CI. Pregate skips browser, DB and build suites ([details](docs/PREGATE.md)).

## Test Strategy: Value Over Assertion Count

Test at the highest practical public boundary. Use unit tests where they cheaply cover behavior the boundary cannot ([policy](docs/CONTRIBUTING.md#test-strategy-value-over-assertion-count)).

## Security Model

**Trust model.** One human per install, on a private Tailscale network. Omit multi-tenant controls including CORS restrictions and rate limits. Keep durable writes crash-safe, serialize overlapping writes and guard duplicate jobs. Support multiple installs.

**Host control runs with host privileges.** Encourage a strong, unique instance password. Password-free acceptance is machine-local and grants peers no execution authority.

**Never expose PortOS administration, APIs, sockets, sidecars or host controls publicly**, including via tunnels, Funnel, proxies or forwarding. TLS, password, toggles and approvals cannot waive this. A managed app can have its own public deployment. Check proposed behavior before claiming, approving, implementing or merging external work.

**Authentication and HTTPS are opt-in and off by default**: never assume a password is set.

- **Auth**: an optional instance password (`server/services/auth.js`, `authGate.js`) gates `/api/*` and `/data/*` except `ALWAYS_PUBLIC_API_PATHS` in `server/lib/apiAccessPolicy.js` (`/api/auth/status`, `/api/auth/whoami`, `/api/auth/login`, `/api/auth/logout`, `/api/system/health`, `/api/eidoverse/travel/guest`).
- **PortOS-spawned agents** authenticate with `PORTOS_API_TOKEN`: any `curl` against this install's API carries `-H "Authorization: Bearer ${PORTOS_API_TOKEN:-}"`; on `401 AUTH_REQUIRED`, check for a missing, expired or invalid token first. It is empty when no password is set and never given to a public-content review stage.
- **Agents PortOS did not spawn** use `node scripts/portos-api.js …`; never ask for or type the instance password ([docs/AGENT_API_KEY.md](docs/AGENT_API_KEY.md)).
- **HTTPS**: `npm run setup:cert` flips `:5555` to TLS with a loopback-only HTTP mirror on `:5553`. See [ports](docs/PORTS.md).

**Preserve delegated operator sessions** including verified `PORTOS_API_TOKEN`. Scoped peer credentials and network reachability grant no host access. Test unauthorized refusal and the authorized workflow.

**Audit external boundaries** including third-party code, public issue/PR data, retrieved content, model output and untrusted peers. Fix actual boundary crossings without human-only gates. Assess control, reachability and impact ([risk assessment](docs/SECURITY_RISK_ASSESSMENT.md)).

**Revalidate issues before claiming** against the freshly fetched default branch, `ETHOS.md` and this security model; skip resolved, superseded or incompatible work with concrete evidence and preserve active owners ([portos-file-issue](.claude/skills/portos-file-issue/SKILL.md)).

**Creative review and public publication are separate.** Only public Suno publication and social-media posting need the human; review decisions bind to exact revisions and genuine inspection evidence.

**Federate only between the user's own machines** under [the federation ADR](docs/decisions/2026-09-19-user-controlled-federation.md). Keep credentials, keys and machine-local settings local. Announcements and reachability grant no publication authority.

**Distribution model.** Support cross-install and cross-version compatibility:

- **Never delete or skip migration/compatibility code because "there's only one install."** On-disk format changes need a migration in `scripts/migrations/`; seed files ship in `data.reference/`.
- Derived migrations gate on the input and ship no output seed. Declare outputs in the migration's `OWNED_OUTPUT_PATHS` and register them in `scripts/lib/migrationOwnedPaths.js`.
- Prompt-default changes bump the version via the integrity-snapshot regen; sync payloads stay version-gated.
- **Never add `--force` to the server-side `gh repo sync`** (it discards fork commits). See [self-update](docs/SELF_UPDATE.md).

**Keep the intentional dev DB fallback `portos`.** Production sets `PGPASSWORD`.

**Storage backend.** PostgreSQL is mandatory for every install and peer (`docs/STORAGE.md`); `MEMORY_BACKEND=file` is a dev/test escape hatch selected by `NODE_ENV=test`. Add no silent fallback or file choice to `scripts/setup-db.js`.

**Free, non-monetary API keys are exempt from security findings.** Keep all keys out of commits and logs. Paid, money-bearing and destructive keys remain in scope.

**DB tests run only via `npm run test:db` against `portos_test`.** Preserve the `NODE_ENV=test` or `VITEST` gate and refuse every test-runner row write to other databases.

## AI Provider Usage Policy

**No cold-bootstrap LLM calls.** Boot reads disk. Unscheduled calls need a direct user action or explicit consent. Let users choose or decline the provider and model for fills. Replenish consumed items silently only within the existing batch size. User-configured schedules and automations may run automatically.

**Send chosen model input as written.** Keep additions in labeled, openable chips and show/copy the exact sent prompt from the same server builder. Record exact input and additions for unattended runs. Count and refuse over-limit inputs. Correct generated text at the writer, never with a cleanup pass.

## Architecture

PortOS owns 5553–5569. Define ports in `ecosystem.config.cjs` (`PORTS`). Vite dev uses 5554, the server 5555 and the TLS loopback HTTP mirror 5553 ([ports](docs/PORTS.md)).

**Never run `npm ci` or `npm install` in linked CoS worktrees.** Use the linked binaries. Link manually created worktrees with `node scripts/link-worktree-deps.js <primary-checkout> <worktree>` ([recovery](docs/TROUBLESHOOTING.md)).

**Backup excludes.** Anchor every `DEFAULT_EXCLUDES` path in `server/services/backup/excludes.js` with a leading `/` or it silently drops user data .

### Per-directory conventions

Read the nested `AGENTS.md` (bridge `CLAUDE.md`) before editing `client/src`, `client/src/components/dashboard`, `server` or `server/lib/aiToolkit` (no imports out to other PortOS modules). API-provider agents also load these instructions within a 16 KiB root and 6 KiB per-file nested budget. Keep safety-critical rules in the root and task-specific procedures in skills.

**Navigation**: a `<Route>` without a `NAV_COMMANDS` entry (`server/lib/navManifest.js`) is unreachable from ⌘K and voice; a toggle that arms background work reconciles at toggle time ([portos-add-page](.claude/skills/portos-add-page/SKILL.md)).

**Slashdo**: `lib/slashdo` is a submodule exposed as `.claude/commands/do/`; `!read lib/<name>.md` means read `lib/slashdo/lib/<name>.md`. In a staged CoS bundle, resolve from the containing file.

## Module Organization

Search `node scripts/lib-catalog.js <term>` before adding helpers. Review [portos-add-module](.claude/skills/portos-add-module/SKILL.md) and [storage rules](docs/STORAGE.md). Keep one concern per file and colocate tests.

**Scope boundary**: work on managed apps outside PortOS goes in that app's repository.

## Sensitive Data & Privacy (developing on a live instance)

Treat every branch artifact and shared log as public. Keep live data and identifiers out of source, docs, fixtures, commits, reviews and tracker text.

- **Machine identity**: hostnames, machine/Tailscale/MagicDNS names, device IDs, OS usernames, home paths with a username (`/Users/<name>/…`), emails, account IDs, license keys, serials.
- **Network info**: IPs, MACs, subnets, VPN keys, `.env` secrets, DB passwords other than the `portos` dev fallback, API tokens, cookies, auth headers.
- **PII**: real names, addresses, phone numbers, birthdays, government IDs, payment details, GPS coordinates, biometrics, of the user or anyone in their data.
- **Personal app data**: real universe/series/catalog records, brain/journal entries, MeatSpace/POST data, media project names, task payloads, chat/voice transcripts, any record from `data/`, the live DB or a running screen.

Use obviously fake placeholders (`example.com`, `192.0.2.10`, `<hostname>`, `<record-id>`) and redact repro logs. Read `hostname`, `whoami`, `ifconfig`, `tailscale status`, `env` or `git config user.*` only for in-session logic, never into an artifact. Scan your diff before committing; if real data was committed, rewrite the branch before pushing. Prefer repo-relative paths. **Never link AI conversation sessions** (`claude.ai`, `chatgpt.com` or any chat share URL). Cite issue numbers, commit SHAs or file paths instead.

## Code comments

Document invariants, safety rationale, external contracts and workarounds in comments. Remove stale or redundant comments and dead code. Retain licenses and directives.

## Code Conventions

- **Error handling**: Express handlers let errors reach the central middleware; no per-handler try/catch. Client code uses the shared boundaries in `client/src/AGENTS.md`. Outside the request lifecycle (PTY/child-process/timer callbacks) wrap hook invocations in try/catch, because an uncaught throw crashes Node.
- **Functional programming**: no classes; hooks in React. **Zod** route validation lives in `lib/*Validation.js`.
- **Lint is Biome** (`server/biome.jsonc`, `client/biome.jsonc`); `eslint-disable` does nothing. Suppress an enabled rule with `// biome-ignore lint/<group>/<rule>: <reason>`.
- **Push, don't poll**: the server emits a Socket.IO event when data changes; own mutations apply their response locally; never refetch on a timer ([exceptions](docs/UX_DESIGN_GUIDE.md#realtime-updates-not-polling); client rules in `client/src/AGENTS.md`).
- **Single-line logging** with emoji prefixes and interpolation, never JSON blobs or arrays. **stderr means "investigate"**: `console.error`/`console.warn` only for something actually wrong; guard refusals, skips and handled degraded states stay on `console.log` with a non-failure marker (`server/test/guards/runtime/logLevelConventions.test.js`).
- **LLM response merging.** Preserve the original for absent or invalid fields. Apply valid empty values as clears. Check types and keep server merges and client `pick` helpers mirrored.
- **Sentinels**: never let absent, failed-to-fetch or invalid collapse into fetched-and-empty or valid; use an explicit sentinel and validate, not `x.length` or `x || fallback`.

## Git Workflow

**Read [portos-ship](.claude/skills/portos-ship/SKILL.md) before pushing, opening, merging, cleaning up or releasing.**

- **Never pass `--delete-branch` to `gh pr merge`** (including fallbacks); it can remove another linked checkout.
- **Never change protections or bypass them without explicit task or app opt-in.** With `autoApprovePR`, `adminMerge` only covers a required-review-only block after CI passes on the pinned head. Only forge-confirmed `MERGED` is delivery.
- **Never discard another checkout, ref, lock or unmerged work**; teardown deletes only this task's named branch and checkout after a confirmed merge.
- Release only within an authorized release workflow (`/do:release`); don't bump `package.json` during development.

Other rules:

- **No changelog entries in PRs.** Release notes are generated from commits.
- After each change, review the diff for needless complexity and duplication (`/simplify` when available). A review-only request does not authorize shipping.
- Make routine design decisions instead of parking issues for input; issue labels come only from `MANDATORY_DISPATCH_HINT_GUIDANCE` in `server/lib/dispatchLabels.js`.

## Documentation

[ETHOS.md](ETHOS.md) states why unsupervised agent operation is the design target; read it before proposing supervision gates, per-action confirmations or new data crossing federation. `docs/README.md` indexes `docs/`.
