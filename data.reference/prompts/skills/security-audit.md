# Security Audit Skill Template

## Routing

**Use when**: The task requests a security audit or investigation of a vulnerability, injection, authentication, authorization, permissions, secrets or exposure.
**Don't use when**: The task is ordinary code quality, performance work or a feature unrelated to security.

## Task-Specific Guidelines

### 1. Establish the actual threat model

- Read the target repository's `AGENTS.md`, security model and relevant decisions first; for PortOS, also read `ETHOS.md`. Their accepted risks and deployment assumptions govern this audit. A managed app can have a different model from PortOS itself.
- Identify the attacker, credential or capability they possess, reachable entry point, required configuration and harmful sink. Distinguish source tracing, synthetic reproduction and a demonstrated exploit; never present a mocked provider dispatch as proven command execution.
- Separate unauthorized callers from agents operating within an existing grant. For PortOS, verified owner sessions include delegated `PORTOS_API_TOKEN` agent sessions; genuine local connections qualify when authentication is disabled. Scoped federation credentials and remote password-free callers do not grant host authority. Legacy Basic holders already know the instance password and can sign in for a session; direct Basic refusal is credential-use policy, not isolation from that password holder.
- Do not file a missing control solely because a generic checklist recommends it. PortOS's documented CORS, rate-limit and multi-tenant exceptions are not findings by themselves. Existing browser-relay, authentication and host-control checks still matter when a concrete path bypasses them.

### 2. Trace the boundary and preserve the workflow

- Inspect input validation, path/symlink containment, query and shell construction, secret handling, socket events and effective provider transport where relevant to the chosen slice.
- Follow fallback, resume/retry, queue and background paths through actual dispatch. A selected inference API may fall back to a tool-capable agent. A working directory, prompt fence or later render sandbox does not contain an earlier host agent.
- Prefer the smallest fix that refuses unauthorized effects while preserving granted capabilities and configured provider choices. Do not globally disable agent tools, require human approval or add per-action passwords to repair a missing network authorization check.
- In PortOS Music Video, configured authenticated agents may create, review art/storyboards/proofs, resolve feedback, render and prepare final drafts without human intervention. Creative review requires exact revisions, genuine inspection evidence and audit identity. The human-only media action is public Suno publication or social-media posting; private draft preparation and final-file rendering are not publication.
- Preserve provider permissions, quotas and budgets. A workflow grant does not authorize unrequested purchases or spending beyond configured limits.
- Name any collateral restriction explicitly. Gating a deterministic or provably inference-only branch can be a deliberate policy choice; it is not evidence that the branch executes host tools. If a branch remains open, prove that fallback and deferred work cannot escape that boundary.

### 3. Report actionable findings

For each finding, include:

- **Evidence**: Entry and sink file/line references, current revision and relevant existing issues or fixes.
- **Threat and prerequisites**: Caller authority, configuration, required state and plausible harm. Qualify severity accordingly.
- **Validation and limits**: What ran, what was mocked, and what remains source-traced. Use synthetic data; never expose real credentials, private records or machine identity.
- **Chosen fix**: A concrete, bounded implementation with explicit allowed workflows and any compatibility or policy tradeoff.
- **Regression checks**: Unauthorized refusal before effects and successful authorized operation, including authenticated agents, plus materially different fallback/deferred paths. Preserve separate revision, evidence, budget and publication checks.

### 4. Respect the requested delivery scope

- A read-only audit does not authorize code changes, issue edits, credentials, live-data mutations or external posts. Follow the active task's instructions.
- During authorized remediation, fix bounded defects and capture deferred work through the owning repository's issue conventions. Severity does not independently expand authorization.
- Review the final diff for workflow regressions and sensitive content, run appropriate checks, and report the remaining limitations. Use the repository's commit and PR conventions.

## Example: Host authority without a supervision gate

A password-free remote caller can trigger an enabled coding agent through a media-authoring route. A synthetic mounted test proves dispatch is reachable; actual destructive model behavior is not executed. Add the existing host-authority gate before record/queue/provider effects and test refusal for unauthorized callers. Verify that a delegated agent session, an ordinary owner session and genuine local password-free access retain generation with the same provider choices. Creative review keeps its revision and evidence checks; final public Suno publication and social posts stay human-only.
