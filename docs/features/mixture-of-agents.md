# Mixture of Agents (MoA) presets

A Mixture of Agents preset is a named group of 1–5 **reference models** (advisors) and one **aggregator** model. The reference models answer the same request in parallel, tool-free. The aggregator then writes the final answer with their perspectives appended as a trailing advisory block. Presets are edited under **Models → Providers → Presets → Mixture of Agents** (`/ai/presets`, editor at `/ai/presets/moa/:id`).

## Selecting a preset

A preset is a virtual provider addressed as `moa:<presetId>`. Every caller that resolves a provider through `promptRunner.resolveProviderAndModel` or Ask's provider selection accepts it, and `runPromptThroughProvider` dispatches the `type: 'moa'` record to `server/services/moaRunner.js`. Every other run path refuses the unknown type, so a preset never reaches a CLI or TUI spawn. MoA runs only when a user or a user-configured job selects it. It makes no cold-bootstrap calls.

## Persistent Mind

A Persistent Mind thinking preset (and the home profile) may name `moa:<id>` with the aggregator's model and no effort pin. `resolveExactRoute` in `server/services/persistent/persistentMindProfile.js` resolves it live and refuses a missing preset, an aggregator that cannot run, any other model, or an effort pin. Advisors that cannot run are dropped at run time. Every member is an API provider, so the route passes the mind's tool-free check. Image turns are refused, and the mind's local prompt budget does not apply, because a preset has no single endpoint.

## Members

- Every member must be an **enabled API provider** that is not itself an MoA preset. `moaValidation.js` refuses a `moa:` member structurally, and `lib/moaConfig.js#moaMemberRefusal` checks live eligibility on save and again on every run.
- A reference model may set `temperature`. Every advisor is capped at the preset's `advisorMaxTokens`.
- The aggregator is the **acting, billed run**. Each reference model is billed as its own run.
- `enabled: false` skips the advisors and runs the aggregator alone.

## Execution

1. Advisors run concurrently as bounded completions that share one abort signal. If the caller aborts, or the user stops **any** advisor's run, every in-flight advisor is cancelled and the aggregator never starts.
2. A failed, timed-out or ineligible advisor is recorded and dropped. Only an aggregator failure fails the run. If no advisor answers, the aggregator gets the caller's prompt unchanged.
3. The aggregator runs in the caller's shape: a bounded completion with the same signal, or the streamed path with the caller's options, pinned to the preset's model (`allowFallback: false`). Image inputs are refused.
4. A caller's `beforeExecute` admission gate runs before every member's dispatch; a refusal stops the whole run. A caller stall bound of `0` (no timeout) never becomes an advisor's deadline: advisors fall back to their provider's timeout.

## Prompt caching and transparency

The caller's prompt is the byte-identical **prefix** of every advisor and aggregator request. The advisory block (`<moa-advisory …>`) and a fixed instruction are the **tail**, so a provider's prompt cache keyed on the stable prefix still hits. Each request is a single user message, so strict alternating chat templates (llama.cpp, vLLM) never see adjacent user turns.

Both fixed instructions are shown verbatim in the editor (from `GET /api/moa-presets`). Each run record in Run History stores the exact prompt that was sent. After the runs settle, each record's metadata carries `moa`: advisors have `role: 'reference'` and `parentRunId` (the aggregator's run), and the aggregator has `role: 'aggregator'` and its reference outcomes.

## Privacy filter

| `privacyFilter` | Effect |
|---|---|
| `off` | Advisor text is shown and injected as written |
| `display` | Advisor text returned for display (`result.moa.references[].text`) is scrubbed of credential-shaped tokens (`secretText.js`) and delimited PII (`piiRedactionPatterns.js`); the aggregator still receives it raw |
| `full` | Also scrubbed before injection; the aggregator's recorded prompt shows exactly what it received |

## Storage

`data/moa-presets.json`, `file-primary`, machine-local and never federated: members name this install's provider ids. The HTTP contract is in [API.md](../API.md) (`/api/moa-presets`).
