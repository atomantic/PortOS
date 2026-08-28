# PortOS API contracts

The checked-in [`openapi.json`](./openapi.json) is the complete OpenAPI 3.0.3
HTTP inventory. It covers every mounted route; operations marked
`x-portos-contract-status: generated` are discoverable inventory only until a
request and response contract is modeled. The smaller
[`portos-tools.min.json`](./portos-tools.min.json) contains only operations
explicitly marked `x-portos-tool` and is suitable for model tool discovery.

Regenerate both artifacts with `npm run generate:api-spec`. Regenerate the
source route/event inventories first with `npm run generate:api-docs` when
routes or mounts change. Generated artifacts must not contain live settings,
personal records, credentials, provider output, or host-specific URLs.

## Routing guidelines

- Route model operations by user-meaningful capability, not by forwarding an
  arbitrary URL or exposing a whole Express router to a model.
- Keep transport adapters behind the semantic registry. REST, Socket.IO, SSE,
  and provider-specific routes may change without changing the tool contract.
- Resolve authority server-side from the authenticated session, process-local
  supervisor, or explicit capability grant. Client `context`, `actor`, and
  `scope` fields are correlation metadata, never authorization.
- Keep `/api/agent-context` loopback-only and read-only, and keep Persistent
  Mind grants default-off and narrower than the general CoS catalog.
- Preserve stable tool names and aliases across one compatibility window;
  never silently repurpose an existing name for a different side effect.

## Contract standards

- Validate every route input with the same Zod schema that feeds OpenAPI.
  OpenAPI 3.0 conversion must remove JSON-Schema 2020-12-only constructs.
- Use closed object schemas by default, explicit nullable values, bounded
  strings/arrays, and clear parameter descriptions with units and ranges.
- Return the standard `{ error, code, timestamp, context? }` envelope for
  transport errors. Use stable codes and tell model callers whether to fix,
  refresh, back off, authenticate, or stop.
- Mutations require an idempotency key and replay the same normalized result;
  conflicting reuse is a 409 and must never execute twice.
- Long-running work returns a normalized job/status contract. Confirmation is
  a separate trusted UI transition; model callers receive no approval token.
- Add `x-portos-tool` only after reviewing privacy, side effect, auth,
  retryability, async lifecycle, and output-schema behavior. A route in the
  complete OpenAPI inventory is not automatically callable by an LLM.
