# Untrusted content: messages and forge automation

PortOS separates screening, constrained analysis and effectful actions. Classifier confidence and prompt delimiters do not establish trust, certify a patch as malware-free, or authorize disclosure of private records.

## Scheduled GitHub roles

| Task | Scope | Boundary |
| --- | --- | --- |
| `issue-watcher` | External issue creation/edits and outside comments, including comments on trusted issues | Complete bounded evidence, abuse screening, API analysis with no tools, exact decision IDs, fresh state checks, deterministic reply/volunteer assignment |
| `issue-reconcile` | Issues created by the operator, repository owner or write collaborators | Live author permission gate; outside discussions screened separately; screened trusted issue requirements and verified default-branch merge references reach maintenance |
| `pr-reviewer` | External PR intake and static review | Security screening, tool-free eligibility, tool-free review; server coordinator owns forge mutations |
| `pr-watcher` | Operator/owner/write-collaborator PR maintenance | Live author gate, head/update/CI activity tracking, separately screened discussion; failed screening retains the activity for retry |

Author permission is checked per repository and forge host on every gather. A `COLLABORATOR` association, label, display name, contribution history or comment claiming authority is insufficient. The authenticated account and repository owner qualify directly; other accounts require a live GitHub `write`, `maintain` or `admin` permission. Read/triage-only access and failed lookups remain external. GitHub's [repository permissions endpoint](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user) is authoritative. Comments never inherit their parent record's author trust.

The GitHub role split does not change explicitly configured Jira or existing GitLab lifecycle semantics. Legacy forge tasks that lack the current screening boundary are blocked before selecting an agent; run their schedules again to gather fresh evidence. Recognized shipped prompts upgrade by version, while customized prompts remain stored. Runtime restrictions also apply independently of prompt text.

## Three layers

1. **Screen complete accepted input.** Reject oversized content before inference rather than scanning a prefix. Deterministic hidden-content checks precede the offline Prompt Guard classifier. The classifier is required by default. Invalid policies, a broken/partial installation, malformed results and incomplete token-window coverage stop processing.
2. **Analyze without tools or private context.** `runUntrustedContentAnalysis` uses an API text completion, offers no tools or agent harness, and disables provider fallback. Private message sources require a loopback endpoint. Raw messages are not combined with digital-twin identity documents. External text is framed as evidence; framing itself is not an injection detector.
3. **Validate and authorize effects in code.** Callers supply strict response contracts and check source identities and fresh state before acting. Issue replies and assignments use known issue/comment IDs; model prose never becomes a shell command. Maintenance analysis returns only fixed enums, not a freeform model summary that could repeat an attack. Issue maintenance separately receives screened requirements authored by a trusted account and a verified merge commit on the default branch; it can inspect that accepted code without importing outside PR descriptions. Message triage remains recommendations; replies remain drafts under the existing send-authorization flow.

PR review does not execute contributor tests or apply patches in its default stages. Read-only filesystem access and a disposable worktree are not equivalent to denying tools or isolating malicious code. A provider must expose an actual maintained recipe for the requested posture; unsupported stage pins must be corrected in schedule settings. A screening pass never grants broader permissions.

## Configure an install

Open **Models > LLMs > Abuse Guard** (`/models/llms/abuse`). Install the classifier explicitly, then choose an enabled text API provider and model for shared analysis. Use a local API endpoint for private messages. The page exposes shared policy defaults and source overrides; a failed or incomplete installation offers a repair path. Opening the page and reading status never runs inference or downloads a model.

The shared settings slice is `untrustedContent`, validated on settings writes. It has `defaults` and `sources` overrides for `github-issue`, `github-pr`, `messages`, `email`, `imessage` and `signal`. Supported fields are `providerId`, `model`, `classifierMode`, `minBenignScore`, `maxInputChars` and `maxOutputChars`. Explicit provider changes clear an inherited model pin. Invalid stored settings stop processing instead of silently choosing weaker defaults.

```json
{
  "untrustedContent": {
    "defaults": { "classifierMode": "required", "minBenignScore": 0.9 },
    "sources": {
      "messages": { "providerId": "local-text", "model": "installed-text-model" },
      "github-issue": { "maxInputChars": 100000, "maxOutputChars": 16000 }
    }
  }
}
```

An explicit `optional` classifier policy allows deterministic-only screening only when the classifier has never been installed. It does not bypass an installed but broken runtime or the no-tools, privacy and output-validation controls. The shipped recommendation is `required`.

Meta's [Prompt Guard 2 86M model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M) documents multilingual detection with 512-token windows. The 22M alternative favors speed; PortOS recommends the 86M classifier for multilingual ingress. Access may require accepting the model's license and configuring a Hugging Face token. The classifier runs locally in a dedicated environment with fixed dependency versions; accepted inputs are scanned in overlapping windows. Adaptive attacks and false positives remain possible, so its verdict is only one layer.

## Adding another ingress adapter

Reuse `screenUntrustedContent` or `runUntrustedContentAnalysis` from `server/services/untrustedContent.js`, choosing the actual source key and passing complete selected evidence plus trusted task instructions separately. Supply a strict schema and an exact source-ID allowlist. Never allow content to choose its policy, provider, tools, recipient, repository, file path or action scope. Keep effectful code in the adapter, re-read the target immediately before mutation, and retain failed work for retry. Do not open or execute attachments as part of text analysis.

Message triage and replies use `email` by default. Channel-aware outreach selects `imessage`, `signal` or `email` from the actual channel. These private sources inherit the `messages` family policy before applying their own override. Declaring a source policy alone does not create a new integration or authorize sending messages.

## Relevant code

- `server/lib/untrustedContent.js`: schemas, policy precedence, source privacy and prompt framing.
- `server/services/untrustedContent.js`: shared screening and constrained analysis.
- `server/services/forgeActorTrust.js`: live repository authority.
- `server/services/forgeMaintenanceEvidence.js`: full discussion reads and enum-only maintenance evidence.
- `server/services/messageEvaluator.js`: triage recommendations and reply drafts.
- `server/services/modelAbuseGuard.js` and `scripts/run_prompt_guard.py`: passive readiness, explicit install/scan, offline classification.
- `client/src/components/models/ModelAbuseGuardPanel.jsx`: install/repair and source-policy settings.

Remediation plans: [#6255](https://github.com/atomantic/PortOS/issues/6255), [#6256](https://github.com/atomantic/PortOS/issues/6256), [#6257](https://github.com/atomantic/PortOS/issues/6257), [#6258](https://github.com/atomantic/PortOS/issues/6258).
