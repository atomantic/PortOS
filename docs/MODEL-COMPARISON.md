# Models Comparison

Open **Models → Comparison** (`/models/comparison`) to compare sourced provider/model/effort configurations. The chart separates benchmark versions and offers published benchmark cost per task or an explicit uncached token workload estimate. Provider, model and effort filters are bookmarkable query parameters. The table is the accessible equivalent of the chart and retains missing-data rows.

The catalog contains comprehensive public configurations across major providers (OpenAI, Google, Anthropic, Meta, DeepSeek, Mistral, Alibaba, etc.) from Artificial Analysis, accessed September 5, 2026. Models with multiple evaluated reasoning efforts are connected along effort curves, with standardized end-to-end response times and configurable linear or logarithmic cost scaling.

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
- `POST /api/providers/comparison/sync-aa` with optional `{ "apiKey": "..." }` → fetches model metadata directly from the Artificial Analysis API, normalizes observations, and imports them.

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
