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
| `mobile-responsive` | Small-screen and touch usability | `mobile` | implement | |
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

## Why the boundaries are explicit

Twenty-five lanes only pay off if they do not file each other's findings. Every
mission body names what it cedes and to whom, so two lanes cannot both claim one
problem:

- **Complexity is split three ways.** `better-complexity` owns *counted*
  branching and must report the number. `better-cognitive-load` owns reader cost
  that no metric captures — mixed abstraction levels, flag arguments, names that
  lie. `module-hygiene` owns responsibility boundaries and treats a complexity
  score only as a candidate signal, never as a finding.
- **Duplication is split two ways.** `simplify` owns copy-paste and dead code.
  `better-structural-drift` owns a derived artifact or hand-synced registry acting
  as a second source of truth, which is a different fix (derive it, or add the
  parity check).
- **Defects are split four ways.** `better-runtime-safety` reads source for
  latent defects; `console-errors` collects what actually errors at runtime;
  `error-handling` owns the failure path once something goes wrong; and
  `ui-lifecycle` owns UI lifecycle and state correctness across UI runtimes.
  Its checks follow the target app’s own semantics.
- **Tests are split two ways.** `test-coverage` owns the gaps;
  `better-test-quality` owns the tests that already exist.

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
produces no diff is not scored as a failure.

Findings go to whichever tracker the app resolves to — a `PLAN.md` checklist
item, a GitHub or GitLab issue, or a JIRA ticket — via `{trackerInstructions}`.
PLAN.md keeps its existing checklist IDs. New forge and JIRA issues use plain
human-readable titles, with the issue number/key as the ID and category/metric
labels for filtering. Earlier bracketed title prefixes are read only when
checking for duplicates; new issue titles do not add them.
