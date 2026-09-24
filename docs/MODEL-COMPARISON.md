# Model Comparison

**Models → Comparison** renders the public dataset shipped in `data.reference/model-comparison.json`. The server reads that file directly. The page does not inspect this install's provider configuration or local data, discover models, synchronize online sources, or run inference. Every PortOS instance receives the same snapshot in its PortOS release.

## Chart and source rules

The chart compares one selected public benchmark at a time against a published input or output API price per 1 million tokens. Benchmark families and sample sizes stay separate because their scores are not interchangeable. Each score and price keeps its own source URL, retrieval date, and methodology.

Published per-token rates are API references. They are not a benchmark's measured token usage, task cost, subscription charge, subscription allowance use, or free-provider quota. Family-level rates are marked as estimates for dated model snapshots. Missing score or price data stays blank. A zero-priced endpoint is not a promise of unlimited access.

The initial shipped snapshot uses the downloaded online catalog as its starting point, then keeps models available through shipped providers, declared local-model equivalences, and a small set of current frontier anchors. It contains 19 observations across 16 models: two LiveCodeBench generation/pass@1 scores over 1,055 problems and 17 pricing-only references. The Qwen3-235B-A22B score also carries OpenRouter's separately sourced route price; the Grok 3 Mini score has no matched price and remains unplotted. The catalog contains no PortOS-run observations, Artificial Analysis Intelligence Index scores, or SWE-bench scores.

## Updating the shipped catalog

The scheduled **Model comparison refresh** task researches public model releases, effort options, benchmark results, and token prices. It does not inspect an install's provider settings, run benchmarks, or edit the catalog. Maintainers review its report and update `data.reference/model-comparison.json` for a PortOS release.

For each added or changed observation:

1. Preserve the exact public model/version and effort, benchmark family and metric, evaluation window and sample count when published, and the benchmark's source URL and retrieval date.
2. Store input/output prices as separate metrics with their own official provider source, retrieval date, price tier, and model/family matching method.
3. Keep unlike benchmark families, task sets, model versions, effort settings, and sample sizes in separate rows or benchmark labels. Do not copy scores across aliases or infer missing values.
4. Check model status and note when an official source marks the model or snapshot deprecated or retired.
5. Validate the catalog against `modelComparisonCatalogSchema` and keep source URLs public and external. Do not include live run results or provider/account configuration.

Do not add Artificial Analysis Intelligence Index or SWE-bench scores. Do not treat public API prices as subscription usage. Research changes are shipped through the checked-in reference JSON and the next PortOS release, not assembled on each user's Comparison page.

## PortOS-run task benchmark

Direct PortOS benchmark runs live under **Models → Performance → PortOS bench**. A person explicitly chooses a configured provider, model, and optional effort, then starts a five-task deterministic short-answer run. It never runs at startup or from the Comparison page.

The run stores its score and token usage in machine-local `data/model-comparison.json`. Provider-reported token counts are used when available; missing counts are estimated as characters divided by four and labeled estimated or mixed. For local models, the Performance chart compares tokens per run with score. For paid API models, a separate reference estimate can use current API rates; it is not the subscription charge. Prompts and model responses are not stored, and no run result enters the shipped catalog.
