# Stacker News stewardship

PortOS provides a Comms > Stacker News workspace for independently configured
Stacker News accounts and the communities they monitor or own. PortOS ships no
account, territory, rule, or schedule defaults; each install manages only the
accounts its user explicitly adds.

## Safety model

- API keys are encrypted in dedicated credential records, separate from account
  configuration. They are never returned by the API, logged, placed in model
  prompts, or shared with the browser.
- The transport exposes a closed registry of named, typed GraphQL operations at
  the fixed Stacker News endpoint. Callers cannot provide GraphQL, endpoints,
  headers, or arbitrary variables. Reads may retry transient failures; writes
  never retry because that could duplicate content.
- Posts, comments, URLs, images, and browser content are untrusted. Text is
  bounded and screened for instruction-shaped content before optional local
  analysis. A prompt-injection match prevents text and images from reaching an
  Ollama model. The complete bounded title and body are hashed even though the
  model copy is shorter, so edits outside the model window still invalidate an
  analysis or approval.
- Remote images use the strict public-network fetch posture, a five-megabyte
  download cap, MIME and pixel limits, and a single-frame Sharp decode. SVG and
  other active formats are rejected. Ollama receives only an in-memory,
  re-encoded PNG; raw remote bytes are never persisted.
- Ollama text and vision results must match a strict JSON schema and are merged
  conservatively, preserving the highest risk from either stage. Results record
  their source-content hash, effective-rules hash, model, stage, provider, and
  policy version. If content changes during analysis, the result is stale and
  cannot drive an action.
- The deterministic policy layer, not model output, resolves account and
  territory rules and chooses whether a suggestion is eligible for review.

## Approval and execution

Every proposed action enters `pending_review`. Approval and execution are
separate user actions. Immediately before execution PortOS rechecks the selected
account identity, source-content hash, effective rule hash, action age, action
budgets, territory ownership evidence, state transition, and idempotency key.
The reviewed username, territory slug, and remote item ID are snapshotted and
must still match, so editing account or territory configuration cannot redirect
an already-approved action. Terminal actions may be submitted as a fresh review.
Every transition is appended to the action ledger. Pending actions also appear
in Review Hub and drill back to the correct account.

Publishing discussions and comments uses reviewed API operations. Stacker News
may return a payment-required `PayIn` state; PortOS records that as a safe
failure and asks the user to complete payment manually. It never operates a
wallet or Lightning extension.

Browser work uses PortOS's existing CDP browser and only fixed primitives:

1. navigate to `https://stacker.news`;
2. run PortOS's internal identity extractor in the pinned page session;
3. require that username to match the selected account; and
4. open an internally constructed item or territory-settings URL on the same
   fixed origin.

The API, UI, and models cannot supply a URL, selector, browser script, click, or
wallet action. Zap, downzap, boost, and territory-setting work stop at a browser
handoff for the user to complete.

## Capability matrix

| Capability | Transport | Automation boundary |
| --- | --- | --- |
| Verify account identity | Named GraphQL `me` | Read only |
| Refresh territory settings/ownership | Named GraphQL `sub` | Read only |
| Monitor recent posts and comments | Named GraphQL `items` | Explicit sync or an effective account/territory opt-in |
| Analyze text/images | Local Ollama | Strict schema; no tools, credentials, or write access |
| Publish a discussion/comment | Named GraphQL mutations | Separate human approval and execution; no write retry |
| Open an item or territory settings | Fixed-origin CDP handoff | Identity match required; no clicks or DOM supplied by callers |
| Zap/downzap/boost | Fixed item handoff | Human completes it in the browser |
| Wallet/payment settlement | Unsupported | Never automated |
| Arbitrary GraphQL/URL/selector/JavaScript | Unsupported | Never exposed |

## Setup

1. Open **Comms > Stacker News > Accounts & Safety** and choose **Add account**.
   The account form opens in a drawer grouped into Identity, Monitoring & models,
   Stewardship, and Budgets tabs; the open tab is kept in the URL.
2. Add an API key if API reads or reviewed publishing are needed, then verify
   that the returned identity matches the configured username.
3. Add each territory, mark whether the account owns it, and choose whether it
   inherits account rules and monitoring. Communities can be edited or removed
   later as ownership and stewardship responsibilities change.
4. Configure account and territory guidance, themes, escalation cues, and action
   budgets. Each account keeps its own effective rules.
5. Optionally choose installed Ollama text and vision models. Analysis remains
   off until explicitly enabled or run on demand.
6. Run **Sync now** once to verify territory ownership and inspect the first
   snapshots. Enable a monitoring schedule only when ready.
7. If browser handoffs are needed, sign the pinned PortOS browser into the same
   account and run **Check browser identity**.

Every tab is scoped to one account. The header carries an account switcher that
keeps the current tab, and each section names the account it operates on, so a
Territory, Review, Drafts, or Activity list is never mistaken for a global one.

Monitoring is off by default. Boot may arm a schedule the user already enabled,
including a territory override on an otherwise quiet account, but it never
performs an immediate sync or cold-start model call. The account form can also
explicitly remove a stored API key without exposing its value.
