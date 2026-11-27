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

The agent reads instructions and the documented threat model, establishes scope,
then requests the runner's installed
[`@openai/codex-security` CLI](https://learn.chatgpt.com/docs/security/cli)
before vulnerability discovery or active testing. The runner discovers project,
global PATH and cached npm installs without installing or invoking a launcher.
The scan runs in report-only, unattended mode, with private artifacts outside
the checkout.
Existing authentication, configured model/effort, quota and spending limits
still apply. This routing does not install a hook, patch code, create a PR,
publish findings, or authorize a different provider account. The audit's
file-issues/remediation contract remains responsible for delivery.

Unavailable access must be recorded without interactive login or repeated
attempts through another tool. The agent preserves completed evidence, continues
independently permitted review, delivers supported findings, and writes the usual
quality assessment and completion sentinel. A cybersecurity/content-policy
refusal stops the scanner and outer request; it never authorizes continuation,
retry, rephrasing or provider fallback. Installing the scanner does not grant
broader [Trusted Access/Daybreak](https://learn.chatgpt.com/docs/cyber-safety).
Scanner coverage and unresolved areas remain evidence to inspect, not a clean
bill of health for the repository.

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

Design uses actual inspected screenshots, with at most six captures across representative
list/media, detail/editor and overlay/error/empty states, desktop and narrow views,
and at most two optional themes. Source-only review reports unavailable visual coverage;
unsampled states stay untested. Private/local synthetic evidence supports component
attribution, severity, impact and precise before/after acceptance criteria. Design and usability covers task flows, visual composition, and mobile layout and touch.
Accessibility owns keyboard, assistive-technology and contrast barriers. Deduplicate sibling findings by root cause. Aesthetic suggestions are report-only
proposals, never automatically scored or implemented defects. Preserve authored theme
identity; PortOS's Kestrel references apply only to PortOS. Manual Run or an explicitly
chosen cadence remains the trigger; adding this lane starts no provider work.

## Active audit domains

The Quality tab plans and scores the same 16 audit domains that CoS Schedule configures. Each domain starts on demand.

| Task type | Owns | Files under | Mode | Isolated |
|---|---|---|---|---|
| `security` | Exposure real under the app's own threat model | `security` | implement | |
| `privacy` | Exposure, minimization, retention and erasure of personal data | `privacy` | file | |
| `accessibility` | Keyboard, screen-reader, contrast, zoom barriers | `accessibility`, `a11y` | implement | |
| `api-contract` | Route validation, client/server drift, envelopes | `api-contract` | file | |
| `better-dependency-freedom` | Whether a dependency should exist at all | `dependencies`, `depfree` | file | yes |
| `feature-completeness` | Work started and never finished, offered to users anyway | `bug`, `incomplete` | file | |
| `architecture-maintainability` | Architecture and maintainability | `code-quality`, `architecture-maintainability` | file | yes |
| `code-simplification` | Code simplification | `code-quality`, `code-simplification` | file | yes |
| `ui-runtime-bugs` | Application and UI runtime bugs | `bug`, `ui-runtime-bugs` | file |  |
| `reliability-error-handling` | Reliability and error handling | `resilience`, `reliability-error-handling` | file |  |
| `data-integrity-safety` | Data integrity and safety | `data-safety`, `data-integrity-safety` | file |  |
| `test-quality-coverage` | Test quality and coverage | `tests`, `test-quality-coverage` | file |  |
| `performance-efficiency` | Performance and resource efficiency | `performance`, `performance-efficiency` | file |  |
| `infrastructure-environment` | Infrastructure and development environment | `infrastructure`, `infrastructure-environment` | file |  |
| `design-usability` | Design and usability | `ux`, `design-usability` | file |  |
| `documentation-content` | Documentation and product copy | `documentation`, `documentation-content` | file |  |

## Upgrading earlier schedules

Saved settings on retired audit IDs are folded into their corresponding domains. A
customized domain schedule takes precedence. When several retired profiles have
different customizations and the domain still has its defaults, the first customized
record in file order supplies the active configuration. Conflicting settings are kept
under `retiredAuditConfigs` in the schedule or app record for recovery. Unedited
shipped prompts are replaced by the domain's default. Custom prompts are carried
forward verbatim.

Pending requests and ordering references follow the new IDs. Historical quality
measurements keep their original categories and contribute to the corresponding
domain trend.

Data integrity and safety includes upgrade and restore rehearsals. Build them
from synthetic fixtures and use separate test databases through
`scripts/rehearsal-scratch-db.js`. Report the PostgreSQL steps as uncovered when
the sandbox cannot create scratch databases. Keep live data out of rehearsals.

## Slashdo scope alignment

`DO_BETTER_SCOPE_COVERAGE` maps the bundled slashdo audit scopes to their PortOS
scheduled domains. Its tests verify that every bundled scope has an owner.

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
`applyDepfreeMode`; `server/lib/cos/cosValidation.js` re-exports the vocabulary.

## Reachability check and the app's deployment model

Every audit carries one shared calibration rule: weigh a candidate by how
likely it is under the app's real deployment model and drop what that model
rules out. A single-user install drops multi-user edit races; a multi-user app
keeps them. One person's own concurrency stays in scope for every app: repeated
submits, two tabs or devices, background and scheduled jobs beside the UI,
parallel jobs on shared state, sync with the user's other machines, and a
restart mid-operation. A race finding names both actors and how they overlap.

The model comes from **Edit App > Workflow > Deployment model for quality
audits** (`deploymentModel` on the app record) when set, otherwise from the
app's requirements, PRD, spec, `AGENTS.md`, README and deployment config.
