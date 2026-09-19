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

1. **Screen complete accepted input.** Reject oversized content before inference rather than scanning a prefix. Deterministic hidden-content checks precede the offline Prompt Guard classifier: invisible/direction-control Unicode (including filenames), HTML comments and collapsed markup (`hidden`, `aria-hidden`, `display:none`) that address a model, encoded/compressed payloads, a new symlink that leaves the tree or a new git submodule, a non-media binary patch, and inline script in SVG/HTML. PR review also screens commit messages with the same title/body/diff pass. The classifier is required by default. Invalid policies, a broken/partial installation, malformed results and incomplete token-window coverage stop processing.
2. **Analyze without tools or private context.** `runUntrustedContentAnalysis` uses an API text completion, offers no tools or agent harness, and disables provider fallback. Private message sources require a loopback endpoint. Raw messages are not combined with digital-twin identity documents. External text is framed as evidence; framing itself is not an injection detector.

   **Optional phase-2 reasoner: the local jev entailment scorer.** Where the required answer is one of a fixed set of options rather than prose, `server/services/jev.js` can answer it locally with no provider call, no generated text, and no tool surface — and it **abstains** when the top two options are too close to separate. It is off by default, installs its own pinned model, and is never selectable as a chat provider. It does not replace layer 1: Prompt Guard still screens the content before anything, including jev, reasons over it. See [JEV_SETUP.md](../JEV_SETUP.md) and the ADR [local jev decision service](../decisions/2026-09-18-local-jev-decision-service.md).

   **The fallback ladder.** Three rungs, in this order, per source:

   ```
   screenUntrustedContent()        ← layer 1, Prompt Guard. Always. Unchanged.
     ↓ safe
   jev decision                    ← optional. Abstains rather than guessing.
     ↓ abstained / unavailable / off
   runUntrustedContentAnalysis()   ← the chat completion above, unchanged.
   ```

   `jevMode` picks what happens on each source:

   | `jevMode` | Behavior |
   |---|---|
   | `off` | The shipped default. The chat model answers every question, exactly as it did before jev existed. If the scorer is installed, PortOS still asks it the same question afterwards and records whether it agreed — see *Measuring before you switch*. |
   | `prefer` | The scorer answers first; an abstention or an unavailable scorer falls through to the chat model. |
   | `only` | The scorer answers first, and an abstention **skips the item** with a recorded reason rather than spending provider quota. A skipped item is never recorded as `none`, `defer` or `allowed` — "cannot tell" must stay distinguishable from a verdict. |

   Every caller keeps the same Zod contract either way: jev either produces a value that satisfies it or produces nothing. The hypothesis wording for each decision lives in `server/lib/jevDecisions.js`, with a per-decision abstention floor and a higher per-OPTION floor on the choices that throw something away or release a task (`delete` on a message, `inspect-trusted-change` on a maintenance discussion). `jevMinMargin` can only **raise** those floors, never lower one.

   **Measuring before you switch.** While a source is `off` and the scorer is installed, PortOS asks it each closed-set question after the chat model has answered, discards the answer, and folds the comparison into per-decision counters shown in **Models > LLMs > jev**. The counters are counts only — decision id, which bucket it landed in, and whether it agreed. No premise, message body, comment or diff is recorded, and neither side's verdict is kept.

   **Which decisions are routed.** The issue-watcher reply gate (`reply` / `none`), message triage (action and priority, as two independent decisions over one premise — one abstention retires the whole message), and the forge-maintenance disposition. A jev `reply` verdict still wakes the chat model to write the body; the gate only decides whether waking it is worth it. Stacker News is **not** routed: `server/services/stackerNews.js` does not call `screenUntrustedContent` at all, so routing it today would hand unscreened text to the scorer.
3. **Validate and authorize effects in code.** Callers supply strict response contracts and check source identities and fresh state before acting. Issue replies and assignments use known issue/comment IDs; model prose never becomes a shell command. Maintenance analysis returns only fixed enums, not a freeform model summary that could repeat an attack. Issue maintenance separately receives screened requirements authored by a trusted account and a verified merge commit on the default branch; it can inspect that accepted code without importing outside PR descriptions. Message triage remains recommendations; replies remain drafts under the existing send-authorization flow.

PR review does not execute contributor tests or apply patches in its default stages. Read-only filesystem access and a disposable worktree are not equivalent to denying tools or isolating malicious code. A provider must expose an actual maintained recipe for the requested posture; unsupported stage pins must be corrected in schedule settings. A screening pass never grants broader permissions.

PR review stage provider/model pins are strict: disabled, unsupported or unavailable selections stop the review rather than switching to a subscription provider or a different model. Local classifier setup/runtime failures and review provider/model failures raise a notification and queue a deduplicated CoS investigation. Investigation prompts contain only server-owned diagnostics, never contributor text, model output or transport errors. A malicious-content finding is not an infrastructure incident.

The PR page follows the saved stage providers by default. Its **Use Run with for PR review eligibility** checkbox explicitly overrides only the eligibility stage for that invocation; the final review keeps its own stage settings. Stage-specific settings take precedence over broader schedule/app defaults. The shared Abuse Guard text API selection does not replace these PR stage selections: Stage 1 always uses the dedicated local classifier, while stages 2 and 3 use the providers configured in **CoS > Schedule > PR Reviewer**.

After an approval, the deterministic coordinator merges a green, mergeable PR or requests GitHub auto-merge while CI is pending. The enable-only GraphQL mutation names the reviewed head SHA, so it cannot authorize a different commit or immediately bypass pending checks on an unprotected repository. A rejected auto-merge request raises a notification and retains the approval for the existing bounded merge poller.

## Configure an install

Open **Models > LLMs > Abuse Guard** (`/models/llms/abuse`). Install the classifier explicitly, then choose an enabled text API provider and model for shared analysis. Use a local API endpoint for private messages. The page exposes shared policy defaults and source overrides; a failed or incomplete installation offers a repair path. Opening the page and reading status never runs inference or downloads a model.

The shared settings slice is `untrustedContent`, validated on settings writes. It has `defaults` and `sources` overrides for `github-issue`, `github-pr`, `messages`, `email`, `imessage` and `signal`. Supported fields are `providerId`, `model`, `classifierMode`, `minBenignScore`, `maxInputChars`, `maxOutputChars`, `jevMode` and `jevMinMargin`. Explicit provider changes clear an inherited model pin. Invalid stored settings stop processing instead of silently choosing weaker defaults.

```json
{
  "untrustedContent": {
    "defaults": { "classifierMode": "required", "minBenignScore": 0.9 },
    "sources": {
      "messages": { "providerId": "local-text", "model": "installed-text-model" },
      "github-issue": { "maxInputChars": 100000, "maxOutputChars": 16000, "jevMode": "prefer" }
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
- `server/lib/jev.js`, `server/services/jev.js` and `scripts/run_jev.py`: the optional local entailment scorer — pinned contract, sidecar lifecycle, and the abstaining `decide()`.
- `server/lib/jevDecisions.js`: the frozen hypothesis sets and abstention floors for every routed decision.
- `server/services/jevRouter.js`: the jev rung — mode resolution, one consultation, and the counts-only agreement store (`data/local-llm/jev-shadow.json`).

Remediation plans: [#6255](https://github.com/atomantic/PortOS/issues/6255), [#6256](https://github.com/atomantic/PortOS/issues/6256), [#6257](https://github.com/atomantic/PortOS/issues/6257), [#6258](https://github.com/atomantic/PortOS/issues/6258).
