# AI Toolkit (`server/lib/aiToolkit/`)

Keep the vendored toolkit self-contained. **Never import out to another PortOS module.** Resolve host inputs outside this tree and pass them as data. Keep the public barrel documented and keep lightweight callers on leaf imports.

## Providers and model access

- Treat unknown context windows as unconstrained. Never infer them from model IDs. Apply the single Ollama runtime clamp over all planning rungs. Pass host-resolved context as a runtime-only provider projection.
- Use native Ollama chat when `numCtx` is set and adapt its output to the shared stream contract.
- Add provider fields to the record builder and schema. Preserve custom fields on update and use `refreshProviderModelsBatch` for multiple refreshes.
- Scope advertised models on read and keep the original catalog available to editors. Empty patterns and `all` are unconstrained. Preserve record-named models and derive inherited gateway access without persisting it. Preserve non-enumerable credentials across composition. Use the iterative glob matcher for user patterns.

## Host and run lifecycle

- Keep save notifications non-fatal and patch groups in one write.
- Keep manual admission through handler settlement, even after disconnect. Fire API `onSettled` after transport cleanup and terminal persistence/hooks.
- Register host CLI/TUI runners through the toolkit setters. Host-spawned processes must register/unregister external runs. All lifecycle operations consult that registry.
- Check `isRunCanceledError` before turning failures into verdicts. Preserve cancellation metadata and hooks. Timeout wins over cancellation.
- Keep prerequisites synchronous and fail open for missing or malformed answers. Mirror timed recovery on every status read.
- API streaming owns stall/absolute deadlines and terminal metadata. Host backstops use `apiRunAbsoluteTimeoutMs`. See `internal/runTimeouts.js`, `internal/streamTransport.js` and `runner.js`.

See [host integration](../../../docs/INSTRUCTION_RULE_DETAIL.md#ai-toolkit-host-integration) for implementation details.
