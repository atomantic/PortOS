# AI provider model tiers

Tiers are active routing configuration, not display-only labels. Each provider maps
Light (mechanical work), Medium (routine work), Heavy (complex work), and Ultra
(exceptional frontier reasoning) to its own model. Configure them in Models →
Providers. Astra and Fable are examples of Ultra choices; use a model supported
by the selected provider and account.

CoS selects Light/Heavy from task heuristics and can learn tier preferences from
outcomes. Explicit thinking levels have their own routing precedence. Prompt
stages resolve Quick to Light, Coding to Medium, and Heavy to Heavy; they also
accept the canonical Light, Medium, and Ultra names. Prompt Manager exposes Ultra.
Dispatch labels communicate capability to planning/claim agents; they are guidance,
not permission to enable providers or spend on a new service.

Use `model:ultra` on an exceptional tracker task. In CoS task metadata, use
`model: "ultra"`; orchestration profiles accept the same tier names in each role's
`model` field. For example, an explicitly configured architect can request Ultra,
with a Medium implementer and Heavy reviewer. Exact model IDs still work and
remain appropriate for model-specific evaluations or compatibility requirements.
The tier resolves on the selected provider, including provider fallback.

Model capability and reasoning effort are independent: Ultra does not imply
maximum effort. Existing task heuristics, thinking levels, learning escalation,
provider defaults, and scheduled jobs do not automatically upgrade to Ultra.
An unset Ultra mapping falls back to Heavy, then the provider default. Existing
installs receive an optional Ultra field; migration selects Astra/Fable only when
already present in that provider's catalog and preserves all explicit Ultra pins.
No migration calls a provider or starts AI work.

Prefer role/stage tier assignments for portable workflows; keep exact pins for
intentional exceptions. Avoid bulk replacing installed stage pins or changing
scheduled tasks without the user's instruction.
