# Jev for the PortOS voice agent

PortOS can use its own Jev service as an optional, bounded action selector inside the voice pipeline. The recommended next experiment is local semantic navigation over a small candidate set. Keep deterministic navigation first and retain the existing conversational model for uncertain choices, argument generation, and multi-step reasoning. Do not replace the whole voice stack or adopt the hosted browser agent wholesale.

This is a source-based feasibility assessment, not an approved implementation plan or a latency benchmark. No models were installed, provider calls made, or live personal records inspected. Reviewed on 2026-09-30 against PortOS `0aa5f3911` and upstream `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`.

## What upstream actually supplies

[Jev Ultrafast](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46) is an MIT-licensed Python browser orchestration example. It uses Browser Harness to observe controls and execute browser interactions. It is not a speech system, and its repository does not supply the hosted Jev model weights.

Its [model adapter](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/model.py) sends structured page state, goals, recent actions, and operation-specific target choices to TypeSafe's hosted `/v1/systemone` API. One request asks both which operation to perform and which compatible target each possible operation would use. Only the selected operation's target can execute. A separate OpenAI-compatible generative model supplies free-form field text.

The [agent loop](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py) consumes a decision before mutation, reobserves stale pages, bounds actions and model requests, and stops repeated non-progress. These are useful design patterns. Choosing `DONE` is not independent proof of task success.

The upstream [performance report](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/docs/performance.md) reports a 7.073-second Flights demonstration and 178 ms median hosted Jev request latency. Setup, initial navigation, and independent final verification are outside that timing. Three matched pairs on one task are insufficient to predict PortOS performance. The reported text-helper charge excludes TypeSafe and browser costs. Supported DOM interactions also exclude frames, shadow roots, canvas, uploads, and several complex widgets.

## What PortOS already has

| Boundary | Existing implementation | Consequence |
| --- | --- | --- |
| Fast voice routing | `client/src/services/voiceFastPath.js`: deterministic navigation, optional browser Nano, server fallback | Preserve successful exact navigation; adding inference there can only add latency. Dictation and confirmation follow-ups already bypass the fast tiers. |
| Voice orchestration | `server/services/voice/pipeline.js`: STT/text input, session state, tool loop, TTS, cancellation, UI acknowledgements | Insert a bounded decision stage into this workflow, not a second independent agent. |
| Tool execution | `server/services/voice/tools.js` and `tools/ui.js` | Reuse `dispatchTool`, navigation resolution, existing UI references, confirmation flow, and server-derived host-control authority. |
| Local closed-set inference | `server/services/jev.js`, `server/lib/jev.js`, `scripts/run_jev.py` | Pinned OpenJEV Qwen3.5 4B NLI; offline local process, separate from chat providers. |
| Decision definitions and training | `server/lib/jevDecisions.js`, `scripts/train_jev_head.py` | Existing closed-set contracts and optional trained heads are reusable infrastructure, not evidence of voice accuracy. |

PortOS's [existing Jev decision](../decisions/2026-09-18-local-jev-decision-service.md) deliberately keeps inference machine-local and allows abstention. Its NLI output measures each premise/hypothesis pair independently; those entailment scores are not the upstream API's normalized distribution over choices. No adapter should relabel one as the other or assume equal model quality.

The local runner performs one forward pass per hypothesis, including the trained-head path's frozen encoder work. One HTTP call with many hypotheses therefore does not reproduce upstream's computational fan-out. Current bounds are 32 hypotheses and 32,000 premise characters; `decide` needs at least two choices. Default margin is 0.15, with no absolute-confidence floor. Voice needs held-out calibration of both margin and a winner floor, plus an explicit unsupported alternative, because every offered action can be wrong.

The weights alone are about 9.08 GB; runtime memory is additional. Cold start may wait up to five minutes, scoring defaults to 30 seconds, and idle unloading happens after ten minutes. `scoreHypotheses` accepts a timeout but no caller AbortSignal; `decide` exposes neither. These are existing general-purpose service contracts, not interactive latency guarantees. A voice adapter must bypass cold/unready inference, enforce its own turn deadline, and discard late results. Future cancellable scoring must address pending startup and server work as well as the HTTP wait; racing a promise alone does not stop inference.

## Recommended integration

1. Keep the current deterministic client fast path. Route confirmation, dictation, and other server-owned state through their existing handlers before considering Jev.
2. Start with semantic navigation only, after exact matching misses. Build a small candidate set from the canonical navigation manifest and current feature visibility. Represent each permitted destination as a plain-language hypothesis. If retrieval cannot confidently retain the intended destination, fall back instead of forcing a winner.
3. Let local Jev choose from this bounded set plus an unsupported alternative. Map the accepted hypothesis back to a trusted manifest identifier. Abstention, low confidence, unavailable runtime, deadline expiry, unsupported intent, or malformed output all use the existing pipeline. The model never supplies an executable route, selector, JavaScript, or shell command.
4. Dispatch through the existing voice tools and speak a deterministic acknowledgement only after the relevant success evidence. Preserve the existing distinction between a queued side effect and an acknowledged UI change. Barge-in invalidates the turn and any late decision; a timed-out action with unknown outcome is not automatically replayed through fallback.
5. Only after navigation succeeds in evaluation, consider operation-specific UI targets. Bind each decision to the observed target identity and turn/page state, validate compatibility and freshness immediately before execution, and keep existing destructive-action confirmation and host-control checks. Speculative target selection is computation only; it must never dispatch unselected actions.
6. Retain the configured local generative model for speech replies, free-form values, retrieval synthesis, and longer plans. Jev cannot transcribe audio, synthesize speech, or invent safe tool arguments. Copying an explicit dictated string can be deterministic; composing a message still needs generation.

This keeps PortOS on its private network and avoids an additional Chrome debugging service for controlling its own UI. Browser automation may be useful for a separately scoped external-site task, but is unnecessary for PortOS's existing domain tools. The hosted upstream default would transmit page content and goals externally and conflicts with the current local Jev boundary; it is not a drop-in configuration option. No tunnel or public PortOS endpoint is needed.

## Experiment and adoption gates

Use fabricated utterances and fixture UI state, with held-out paraphrases separated from calibration examples. Compare the current pipeline, the same pipeline with local Jev, and a small local generative selector if already available. No boot-time fill, automatic download, personal transcript collection, or provider benchmarking should be introduced by this research note.

Measure at 2, 8, 16, and 32 candidates: cold availability, warm decision p50/p95, memory, fallback rate, accepted-choice precision, verified task success, and end-of-utterance to first audible response. Include STT, queueing, fallback overhead, tool acknowledgement, and TTS separately. Measure under concurrent STT/TTS load, not only isolated classifier calls. A smaller trained head still runs the encoder; only measurements can show savings.

Exercise negation, unsupported requests, similar labels, disabled features, missing targets, changed pages, confirmation follow-ups, dictation, scorer failure, and cancellation during inference. Assert that stale/late choices produce no effects and fallback cannot repeat an action whose outcome is unknown. Use existing public pipeline/UI test boundaries for these regressions.

Proposed experimental gates, not measured capabilities: cap warm navigation scoring at 250 ms; require at least 99% precision on accepted held-out navigation choices, no forbidden or stale actions in the adversarial fixtures, and improved end-to-end p95 without reducing task success. Report sample counts and uncertainty, not just percentages; a small fixture pass cannot justify broad rollout. If inference misses the budget or abstains too often, keep deterministic matching plus the current LLM. Investigate a smaller classifier or batching only if profiling identifies an actual payoff.

The implementation decision is therefore conditional: reuse the local Jev abstraction and upstream's bounded selection patterns for an opt-in experiment; do not promise an ultrafast voice agent from repository branding or browser-demo timings. Runtime integration and performance tuning remain outside this research change.
