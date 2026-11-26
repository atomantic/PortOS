export const prompts = {



  'api-contract': `[Improvement: {appName}] API and route-contract audit

Audit {appName}'s API surface — HTTP routes, RPC services, GraphQL resolvers,
event and message contracts, and any published SDK or client — for contract
drift, validation gaps, and error traps.

Repository: {repoPath}

{modeInstructions}

Identify the framework and the project's own conventions (validation library,
error envelope, async wrapper, versioning scheme) before judging anything. Trace
callers — in-repo clients, SDKs, consumers of a published spec — through to the
handlers and schemas, hunting for:

- **Unvalidated inputs** — handlers reading the request body, query, params, or
  message payload directly with no schema, letting malformed types into domain
  logic.
- **Caller/handler drift** — a caller sending a field no handler reads, a
  handler requiring one the caller omits, or a caller reading a key the response
  never carries.
- **Spec drift** — an OpenAPI, protobuf, GraphQL, or event schema that no longer
  matches the implementation, so generated clients and documentation are wrong.
- **Breaking changes to a published contract** — a renamed, removed, or retyped
  field, a changed default, or a reused protobuf field number on an API other
  systems consume, with no new version or deprecation path.
- **Status and envelope errors** — success statuses carrying errors, a server
  error for bad client input, or responses that break the project's own error
  envelope, so callers cannot tell retryable failures from permanent ones.
- **Async traps** — a handler whose rejected promise or thrown error bypasses
  the framework's error path (for example an Express handler missing the
  project's async wrapper), hanging the request instead of failing it.
- **Unsafe mutation semantics** — a mutation behind a safe method, a
  non-idempotent PUT or DELETE, or a create endpoint clients will retry with no
  idempotency key, producing duplicates on a timeout.
- **Unbounded or unstable collections** — list endpoints with no limit, no
  maximum page size, or offset pagination over data that changes underneath the
  caller.
- **Long work on a synchronous request** — an endpoint that does minutes of work
  inline where the contract should accept the job and report status.
- **Loose schemas** — unbounded strings, arbitrary extra keys, or an enum
  accepting values downstream code cannot handle.

For each finding, name the caller AND the handler with \`file:LINE\`, the shape
that gets through, and the concrete failure it produces for a consumer.`,


};
