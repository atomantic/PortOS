# Models Comparison

Open **Models → Comparison** (`/models/comparison`) to compare sourced provider/model/effort configurations. The chart separates benchmark versions and offers published benchmark cost per task or an explicit uncached token workload estimate. Provider, model and effort filters are bookmarkable query parameters. The table is the accessible equivalent of the chart and retains missing-data rows.

The catalog contains comprehensive public configurations across major providers (OpenAI, Google, Anthropic, Meta, DeepSeek, Mistral, Alibaba, etc.) from Artificial Analysis, with the September 5, 2026 v4.2 snapshot retained and a verified September 10, 2026 v4.3 snapshot added. Models with multiple evaluated reasoning efforts are connected along effort curves, with standardized end-to-end response times and configurable linear or logarithmic cost scaling.

## Sources and interpretation

- [Artificial Analysis](https://artificialanalysis.ai/) supplies independent quality, benchmark cost and performance measurements. Its [API documentation](https://artificialanalysis.ai/api-reference) describes key-based access and attribution. Research can use public model/provider pages without a key. Do not copy documentation example values into the catalog as current observations.
- Official provider pricing documents govern the exact endpoint, region, token classes, batch/cache/context tier and billing date. Public benchmark pricing is an attributed reference, not an account-specific invoice.
- Official local model cards identify revisions and quantizations. Hosted quality is only transferable when the evaluated configuration is verified equivalent. Hosted speed and cost never describe local hardware.
- Subscription quota stays unknown unless a primary source defines per-task units for the exact workload and plan. No dollar-to-quota conversion, generic effort multiplier, or assumption that local inference is free.
- Every metric carries its own source URL, retrieval date and methodology. End-to-end response measurements must name input/output lengths, reasoning inclusion and percentile/window. They are independent of the intelligence evaluation. Unknown metrics are `null`.
- Entries older than 30 days are visibly stale. This is a freshness cue, not a guarantee that more recent data is correct. A schema validates structure, not the source's truth.

## Research workflow

1. Choose a browsing-capable CoS provider and model in the Comparison research panel and save. The `model-comparison-refresh` task ships **disabled and on-demand**; boot and page reads make no LLM calls.
2. Run research from the panel or CoS Schedule. CoS must have Improvement enabled. The task reports failures through the ordinary CoS run lifecycle. The queue confirmation is not research completion.
3. The agent reads the current catalog and sanitized enabled-provider inventory. Explicit discovery probes read current provider model lists, including Ollama-backed providers, without writing provider settings or running model inference. Model installation and provider enabling never silently launch research; the next user-triggered or explicitly scheduled run discovers additions.
4. Missing configured combinations take priority over stale observations and other new releases. Each run is bounded to 20 configurations and 20 provider discoveries; remaining gaps are reported. Unavailable sources preserve existing evidence.
5. In CoS Schedule, find **model-comparison-refresh** to set recurring cron cadence, research effort/model or a custom prompt. Scheduling is opt-in; the chosen research provider consumes quota or API budget. A custom prompt follows the normal CoS prompt-pin contract.
6. After CoS verifies its import, reload Comparison data. Discovery is an ephemeral read; it does not change provider selections or model lists elsewhere in PortOS.

## Catalog and import contract

`data/model-comparison.json` is a machine-local, externally researched reference snapshot seeded by `data.reference/model-comparison.json`. The server reads and validates it on every request. No federation: provider inventory and local configuration context belong to this install. No history or cross-record queries are stored; import merges a bounded snapshot by stable observation ID. Filesystem backups include it. See the storage classification in `STORAGE.md`.

Endpoints (relative to the configured PortOS API origin):

- `GET /api/providers/comparison` → `{ schemaVersion: 1, observations, inventory }`. Inventory contains only provider IDs/names/types, discovery capability, model IDs and supported effort labels. No credentials or endpoints.
- `POST /api/providers/comparison/discover` with `{ "providerId": "example-provider" }` → current `{ providerId, models: [{ model, efforts }] }`. Explicit discovery only; failures remain visible.
- `POST /api/providers/comparison/import` accepts `{ schemaVersion: 1, observations: [...] }`. GET's `inventory` field is not an import field. The UI also accepts this JSON as a file.
- `POST /api/providers/comparison/sync-aa` with optional `{ "apiKey": "..." }` → fetches model metadata directly from the Artificial Analysis API, normalizes observations, and imports them. The API-reported `intelligence_index_version` determines observation IDs, benchmark labels and metric methodology. Missing/invalid versions, malformed/empty pages, or a version change during pagination fail before import; new benchmark versions never overwrite older-version evidence.

Use the actual configured origin, optional authentication and trusted local HTTP mirror described in `PORTS.md`; do not hardcode an install address. Never put credentials in a catalog, command argument, source URL, output report or repository file. Existing authenticated PortOS tooling can perform the POST. Direct local file replacement bypasses import preservation checks and is not the research workflow.

The exact schema is `modelComparisonImportSchema` in `server/lib/validation.js`. Each observation has:

| Field | Meaning |
| --- | --- |
| `id` | Stable public observation identity, including benchmark version/configuration |
| `provider`, `model`, `effort` | Exact inference provider, model ID and evaluated effort; use `unspecified` when the source does not identify effort |
| `configuration` | Revision, quantization, runtime, endpoint tier or evaluated setup; no machine identity |
| `billing` | `api`, `subscription`, `local`, or `unknown` |
| `benchmark` | Benchmark name **and version**, never a mixture of versions |
| `quality`, `costPerTask` | Published quality score and USD per benchmark task |
| `inputPerMillion`, `outputPerMillion`, `reasoningPerMillion` | USD per million tokens for each independently verified token class |
| `responseSeconds`, `tokensPerSecond` | Measured E2E seconds and output throughput |
| `quota` | `null` or `{ unitsPerTask, unit, source }`; unit must identify its plan/workload |
| `notes` | Source limitations, scope and interpretation |

Each non-null metric is `{ "value": 12.3, "source": { "url": "https://example.com/benchmark", "retrievedAt": "2026-09-05T00:00:00Z", "methodology": "Example benchmark v1, exact workload and measurement scope" } }`. This is invented schema illustration, not benchmark data. All nullable fields must be present. At least one sourced metric is required. Sources must be HTTPS and dates cannot be in the future. Imports contain 1–2,000 unique observation IDs; the merged catalog is capped at 2,000.

Validate a candidate locally from the PortOS root, without writing anything:

```sh
node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { modelComparisonImportSchema } from "./server/lib/validation.js"; modelComparisonImportSchema.parse(JSON.parse(await readFile(process.argv[1], "utf8"))); console.log("Catalog schema valid");' /path/to/candidate.json
```

Then POST the validated JSON using the normal authenticated API client and GET the catalog to verify. Reusing an ID with changed provider/model/effort/configuration/billing/benchmark is rejected. Create a new ID for a changed identity. Null or older incoming metrics retain the previous metric, and unrelated observations remain. Concurrent imports serialize the read/merge/write operation. A malformed or unsupported-version stored catalog fails visibly and cannot be overwritten by an import.

Partial source refreshes cannot erase old evidence. To retract incorrect data, an operator must deliberately repair the local catalog while preserving a recovery copy; autonomous research does not delete observations. A future schema migration must explicitly preserve installed evidence and source provenance.

## Selectable axes and free Zen coverage

Both axes offer benchmark score, cost per task, speed (output tokens/s), response time (seconds), and input/output token prices. `xAxis` and `yAxis` are bookmarkable and saved with the other chart settings. Changing either clears zoom bounds and selects linear scaling. The X scale can still be logarithmic; zero prices are excluded on log scale and counted explicitly. Missing selected metrics stay in the evidence table, whose quality/cost columns retain their original units regardless of chart axes. Speed and latency remain measurements of their source workloads, not the selected quality benchmark.

The September 6, 2026 snapshot ships eight exact Zen endpoint IDs (the CLI prefixes these with `opencode/`) from the [live Zen model list](https://opencode.ai/zen/v1/models), cross-checked against the OpenCode entries in [Models.dev](https://models.dev/api.json): Big Pickle, DeepSeek V4 Flash Free, MiMo V2.5 Free, Ling 3.0 Flash Fin Free, Nemotron 3 Ultra Free, Nemotron 3.5 Lightning Free, and Muse Spark 1.2/1.3 Contributor Free. Models.dev lists additional historic free entries that the live endpoint no longer advertises; those were excluded.

[Zen's pricing page](https://opencode.ai/docs/zen/) lists six of these; Muse 1.2 and DeepSeek V4 Flash Free are confirmed by the live endpoint plus Models.dev. Each row carries zero published input/output rates, with unknown quota, reasoning-token billing, benchmark task cost, quality and throughput. The free offers are temporary and subject to provider data-use terms. Name similarity does not prove that an AA-tested model matches Zen's revision, effort or serving configuration.

Pricing-only rows appear alongside the selected benchmark as explicitly unbenchmarked evidence. Select input price versus output price to plot them, or use scenario cost with zero reasoning tokens to calculate their published input/output charge. A missing quality measurement cannot become a zero score. Migration 356 appends missing shipped Zen IDs to existing catalogs without overwriting locally researched rows; it validates the entire result before writing and refuses malformed/future-version data.

## Research: skill-specific comparisons

Research checked September 6, 2026. These are candidate adapters and metrics, not newly imported scores. The current benchmark selector already separates named/versioned evaluations; a future skill selector should narrow that list, never mix unrelated score scales.

| Skill | Primary source / metrics | Interpretation and ingestion requirements |
| --- | --- | --- |
| Software coding: repository work | [SWE-bench](https://www.swebench.com/): resolved-task percentage, Verified / Pro / Multimodal tracks | Record track, dataset revision, agent scaffold, tools, budget and model effort. A full agent's result is not a model-only score; keep different scaffolds separate. Public leaderboard/repository artifacts are candidates for a reviewed snapshot importer. |
| Software coding: code generation | [LiveCodeBench](https://livecodebench.github.io/): generation, self-repair, execution and test-output prediction | Its date-windowed contest problems address contamination. Pin release, date window and sampling/pass@k configuration; do not compare different windows. Public code/data and leaderboard are linked by the project. |
| Creative writing | [EQ-Bench Creative Writing v3](https://eqbench.com/creative_writing.html): rubric score, Elo, repetition and slop frequency | LLM-judged results carry judge/prompt bias. Elo is relative to a participant pool; repetition/slop are diagnostics, not a substitute for human editorial judgment. Pin judge version, rubric and leaderboard snapshot. Inspect linked repository data rather than scraping an empty JavaScript-rendered table. |
| Image analysis | [MMMU](https://mmmu-benchmark.github.io/): multimodal subject accuracy; MMMU-Pro as a separate benchmark | Measures image-grounded academic understanding, not image generation quality. Pin original/Pro, split, image resolution, prompting and tool access. Report aggregate plus subject coverage; model support for images alone is not an accuracy measurement. |
| Tool use | [Berkeley Function Calling Leaderboard V4](https://gorilla.cs.berkeley.edu/leaderboard.html): function-calling and agentic task accuracy | Preserve version and category (single/parallel calls, multi-turn, agentic) with tool schemas and execution setup. A syntactically valid call does not prove task success. Use project-published evaluation artifacts and keep different categories distinct. |
| General / coding / math / runtime | [Artificial Analysis API](https://artificialanalysis.ai/api-reference): intelligence, coding and math indices; individual evaluations; output throughput; time to first token | Existing sync is the easiest extension. The documented response has additional evaluation fields and TTFT. Keep TTFT separate from E2E response time and retain workload/percentile. Key-based server-side fetch, caching and attribution are required; documentation example numbers are not observations. |

### Recommended next implementation

1. Introduce a versioned benchmark registry with stable ID, skill, version, score unit, direction, source adapter and required evaluation configuration. Start with coding and writing; add vision and tool-use only with verified coverage. Offer visible missing-data states for skills without measurements.
2. Keep observations per benchmark/configuration, not a single mutable `codingScore` on a model. Add explicit source model identity and separately verified endpoint mappings. An alias can aid discovery without authorizing transfer of speed, pricing or scores.
3. Add a skill selector that filters the benchmark selector. Axis labels and preference direction come from the registry (some diagnostic metrics are lower-is-better); no universal normalized skill score or cross-benchmark averaging.
4. Extend AA's existing explicit sync with separately versioned coding/math evaluations and TTFT, then build bounded, opt-in snapshot importers for the other sources. Confirm dataset/result redistribution terms before bundling results; public visibility alone does not establish redistribution rights.
5. Preserve original score and provenance, evaluation date, source retrieval date, sample count/confidence interval where published, judge/scaffold and workload. Render coverage/freshness and measured-versus-reference distinctions. Stable IDs must encode materially different evaluation configurations; schema changes need compatibility/migration tests.
6. Validate at the import/API and rendered selection boundaries: no mixed versions or units, no cross-endpoint performance transfer, no null-to-zero coercion, and no boot-time research calls. Use the existing Scheduled Task for research rather than introducing a second scheduler.

## September 10, 2026 data audit

The reported Grok inversion is present in the source; no score has been adjusted to force an increasing effort curve. The screenshot matches the retained September 5 v4.2 snapshot (high 50.6, xhigh 49.3). Its xhigh $1.723/task was a client-side estimate because that snapshot had no published xhigh cost. The historical numbers cannot be revalidated against today's changed index.

Fresh authenticated reads of AA's paginated `/api/v2/language/models/free` returned 644 unique model IDs, consistently declaring `intelligence_index_version: 4.3`. All 644 intelligence values (including nulls) matched the separately fetched [documented API](https://artificialanalysis.ai/api-reference) `/api/v2/data/llms/models`. The [high](https://artificialanalysis.ai/models/grok-4-6) and [xhigh](https://artificialanalysis.ai/models/grok-4-6-xhigh) pages independently identify the current index as v4.3. Documentation example scores were not used.

| Configuration | v4.3 intelligence | Published USD/task |
| --- | ---: | ---: |
| Grok 4.6 low | 35.4 | 0.4753 |
| Grok 4.6 medium | 43.0 | 1.4963 |
| Grok 4.6 high | 44.4 | 1.8589 |
| Grok 4.6 xhigh | 44.3 | 2.3237 |

Other checked v4.3 scores include GPT-5.6 Sol max (47.1), Claude Fable 5.1 adaptive/max/default fallback (53.4), and Gemini 3.8 Flash high (41.2). The refresh covers all 637 models with at least one published metric, omitting seven entirely empty rows. All old observations and Zen pricing evidence remain intact. Migration 375 adds missing v4.3 observations to existing installs without replacing locally researched values.

Higher reasoning effort is not a guarantee of a higher benchmark score. The current Grok difference is only 0.1 point; these API responses provide no uncertainty intervals establishing that it is statistically meaningful. Latency measures can also vary between endpoint snapshots and are independent of the quality evaluation. Compare within the selected benchmark version and inspect each metric's retrieval date; the normal 30-day stale indicator cannot detect a benchmark revision within that window.
