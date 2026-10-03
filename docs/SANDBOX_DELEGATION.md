# Tool-free model delegation

Persistent Mind can outsource bounded coding, text, and animation-source work
without queueing a CoS coding agent. In **CoS → Persistent Mind → Tools**, choose
approved API worker models and a trusted API evaluator, then enable and save
**Tool-free model delegation**. It ships disabled, with no approved routes.
Existing installs gain no model-call authority on upgrade.

For OpenRouter, the free router's model ID is `openrouter/free`
([official guide](https://openrouter.ai/docs/guides/routing/routers/free-router)).
Configure it on an API provider first. No route is inferred from a model name,
and no paid fallback is selected. Approved evaluator calls may consume paid
quota; approving the routes is standing consent for those calls and for sending
the supplied context to those providers.

The mind discovers `sandbox.models` and `sandbox.delegate` in the `tasks` tool
family. `sandbox.models` reads approved routes without inference. The delegation
grant is independent of `createTasks`, record writes, and OS-tool authority.

Example delegation arguments (all context is invented):

```json
{
  "providerId": "example-api",
  "model": "openrouter/free",
  "kind": "coding",
  "task": "Return an ESM patch adding a greeting function.",
  "context": "Complete relevant source: export const version = 1;\nRequirements: JavaScript, no dependencies, exported greet(name) returns Hello, <name>.",
  "criteria": ["Preserves version export", "Exports greet with the specified result"],
  "maxAttempts": 2
}
```

The orchestrator gathers context before delegating: relevant source, interfaces,
constraints, examples, desired output format, and acceptance criteria. Workers
cannot fetch missing files or ask for tools. The context field is a string, never
a filesystem reference. Keep credentials and private records out of it; there
is no automatic repository, environment, memory, or credential collection.
Source templates and sanitized examples are suitable. Provider credentials stay
in the transport and are never added to prompts or results.

Both calls use direct API text inference: no CLI/TUI process, shell, filesystem,
browser, MCP, or semantic tools are provided or dispatched. This is a tool-free
inference boundary, not a container for running generated programs. Coding
patches, animation scripts, and prose remain text. The worker's proposal reaches
the separate evaluator explicitly as untrusted data. The evaluator must provide
an evidence-bearing verdict for each criterion, sufficient context, and a safe
proposal. Malformed, incomplete, unsafe, or context-deficient verdicts withhold
the proposal. A fidelity failure may trigger one revision when `maxAttempts: 2`;
the revised output is evaluated again. The worker cannot choose the evaluator.

An accepted proposal still carries `trusted: false` and
`validation: "model-evaluation-only; no code executed or tests run"`. Evaluation
is advisory and can be wrong or manipulated. The trusted orchestrator must
independently validate it before using its own tools; an embedded instruction or
claimed test result grants no authority. Normal validation and delivery gates
apply when a proposal is later implemented. Larger results remain intact in
mind continuations when context permits; a context-window reduction explicitly
marks compacted results as truncated.

Requests allow 48,000 context characters and up to 12 acceptance criteria.
Each call uses at most two worker/evaluator pairs, 8,000 output tokens per model
call, a two-minute stall timeout and three-minute absolute inference limit.
Worker output is capped at 48,000 characters and evaluation output at 16,000.
The shared mind turn tool budget and request-id replay protection still apply.
The current grant, approved routes, provider enablement, model availability, and
API mode are checked before every dispatch. Cancellation stops the active run.
Nothing calls a model at boot or merely by opening the configuration panel.
