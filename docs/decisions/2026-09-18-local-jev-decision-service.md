# ADR: Closed-Set Decisions Run on a Local Entailment Model That Abstains

- **Date:** 2026-09-18
- **Status:** Accepted
- **Related:** epic #7640 (the decision-primitive epic), issue #7641 (this record,
  the substrate), #7642 (switching callers), #7643 (training a head),
  [`server/lib/jev.js`](../../server/lib/jev.js),
  [`server/services/jev.js`](../../server/services/jev.js),
  [`scripts/run_jev.py`](../../scripts/run_jev.py),
  [`docs/JEV_SETUP.md`](../JEV_SETUP.md),
  [`docs/features/messages-security.md`](../features/messages-security.md).

## Context

PortOS had no way to ask a local model a **closed-set question**. Every decision
over untrusted external text went through `runUntrustedContentAnalysis`
(`server/services/untrustedContent.js`), which is a generative chat completion —
even when the required answer is one of two fixed tokens.

Using a generative model for a two-way classification is wrong in three
independent ways, and they compound:

- **It spends what it does not need.** Every `reply | none` question costs a
  provider call, a quota unit, and a round trip, on a decision that needs no
  prose.
- **It cannot report its own uncertainty.** A chat model asked to pick one of
  two options picks one. There is no calibrated quantity in the response that
  distinguishes "the text clearly warrants a reply" from "the model had to say
  something." An unreliable answer and a confident one look identical at the
  call site.
- **It widens the blast radius of untrusted input.** The decision path runs a
  general-purpose instruction-following model over attacker-influenced text.
  Prompt Guard screens that text first, but a classifier boundary is narrower
  than a generative one by construction: a cross-encoder has no instructions to
  follow.

This ADR is also the first record under `docs/decisions/` covering **local-model
usage and AI provider selection at all** — there was none, so every one of these
questions was re-derived per review.

## Decision

**A closed-set question is answered by a local entailment model that is allowed
to refuse to answer.**

Concretely, four commitments:

### 1. The engine is a pinned, ungated NLI cross-encoder

`AlexWortega/openjev`, subfolder `qwen3.5-4b-nli`, revision
`f8187e6e11d413d0771bcc7970b85f78e194264c` — MIT, ungated,
`Qwen3_5ForSequenceClassification`, three labels (`contradiction`, `entailment`,
`neutral`). It is loaded offline through `transformers` with
`local_files_only=True`, `trust_remote_code=False`, `use_safetensors=True`, and
a required-file allowlist that pins **four files inside one subfolder**. The
repository also carries a 35B MoE variant, trained MLP heads, and a `code/`
directory; none of those are ever downloaded and none are ever executed.

Three alternatives were rejected in #7640:

- **A prompted local chat model** (Ollama/LM Studio). Cheaper to build — it
  reuses an installed model — but it reproduces the calibration problem exactly:
  the output is still generated text, and a log-prob over a single token is not
  the same quantity as an entailment probability. It would also have re-created
  the instruction-following surface this decision exists to remove.
- **A cloud classification endpoint.** Fastest to ship and needs no local
  runtime, but the premise IS the untrusted external text, often quoted
  alongside the operator's own records. Sending it off the machine per decision
  contradicts the machine-local constraint below, and it re-introduces the quota
  cost the local path exists to eliminate.
- **A trained-from-scratch head on an existing embedding model.** Cheapest at
  inference, and PortOS already runs embeddings — but it needs labelled data
  PortOS does not have, and a head trained on one install's records is exactly
  the artifact the privacy constraint forbids sharing. That path is not closed:
  #7643 revisits it *on top of* this substrate, where a trained head is an
  optimization over a working baseline rather than a prerequisite for having one.

### 2. Abstention is the contract, not a nicety

`decide()` returns `abstained: true` whenever the margin between the top two
options' entailment probabilities falls below a threshold (default `0.15`).

**A caller must treat that as "ask something else" — never as "take the top one
anyway."** This is the load-bearing clause of the whole decision. A scorer that
always answers is a scorer whose confidence is uninformative, which is the
defect that made the generative path unsatisfactory in the first place. The
value this service adds over a coin flip *is* the margin.

Two corollaries fall out of defining the margin as `top1 - top2`:

- `decide()` requires **at least two options**. With one hypothesis there is no
  runner-up, and defining a fallback scale for that case (entailment against its
  own contradiction mass) would make one threshold mean two different things.
  A yes/no question is expressed as two hypotheses.
- The winner's raw `confidence` is **reported but not gated on**. A clear-but-
  weak winner (0.20 against 0.02) clears a 0.15 margin. Callers that want a
  floor apply it themselves; this service does not grow a second knob until a
  caller actually needs one.

### 3. It is machine-local, and it is never a chat provider

The model, the weights, the virtualenv, and the sidecar all live on one machine.
The scorer runs with credentials stripped, `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` set, a loopback-only bind, and no URL fetching. The
premise — which routinely contains external content quoted next to the
operator's own records — never leaves the host, and nothing about jev crosses
the federation layer. That follows the existing constraint in ADR
[privacy records machine-local](./2026-08-08-privacy-records-machine-local.md)
rather than carving a new exception: this is a *decision service*, not a media
job, and none of the job-body carve-outs apply to it.

The descriptor is exposed beside the local-model catalog under its own
`decisionScorers` key and is never merged into `models`, mirroring the guarantee
`securityGuards` already gives Prompt Guard. No provider or model picker can
offer it as a chat model.

### 4. Nothing runs until an operator asks

The feature is **off by default** in `instanceFeatureRegistry.js`. The ~9 GB
download runs only from an explicit install action. The sidecar starts on the
**first scoring call**, never at boot, and an idle timer unloads it after ten
minutes. That is the AI Provider Usage Policy applied to a local model: the fact
that a call costs no quota does not make it something a fresh install may do
uninvited — it costs memory, and on a laptop that is the scarcer resource.

## Consequences

- PortOS gains a decision primitive with a **reportable uncertainty**, which is
  what lets #7642 switch existing callers incrementally: each one can fall back
  to its current generative path on abstention, so the switch is strictly
  additive rather than a cutover.
- It costs a second managed Python runtime and a second install surface. That is
  deliberate: sharing a virtualenv with Prompt Guard would couple two
  independent boundaries to one dependency resolution, and repairing one could
  break the other. The shared part is the *diagnosis vocabulary*
  (`server/lib/pythonRuntimeDiagnosis.js`), not the environment.
- A long-lived subprocess on a new port is a new operational failure mode.
  Mitigated by a single-flight start guard, an idle reaper, an explicit unload
  control, and a loopback-only bind — but it is a real addition to what can be
  wrong on an install, and `docs/JEV_SETUP.md` carries the failure-code table
  for it.
- No entry is added to `server/lib/creativeLatitude.js`. That module classifies
  stage names and `runPromptThroughProvider` source tags; jev builds no prompt
  and reaches neither shared runner, so there is nothing for either guard test
  to see. Recorded here rather than added as a row no code path consults.
- The sidecar is **unauthenticated on loopback**, like whisper, llama-server,
  and slotstream before it. Adding a shared secret would make it the only local
  runtime in the tree that has one, for a threat the Security Model's trust
  boundary does not include.
