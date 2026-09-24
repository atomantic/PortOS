# AI provider model tiers

Tiers are active routing configuration, not display-only labels. Each **preset**
(a stored provider record — see [AI_PROVIDERS.md](./AI_PROVIDERS.md)) maps
Light (mechanical work), Medium (routine work), Heavy (complex work), and Ultra
(exceptional frontier reasoning) to its own model. Tiers live on presets, not on
harnesses or services: configure them in Models → Providers → Presets, on the
preset's editor, and a tier name resolves on whichever preset a task names. Astra
and Fable are examples of Ultra choices; use a model supported by the selected
preset's service and plan.

A tier is an explicit request, never an automatic one. CoS runs a task on the tier
or model the task, role, or stage names, and otherwise on the preset's Default
Model — it does not pick a tier from the task description, priority, context size,
or learning history. The CoS Learning view still reports per-tier success rates
per task type as advice: act on it by pinning a tier on the task or schedule.
Prompt stages use the same four names (Light, Medium, Heavy, Ultra) or Default;
the legacy stage spellings Quick and Coding still resolve to Light and Medium.
An unset tier on a preset inherits its Default Model, so a preset only needs the
tiers it wants to map to a different model.
Dispatch labels communicate capability to planning/claim agents; they are guidance,
not permission to enable providers or spend on a new service.

Use `model:ultra` on an exceptional tracker task. In CoS task metadata, use
`model: "ultra"`; orchestration profiles accept the same tier names in each role's
`model` field. For example, an explicitly configured architect can request Ultra,
with a Medium implementer and Heavy reviewer. Exact model IDs still work and
remain appropriate for model-specific evaluations or compatibility requirements.
The tier resolves on the selected provider, including provider fallback.

Model capability and reasoning effort are independent: Ultra does not imply
maximum effort. Provider defaults and scheduled jobs never upgrade to Ultra on
their own.
An unset Ultra mapping falls back to Heavy, then the provider default. Existing
installs receive an optional Ultra field; migration offers Fable additively on standard Claude catalogs, selects Astra/Fable
when advertised by the provider, and preserves all explicit Ultra pins.
No migration calls a provider or starts AI work.

Prefer role/stage tier assignments for portable workflows; keep exact pins for
intentional exceptions. Avoid bulk replacing installed stage pins or changing
scheduled tasks without the user's instruction.
