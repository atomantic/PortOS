# Outlook and Teams draft delivery

Approved drafts for Outlook and Teams accounts are delivered by driving the web UI in the PortOS browser tab you are already signed into. Gmail still sends through its API. This page is the contract for the browser path; the code is `server/lib/messageBrowserCompose.js` (pure planning, scripts and judging) and `sendPlaywright` in `server/services/messagePlaywrightSync.js` (the I/O).

## Live validation status

**Not validated against a real mailbox or Teams tenant.** The selector defaults in `COMPOSE_SELECTOR_DEFAULTS` are best-effort descriptions of the providers' current web UIs, written without access to a controlled test account. The in-page scripts were exercised against a synthetic DOM and the orchestration against scripted browser results, which proves the logic and the failure handling but not that Outlook or Teams still match the selectors.

The design makes an unvalidated selector fail safe rather than send wrongly:

- a control that does not match stops the send **before** the click (`PROVIDER_CONTROL_MISSING`, nothing sent, draft may be re-approved);
- an acknowledgement signal that does not match leaves the delivery **unconfirmed** (`DELIVERY_UNKNOWN`), which routes to the existing reconciliation flow instead of reporting success.

Until someone validates a send against a controlled account, expect some sends to end as "delivery unknown" even though they went through. To validate: open Outlook or Teams in the PortOS browser, send a draft to an address you control, and adjust the selector keys (below) until it reports confirmed.

## Guarantees

1. **Approval is preserved on refusals.** Whether a draft can be delivered at all, to whom, and which message it replies to is decided before the draft is claimed (`planDelivery`, called from `sendDraft`). The reply target is looked up in the draft's **own** account cache, so a draft cannot answer another account's thread.
2. **Exactly one submit click.** Every phase before the click (identity probe, open compose, fill, verify) is side-effect free. The send runs under a per-provider lock so two drafts never interleave in one tab.
3. **Success needs a positive provider signal.** After the click, a delivery is confirmed only when the compose surface closed **and** a fresh acknowledgement appeared: new live-region text matching `sendAckPattern` for Outlook, or the sent message rendered in the conversation for Teams. Anything else — a lost connection, a timeout, a closed window with no acknowledgement — is `delivery_unknown`.
4. **Ambiguity is never retried.** `delivery_unknown` is the same state a crash during a send leaves. The draft cannot be re-sent or re-approved until you check Sent Items or the conversation and record the outcome (Drafts → Confirm sent / Confirm not sent). A provider refusal with the compose window still open is a definite failure (`PROVIDER_REFUSED`).
5. **Recipients are verified, not assumed.** Before the click the page's recipients must equal the approved ones exactly — no extras, none missing — and the typed text must read back. A Teams recipient must resolve to a picker entry that names the exact address.
6. **Account identity.** One tab is one signed-in identity. A visible identity that is not the account's is refused. When several enabled accounts share a provider, an identity the page does not reveal is also refused, so a draft cannot leave from the wrong mailbox.

Not supported: reply-all, attachments, Teams channels and meetings, and Cc on an Outlook reply (a reply goes to the recipients Outlook prefilled, and any difference from the approved list is refused). Cc on a Teams chat is refused up front. A new Outlook message needs a subject; a reply keeps the subject Outlook wrote.

## Failure codes

| Code | Meaning | Draft after |
| --- | --- | --- |
| `PROVIDER_TAB_UNAVAILABLE` | No signed-in tab open, or it did not respond | `failed` (re-approvable) |
| `PROVIDER_LOGIN_REQUIRED` | The tab is on a sign-in page | `failed` |
| `PROVIDER_CONTROL_MISSING` | A compose control no longer matches a selector | `failed` |
| `PROVIDER_COMPOSE_BUSY` | A compose window is already open in the tab | `failed` |
| `RECIPIENT_MISMATCH` / `RECIPIENT_UNRESOLVED` | The page's recipients differ from the approved ones | `failed` |
| `ACCOUNT_IDENTITY_MISMATCH` / `ACCOUNT_IDENTITY_UNVERIFIED` | The tab may be a different account | `failed` |
| `PROVIDER_REFUSED` | The provider rejected the message after Send | `failed` |
| `DELIVERY_UNKNOWN` | Send was clicked; no confirmation | `delivery_unknown` (reconcile) |
| `DRAFT_NOT_DELIVERABLE`, `REPLY_TARGET_NOT_FOUND`, `THREAD_MISMATCH` | Refused before claiming | `approved` (unchanged) |

## Overriding selectors

`data/messages/selectors.json` is keyed by provider (`outlook`, `teams`). Any key in `COMPOSE_SELECTOR_DEFAULTS` may be overridden there, plus `sendAckPattern` and `sendRefusalPattern` (case-insensitive regex source). Unknown keys and invalid patterns are ignored. The existing selector test (Messages → selectors) counts matches for every key in the file, so a compose key that only exists while a compose window is open will read as unmatched on an idle page.

## Privacy email lanes

The privacy opt-out and "update my records" email drafts use `pickEmailSenderAccount` (`server/lib/messageTransport.js`): an enabled, sendable, email-capable account, preferring a provider API (Gmail) over browser automation, and each draft carries that account's real `sendVia`. A Teams chat reaches a person, not a mailbox, so it is never chosen.

## Security posture

The automation uses only the browser the instance already runs and the sign-in you established; nothing is exposed beyond the private network, and no credential is read, stored or sent. Recipient addresses are not written to logs.
