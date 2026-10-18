# Self-improvement audits

PortOS ships one scheduled task per category of software quality. Each is an
**audit lane**: it reads a managed app (PortOS included), and either files
decision-complete tracker items or implements a fix — a per-task toggle, not two
different tasks.

Configure them in **CoS → Schedule**. Every lane is on-demand and enabled by
default, so a fresh install spends nothing until you press Run or pick a cadence
(the AI Provider Usage Policy in `AGENTS.md`).

Filed forge issues use short, human-readable titles; the issue number or key is
the ID. Category labels (`code-quality`, `bug`, `tests`, …) and distinct metric
labels (`cognitive-load`, `structural-drift`, `runtime-safety`, …) make the
backlog filterable without encoding metadata in titles. PLAN.md keeps its
existing slugged checklist IDs.

Registry: `server/lib/auditCatalog.js` (what each lane is and how it files),
`server/services/taskScheduleRegistry.js` (cadence and posture),
`server/services/taskPromptDefaults/prompts.js` (the mission bodies).

## Codex security scans

When a `security` task runs through a Codex CLI/TUI provider, dispatch adds a
Codex Security runtime contract, including for customized or previously queued
missions. Selection follows the provider executable (with the shipped provider
id as a fallback), rather than the model name. Other providers and the separate
local-inference-only private assessment keep their existing workflows.

The agent uses an available Codex Security scanner or the official
[`@openai/codex-security` CLI](https://learn.chatgpt.com/docs/security/cli) in
report-only, unattended mode, with private artifacts outside the checkout.
Existing authentication, configured model/effort, quota and spending limits
still apply. This routing does not install a hook, patch code, create a PR,
publish findings, or authorize a different provider account. The audit's
file-issues/remediation contract remains responsible for delivery.

Unavailable access or a refused action must be recorded without interactive
login or repeated attempts through another tool. The agent preserves completed
evidence, continues independently permitted review, delivers supported findings,
and writes the usual quality assessment and completion sentinel. Scanner
coverage and unresolved areas remain evidence to inspect, not a clean bill of
health for the repository.

The runner scans a private standalone snapshot of **committed HEAD**, with every
selected source and knowledge-base path mapped into that snapshot. Ordinary
remediation edits and later commits in the agent worktree cannot change the scan
target. Evidence records the exact commit and tree. Uncommitted, untracked and
ignored files are excluded; submodules are excluded without initialization, and
symlinks are read as their recorded link text. A selected input absent from the
commit or inside a submodule stops preparation before any provider launch.
Findings must be checked against current source before remediation; a completed
baseline scan does not certify later repairs.

Snapshot preparation and scanning share the runner's supervised process group,
durable reservation and Stop/recovery cleanup. A typed input rejection permits
explicit correction only before provider launch and after confirmed preparation
cleanup; other preparation failures remain terminal. New grants explicitly use ChatGPT auth and resolved model/
effort, with no PortOS estimate cap or elapsed-time deadline; provider limits
and terminal refusals still apply. Older saved grants retain their original limits.

Server-generated PR descriptions place validated runner scanner evidence before
the assistant summary. This section survives summary truncation and distinguishes
scanner completion, artifacts, cleanup and revision coverage from delivery or
quality-assessment success. Cost estimates are API-equivalent estimates, not
proof of billing or subscription consumption.

## The lanes

`Mode` is the shipped default. `Isolated` marks lanes whose remediation must run
in a managed worktree — a mechanical restructuring of hot code must never land in
the operator's live checkout.

| Task type | Owns | Files under | Mode | Isolated |
|---|---|---|---|---|
| `security` | Exposure real under the app's own threat model | `security` | implement | |
| `code-quality` | Conventional maintainability defects | `code-quality` | implement | |
| `test-coverage` | Untested behavior worth covering | `tests`, `test-gap` | implement | |
| `performance` | Provably wasted work on a hot path | `performance`, `perf` | implement | |
| `accessibility` | Keyboard, screen-reader, contrast, zoom barriers | `accessibility`, `a11y` | implement | |
| `documentation` | Docs that are wrong, then docs that are missing | `documentation`, `docs` | implement | |
| `ui-bugs` | Things that are broken in the running interface | `bug`, `ui-bug` | implement | |
| `mobile-responsive` | Layout at viewport widths ≤1024 and touch mechanics | `mobile` | implement | |
| `error-handling` | Failure paths, timeouts, retries, degraded fallback | `resilience` | implement | |
| `typing` | Type contracts at boundaries | `code-quality`, `typing` | implement | |
| `console-errors` | What the app actually emits while running | `bug`, `console` | implement | |
| `ux` | Whether a user can get the job done | `ux` | file | |
| `data-safety` | Migrations, schema parity, cross-version safety | `data-safety` | file | |
| `simplify` | Dead code, duplication, YAGNI | `code-quality`, `simplify` | file | |
| `module-hygiene` | Responsibility boundaries, reuse, discoverability | `code-quality`, `module-hygiene` | file | yes |
| `api-contract` | Route validation, client/server drift, envelopes | `api-contract` | file | |
| `ui-lifecycle` | UI resource lifetimes, stale data, async ordering, state continuity | `ui-lifecycle` | file | |
| `observability` | Silent catches, log noise, missing error context | `code-quality`, `observability` | file | |
| `copy` | User-facing wording | `ux`, `copy` | file | |
| `better-complexity` | Counted branching per function | `code-quality`, `complexity` | file | yes |
| `better-cognitive-load` | Reader cost no metric captures | `code-quality`, `cognitive-load` | file | yes |
| `better-structural-drift` | The same fact kept in two places | `code-quality`, `structural-drift` | file | yes |
| `better-runtime-safety` | Latent defects not yet triggered | `bug`, `runtime-safety` | file | |
| `better-dependency-freedom` | Whether a dependency should exist at all | `dependencies`, `depfree` | file | yes |
| `better-test-quality` | Existing tests that prove nothing | `tests`, `test-quality` | file | |
| `better-dev-environment` | What the dev loop leaves on the host | `tests`, `dev-environment` | file | |
| `infrastructure` | Deployment, container, IaC and CI configuration | `infrastructure` | file | |
| `data-integrity` | Ingestion, idempotency, lost updates, consistency, schema evolution | `data-safety`, `data-integrity` | file | |
| `reliability` | Shutdown, health checks, backpressure, job leasing, mixed-version deploys | `resilience`, `reliability` | file | |
| `privacy` | Exposure, minimization, retention and erasure of personal data | `privacy` | file | |
| `cost-efficiency` | Metered spend: paid calls, unbounded scans, over-provisioning | `performance`, `cost` | file | |
| `feature-completeness` | Work started and never finished, offered to users anyway | `bug`, `incomplete` | file | |
| `workflow-recovery` | Multi-step workflows that strand their record between steps | `bug`, `workflow` | file | |

## Why the boundaries are explicit

Lanes only pay off if they do not file each other's findings. Every
mission body names what it cedes and to whom, so two lanes cannot both claim one
problem:

- **Complexity is split three ways.** `better-complexity` owns *counted*
  branching and must report the number. `better-cognitive-load` owns reader cost
  that no metric captures — mixed abstraction levels, flag arguments, names that
  lie. `module-hygiene` owns responsibility boundaries and treats a complexity
  score only as a candidate signal, never as a finding.
- **Layout is split by what is narrow.** `mobile-responsive` owns every layout
  defect at a viewport width ≤1024 (phone and tablet) plus touch mechanics —
  overflow, clipping, breakpoint gaps, tap targets. `ux` checklist item 8 keeps
  only a narrow CONTAINER on a desktop viewport (a dashboard widget, an embedded
  panel, a side panel); the two lanes name each other's side (#12084).
- **Duplication is split two ways.** `simplify` owns copy-paste and dead code.
  `better-structural-drift` owns a derived artifact or hand-synced registry acting
  as a second source of truth, which is a different fix (derive it, or add the
  parity check). It also owns **behaviour twins** — two code paths implementing
  one concern for different callers (an operator lane and an unattended lane, a
  modal and a drawer) where a guard or contract check landed in only one; the
  proof is `git log -S` on the one-sided fix, and the resolution is a shared
  primitive or a parity test, never a copied patch (#12092). File splits and
  responsibility boundaries stay with `module-hygiene`, which `simplify` cedes
  by name (#12083).
- **Read-modify-write races have one owner.** `data-integrity` owns lost
  updates and read-modify-write races on a persisted record or file;
  `data-safety` and `better-runtime-safety` cede them by name, and runtime-safety
  keeps only check-then-act races on in-memory module state (#12082).
  `error-handling` likewise cedes sensitive detail leaking through an error path
  to `privacy` and partial writes to `data-integrity` (#12086).
- **Defects are split four ways.** `better-runtime-safety` reads source for
  latent defects; `console-errors` collects what actually errors at runtime;
  `error-handling` owns the failure path once something goes wrong; and
  `ui-lifecycle` owns UI lifecycle and state correctness across UI runtimes.
  Its checks follow the target app’s own semantics.
- **Tests are split three ways.** `test-coverage` owns the gaps;
  `better-test-quality` owns whether the tests that exist prove anything; and
  `better-dev-environment` owns what running them does to the host — temp
  files and processes left behind, writes outside the sandbox, watcher cost,
  suite runtime. It measures host state before and after a bounded run,
  because a static read of one suite cannot see accumulation: every suite
  leaking one temp directory per run passed both other lanes while filling a
  dev machine's temp directory with tens of thousands of entries (#9000).

## The `better-` prefix and slashdo scope alignment

The bundled slashdo `/do:better` command now declares a generic scope and
ownership table in `lib/slashdo/lib/better-audit.md`; it no longer has a
`For <lens>:` checklist for PortOS to mirror. PortOS keeps its focused
`better-*` scheduled missions as narrower, PortOS-owned additions that can be
scheduled and pinned independently. Their prompt bodies own the specialist
checks. Shared audit discovery, issue filing, and delivery contracts stay in
their common runtime seams instead of being copied into each mission.

`DO_BETTER_SCOPE_COVERAGE` in `server/lib/auditCatalog.js` maps current slashdo
scope names to scheduled task types and drives schedule labels. The test reads
the bundled scope table in both directions: a new upstream scope needs an owner,
and an obsolete scope label cannot remain after upstream changes. The former
`DO_BETTER_LENS_COVERAGE` export remains an alias for compatibility.

The prefix is spelled with a hyphen rather than `better:` because a task type is
interpolated into the CoS task id, which becomes a git branch name
(`cos/<taskId>/<agentId>`) and a worktree directory. Git refs reject a colon,
Windows paths reject a colon, and the `TASKS.md` id pattern accepts only word
characters and hyphens.

## Filing and mode

`fileIssues` decides the deliverable, and the banner injected at
`{modeInstructions}` is what enforces it — overriding any instruction in the
body. In file-issues mode the dispatch also stamps `noCodeOutput`, so a run that
produces no diff is not scored as a failure. The banners also own the rules
every lane shares — redact before publishing (`AUDIT_REDACTION_RULE`), read the
repository's `AGENTS.md` first, and, in do-work mode only, resolve every
accepted finding — so a mission body never restates them; `auditCatalog.test.js`
fails on a restatement (#12080).

Findings go to whichever tracker the app resolves to — a `PLAN.md` checklist
item, a GitHub or GitLab issue, or a JIRA ticket — via `{trackerInstructions}`.
PLAN.md keeps its existing checklist IDs. New forge and JIRA issues use plain
human-readable titles, with the issue number/key as the ID and category/metric
labels for filtering. Earlier bracketed title prefixes are read only when
checking for duplicates; new issue titles do not add them.

### The dependency-freedom removal bar

`better-dependency-freedom` carries one more knob than its siblings: the
**removal bar** (`taskMetadata.depfreeMode`, set globally on the Schedule page
and overridable per app), rendered at `{depfreeMode}` and prepended when a
customized prompt dropped the token. Its values are the slashdo `/do:depfree`
modes, so a scheduled audit and a terminal run draw the same line:

| Bar | Exempt | Ceiling |
|:--|:--|:--|
| `default` | large, widely audited libraries | ~300 lines of owned code |
| `heavy` | foundational frameworks, runtimes, core tooling | ~300 lines; popularity is not an exemption |
| `extreme` | the runtime, security-sensitive protocols and primitives, native bindings, CI-required tooling | none — a parity test suite and a written replacement design gate each swap |

The extreme bar is written for the strongest available model at maximum
reasoning effort; it tells the agent to say so at the top of its report when it
is running on a budget provider, rather than quietly lowering the bar. Pin the
model and effort on the same Schedule card. The server-side vocabulary is
`DEPFREE_MODES` in `server/lib/auditCatalog.js`, beside the block text in
`applyDepfreeMode`; `server/lib/cosValidation.js` re-exports the vocabulary.
