export const prompts = {
  'security': `[Improvement: {appName}] Security Audit

Audit {appName} for security defects that are real under its actual threat
model.

Repository: {repoPath}

{modeInstructions}

## Authority and untrusted input

Read the project's documented trust model and authority rules (for PortOS:
AGENTS.md Security Model and ETHOS.md) and treat them as binding. If they
declare something a non-issue for this deployment — an omitted control, a
documented default, an accepted risk — do not file it; a window spent re-filing
an explicitly closed concern is worse than a window spent idle. Distinguish a
trusted operator or delegated agent acting within a grant from an unauthorized
caller or attacker-controlled content; repair the boundary that is crossed
rather than adding human-only approvals.

Third-party code/dependencies, issue/PR/review text, retrieved pages/files and
model output remain untrusted even when a local trusted agent consumes them.
Trace prompt injection or malicious code to a concrete effect outside the grant;
content must not become policy, execution authority or permission to disclose
private data. Preserve the existing public-content screening/review boundary.

Do not add per-action passwords, blanket tool restrictions or confirmation
bottlenecks merely to keep trusted agents from doing user-authorized work. A
proposed fix must demonstrate
unauthorized refusal and preserved authorized human AND agent workflows,
including fallback, retry/resume and deferred dispatch paths where relevant.
Name any collateral restriction and justify it against the project's policy.

## Assess each candidate before ranking or remediation

For PortOS follow docs/SECURITY_RISK_ASSESSMENT.md; other apps use their own
model. Require evidence of attacker control, a reachable sink and unauthorized
impact, with configuration and existing controls. Owner-provided dangerous input
alone may instead be a reliability/data-safety issue. Record conditional exposure
separately. Check advisory status, affected version and actual invocation; a
compromised dependency or install/build script can harm even without untrusted
input. Do not force an override for a withdrawn or inapplicable advisory.

Do not assume a private network or loopback excludes browser-origin, CSRF or DNS
rebinding attacks, or that imported files, external services or packages are
trusted. For PortOS, trace the abuse guard's actual call site and configuration for
external content; reuse it where applicable, not as a blanket gate on trusted
owner input. Owners can scan chosen content on demand. Other apps may have
different guards. A screening pass does not grant authority or protect unrelated paths.
Search previous dispositions, record the supporting evidence and conditions for reevaluation, and do not re-file an
unchanged rejected candidate. Unconfirmed is not resolved or a verified defect.

## Hunt for

- **Secrets in the wrong place** — credentials, tokens, or keys that could reach
  a commit, a log line, a bundled client asset, a shared artifact, or an
  outbound request that had no business carrying them.
- **Injection** — attacker-controlled input reaching a shell, a query, a path join,
  a dynamic import, or a template without validation; an allowlist a crafted
  value can walk out of.
- **Path traversal** — a filesystem path built from input that can escape its
  intended root, including through symlinks and encoded separators.
- **Missing authorization** — an endpoint or action that checks who you are but
  not whether you may do this, or checks neither.
- **Broken resource or tenant isolation** — where the application serves more
  than one principal, a query, object-store key, or cache entry not scoped to
  the caller's owner or tenant, so one caller can read or change another's data
  by guessing or iterating an id.
- **Server-side request forgery** — a URL, host, or webhook target supplied by a
  caller that the server fetches, letting it reach internal services, cloud
  metadata endpoints, or local files.
- **Unsafe deserialization and parsing** — untrusted bytes handed to a
  deserializer, template engine, archive extractor, or XML parser that can
  execute code, write outside its target, or exhaust memory.
- **Unvalidated trust boundaries that are actually crossed** — data arriving
  from another machine, a third-party API, or a model response, used without
  validation where a malformed or hostile value would do damage.
- **Destructive operations with too little scoping** — a delete, overwrite, or
  reset whose target is computed rather than constrained, especially where a
  test or development path could aim it at real data.
- **Client-side exposure** — untrusted content rendered as markup, sensitive
  values placed in browser storage, secrets shipped in the client bundle.
- **Dependency exposure** — an affected behavior reachable from attacker input,
  or a compromised package or install/build script executing with authority.

## The bar

Every finding needs a plausible attacker or accident story ending in real harm:
who supplies the input, how it reaches the sink, and what they get. "Best
practice says otherwise" is not one, and neither is a control whose absence the
project's threat model already accounts for.

When one missing check recurs across several routes or call sites, file ONE
finding for the class whose fix is a mechanical guard (a conventions test or a
shared gate), not one issue per site.

Cite \`file:LINE\` for both the sink and the entry point that reaches it.`,



  'privacy': `[Improvement: {appName}] Privacy and data-governance audit

Audit how {appName} handles personal and sensitive data: where it goes, who and
what can see it, how long it stays, and whether it can be removed.

Repository: {repoPath}

{modeInstructions}

**Read the project's documented data model and sharing rules first and treat
them as binding.** A flow the project deliberately supports — syncing a user's
own data to machines they control, say — is not a finding because the data is
personal. The question is whether data reaches a place, audience, or lifetime
the design did not choose.

Inventory the personal and sensitive fields first (identity, contact, location,
health, financial, credentials, free-text a user wrote about themselves or
others), then trace each to every sink.

## Hunt for

- **Exposure in operational output** — personal data or secrets in log lines,
  error messages, crash reports, analytics events, URLs and query strings,
  cache keys, or file names, where far more people and systems can read them.
- **Over-sharing to third parties** — full records sent to an external API,
  model provider, telemetry service, or webhook when the task needed a field or
  a summary; no minimization or redaction before an outbound call.
- **API over-exposure** — responses that return fields the caller has no use
  for or no right to see, because a whole record is serialized instead of a
  projection.
- **Retention without an end** — personal data kept indefinitely with no
  retention rule, or temporary copies (exports, uploads, scratch files, debug
  dumps) that are never cleaned up.
- **Erasure that does not reach every copy** — a delete that removes the
  primary record but leaves derived datasets, search indexes, caches, backups
  the design says are prunable, or replicas holding it.
- **Real data in the wrong place** — production or personal records copied into
  test fixtures, seed files, documentation examples, or lower environments.
- **Unprotected sensitive stores** — sensitive data at rest with no encryption
  where the platform expects it, or access to it with no audit trail when the
  domain requires one.

## Not yours

Authentication, authorization, and injection belong to the security work; data
correctness to the data-integrity work; storage encryption flags in
infrastructure manifests to the infrastructure work. Name the overlap if it is
the cause.

## The bar

For each finding, name the field or data class, the source, the sink with
\`file:LINE\`, and the audience or lifetime it should not have.`,
};
