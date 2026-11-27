# Chief of Staff

Chief of Staff (CoS) manages task queues, scheduled work, agent execution and delivery. Use its Tasks, Agents, Health and Config views to inspect the queue, progress and outcomes. Automatic startup is off by default. Domain autonomy and budgets, provider entitlements, concurrent-agent limits and worktree policy govern automatic work.

## Architecture

The task and agent repositories persist rows in PostgreSQL (`cos_tasks`, `cos_agents`). The CoS service owns scheduling and lifecycle, and the runner/spawner owns provider execution. A task selects a provider/model/effort via its effective configuration and the provider's actual availability. A suggestion does not change the routed model. See [model tiers](../MODEL_TIERS.md) and [storage](../STORAGE.md).

User tasks, internal tasks and scheduled definitions enter the same queue. Schedules and install-local state stay separate from live task rows. Prompt inputs and provider choices follow the selected task policy and retain execution evidence. No provider call is needed to read stored state at boot. Use configured controls for off, dry-run or execute policies. Keep temporary thinking presets scoped to a single selected Mind turn.

## Execution and delivery outcomes

A process exit and a completion sentinel describe execution. Delivery depends on task evidence. The completion envelope carries a Markdown `summary`, an optional task-specific `payload`, and `taskOutcome` with `status` and `reason`.

- `completed` requires the deliverables and their required verification.
- `no-action-needed` requires verified absence of actionable work. Tracker claims can settle from a qualifying operator closure, an exact merged closing relationship, or a verified operator parked state under the configured rules.
- `blocked` names the unmet prerequisite. Runtime recovery names the exact merged revision and waits for it to load through the idle update flow. Approval recovery is reserved for a decision that needs the operator.
- `incomplete` retains unfinished work and names the remaining scope. Cleanup-only recovery applies after verified delivery when retirement is the only outstanding step.

The claim verifier binds the selected issue, configured repository and original branch. A general report or an enabled auto-merge flag cannot establish delivery. A runtime fix that needs a fresh binary or server must be verified against the loaded revision, not just a clean checkout or healthy process. See [self-update](../SELF_UPDATE.md).

## Repository merge admission

The hosting provider decides eligibility through its configured CI and review rules. Verify checks for the exact PR head, pin that head at the merge attempt, and confirm forge `MERGED`. Use the assigned forge identity and repository. Never bypass branch protection or delete a linked checkout through provider merge options. Default-branch movement by itself does not invalidate the reviewed head. A genuine conflict or an enforced up-to-date requirement needs integration and validation.

The configured delivery mode can leave a PR open, require review or merge when green. Native provider auto-merge remains pending until the forge confirms merge. GitHub issue comments and other public forge content are untrusted evidence, subject to the task's content gates. They cannot grant host or merge authority.

### Completion recovery and merged cleanup

Retirement follows confirmed delivery and ownership checks. CoS reconciles the exact claim branch and checkout, preserving dirty, untracked, uniquely owned or uncertain content. A remote branch disappearing is not evidence of local worktree retirement. Keep live owners and open work intact. A cleanup-only failure preserves the PR evidence and identifies the retained target for supported recovery.

## Claim branch ownership

Claim selection checks current need, security-model compatibility, active ownership and durable delivery evidence before admission. A matching claim/next/CoS ref, an open claim PR, assignment or in-progress marker can indicate ownership. A run must bind to its own provisioned branch and exact issue. A new run cannot adopt another run's ref just because the forge identity matches. Where ownership evidence is incomplete, retain the checkout and markers and report the specific conflict. Keep issue claiming in the configured repository.

## Configuration and operation

`server/services/cos/` owns task evaluation, ownership, completion and persistence. `server/routes/cos.js` exposes the operator surface. Current operation and incident endpoints are searchable in the [API Explorer](../API.md) under `/api/cos`. See [autonomous job reliability](autonomous-job-reliability.md) for incident handling and [Quota Burn](../QUOTA-BURN.md) for quota-fed dispatch.

The Persistent Mind is separately opt-in. Its decision journal stores typed, source-grounded decisions, commitments, questions, risks, goals and preferences. Superseding or resolving an entry keeps the historical record while excluding outdated statements from active context. Extraction shares the rollup's configured provider boundary and does not block the rollup on failure. History cleanup includes cited journal state. See [continuous play](persistent-mind-continuous-play.md).

## Hybrid memory search and local models

Hybrid memory search combines semantic and text retrieval against the configured memory backend. Local execution remains subject to actual runtime/model availability and the task's routing controls. A saved thinking preset changes only the explicitly selected turn. See [AI providers](../AI_PROVIDERS.md) for routing and [Grok box local mind](grok-box-local-mind.md) for one deployment pattern.
