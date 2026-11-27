# Editorial checks

[checkRegistry.js](checkRegistry.js) resolves check definitions, scopes, settings,
and the enabled catalog. [checks/](checks/) holds the check definitions.
Each check declares its scope (series, issue, scene, noun, or an array of
scopes), kind, severity, config schema, optional gate and `run(ctx)` returning
manuscript-review findings.

[checkInfra.js](checkInfra.js) exposes shared check helpers from
[checkInfra/](checkInfra/), including manuscript chunking and finding
deduplication. LLM checks use runner-injected callers and context. Prior-findings
digests are optional and fit into spare chunk budget without displacing manuscript
text. Shared context blocks count toward the provider's input budget.

[checkRunner.js](../../services/pipeline/editorial/checkRunner.js) assembles
context and runs enabled checks. Keep provider and persistence I/O at this
boundary. User-defined checks go through the same registry and runner.
[findingCategories.js](findingCategories.js) and
[severityConfig.js](severityConfig.js) define finding vocabulary and defaults.
