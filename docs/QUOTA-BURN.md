# Quota-burn automation

**Dev Tools → Quota Burn** configures one install-wide loop for otherwise expiring subscription CLI quota. It is off by default. Enabling it permits scheduled spending on the selected families and tasks.

## How a cycle works

On the configured interval (default 30 minutes), the runner reads the enabled plan and gets zero-token quota readings. It selects an eligible family by priority and dispatches at most the first available, enabled, unspent step with pending work. It records the decision and skip reason. An unavailable reading, unknown reset, unsupported provider or unavailable task fails closed.

- The **target** window is the broadest classified period. Its reset drives `resetWithinHours`, the card's countdown and the dispatch-cap accounting key.
- The **limiting** window is the narrowest period. Its reset backs a denial when the provider supplies no better reset.
- The **tightest** remaining allowance governs the reserve, so every window must keep at least the configured `reservePercent`.

A cap of `-1` is unlimited. Positive caps of 1–50 include in-flight reservations, and usage is tallied even when uncapped. Disable a family to prevent automatic dispatch.

## Observed refusals

A structured subscription refusal from a burn-dispatched agent blocks that family until the reported reset, the captured limiting reset, or a five-hour fallback. A later successful burn clears the block. The completion continuation records this decision before considering its next dispatch. Transient 429s and free-text guesses do not establish a spent allowance. Usage-page free-tier counts and observed blocks come from local usage records, separate from burn admission.

## Burn steps

A step references a task that already exists in **CoS → Schedule** or a custom scheduled agent job in **CoS → System Tasks**. The referenced task retains its saved schedule and settings. A built-in reference carries a task type and, where required, an enabled managed-app target. A custom reference points to a job ID and inherits that job's scope. A step that becomes unavailable stays in the plan with a reason until corrected.

A step may override provider, model, effort and parameters for its invocation. Clearing a pin restores inheritance, and parameters merge key by key. Provider overrides must belong to the same quota family. App scope, task enablement and autonomy rules still apply. Shell/script jobs and jobs requiring approval are not burn dispatch targets. Programmatic task options live on the scheduled task. Universe bible tasks describe eligible incomplete records before requesting images. Pending render work is tracked to prevent duplicate dispatch.

Audit definitions and prompts live with Scheduled Tasks. Use each audit's `params.fileIssues` mode to choose tracker-only output or implementation. For file-only work, the normal issue filing and dispatch-label rules apply. Existing legacy task/preset conversion remains compatibility input. Add new actions to the real scheduled-task catalog.

`runOnce` spends a step on accepted dispatch, not on a pending request. **Re-arm** clears its completion marker. A normal schedule invocation does not spend a burn step.

## Charging exactly once

Programmatic work charges when the handler returns successfully. A custom job charges when a new task is persisted. Built-in tasks dispatched through the on-demand engines take a reservation until an accepted task with the same `quotaBurnRequestId` is persisted. Reservations hold cap slots and prevent duplicate dispatch. Settlement charges an accepted request once, or releases a refused one uncharged. Unreadable reservation or task data defers work. Status reads never settle reservations.

## Manual runs

**Evaluate now** bypasses the master switch with normal gates, while **Burn now** scopes that evaluation to one family. A step's explicit confirmed run bypasses window, reserve and cap gates without charging the automatic budget. The task must still be available and the controls use saved configuration.

## Storage and code

The plan, dispatch ledger, run log, in-flight work, denials, completions and pending reservations are machine-local under `data/cos/quota-burn*.json`. Provider quotas and managed app scopes belong to this install. There is no federation or default data seed for these records.

- `server/lib/quotaBurnConfig.js`, `quotaBurnValidation.js`, `quotaBurnTaskRef.js` and `quotaWindows.js` define plans, step references and window classification.
- `server/services/quotaBurnRunner.js`, `quotaBurnInvoke.js` and `quotaBurnAcceptance.js` own orchestration, invocation and charging.
- `server/services/quotaBurnDenials.js` records observed refusals. `server/lib/auditCatalog.js` owns audit task definitions.
