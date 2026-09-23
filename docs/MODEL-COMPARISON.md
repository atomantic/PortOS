# PortOS Model Benchmarks

**Models → Comparison** runs a small, fixed PortOS task set against models this install can use. The chart can show total tokens per five-task run or estimated API-equivalent cost per 1,000 runs on the X axis, against exact-answer score on the Y axis. Token mode includes local models. Cost mode includes only models with a known API-rate reference. Benchmark runs are started by a person from the page; reads, startup, and imports never dispatch benchmark calls. The scheduled model research task uses its configured model to produce a research report, but does not run the benchmark or change benchmark results.

## PortOS Task Bench v1

Version 1 contains five short, deterministic tasks: arithmetic, text formatting, a small logic puzzle, a price calculation, and JavaScript output reading. Each task has a fixed expected answer and a deterministic matcher. The score is the percentage of tasks matched exactly. An incomplete run has no score.

This is a PortOS workload for comparing the configurations available on one install. It is not a replacement implementation of SWE-bench or a claim to reproduce a public leaderboard. Task definitions and grading rules ship in source; model responses and prompts are not saved.

## Provider scope and safety

The page lists enabled models after applying the same model-access policy as provider pickers. A run is allowed only for a configured subscription family or a free/local provider, and only through a direct text API or Codex's isolated subscription text transport. CLI-only providers that can invoke agent tools stay visible as unavailable until PortOS can call them through a tool-free transport.

Each run makes five serial calls to the selected provider and model. It does not switch provider, model, or endpoint on failure. The provider's model effort setting is pinned for Codex runs when selected. Local/API providers without an effort control run at their provider default. A Stop action aborts the active request; any completed partial token usage is retained without a performance score.

## Usage, performance, and cost

- **Tokens per run** includes the input and output tokens across all five calls. Provider-reported counts are preferred. If a provider omits a count, PortOS estimates the missing side as characters divided by four and labels the run estimated or mixed.
- **Performance** is the count of exact deterministic answers divided by five. The tasks and scoring version are included in each observation's configuration.
- **API-equivalent cost** is shown only when PortOS has a model-specific or family API rate. It uses the run's token counts and the rates in `server/lib/modelPricing.js`. It is a reference estimate, not a subscription charge or quota-burn measurement. GPT-5.6 Sol/Luna and GPT-6 Sol/Luna rates were checked against [OpenAI's GPT-6 launch announcement](https://openai.com/index/introducing-gpt-6-sol-and-luna/).
- **Local inference** is compared on tokens and score. It receives no dollar cost and is not treated as free hardware or energy.
- **Subscription allowance** is not allocated per request by Codex/ChatGPT plans. Usage depends on model, effort, task, and plan window, so the chart does not convert API-equivalent dollars into claimed plan consumption. See [OpenAI's usage guidance](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex).
- A configured free provider is offered as a comparison target, but PortOS does not infer its rate limit or remaining quota from a free label.

## Machine-local data

Observations append to `data/model-comparison.json`, an existing machine-local file-primary store. No run results are included in `data.reference`, federated, or uploaded by the benchmark feature. A record keeps the run id, provider/model/effort identity, score, token basis, duration, and optional API-equivalent estimate. It does not keep prompt text or model output. Imports cannot add retired Artificial Analysis Intelligence Index or SWE-bench score rows. Migration 409 removes those rows from installed catalogs while preserving other observations and usage.

Public price references may remain in the seed; they are not presented as PortOS performance scores. External benchmark score imports from Artificial Analysis and SWE-bench are no longer exposed by the comparison API or seeded into new installs.

## Daily model and effort updates

The scheduled model research task checks official model releases and effort options and reports actionable changes for maintainers. When that research confirms a new model or effort option:

1. Add the model to `data.reference/providers.json` only for provider accounts that can actually select it; add an additive migration when existing installs need the choice.
2. Update the model's API reference rates in `server/lib/modelPricing.js` from an official pricing source and record the model's verification date with `pricingAsOfForModel()`. Move the global `PRICING_AS_OF` date only when all rates are rechecked.
3. Use `effortLevelsForProvider()` and provider-published model capability data for available efforts. Do not infer an unsupported effort rung from another model in the family.
4. Keep performance blank until this PortOS install runs the fixed task set on that exact model and effort. No source leaderboard score is copied into the PortOS chart.

The existing local model assessment remains the source for machine-specific local throughput, context fit, and hardware measurements. Those results can inform future benchmark design, but they do not become task-quality scores without a comparable PortOS task run.
