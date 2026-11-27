# Beeper

Beeper connects PortOS to a running Beeper Desktop API at `http://127.0.0.1:23373` by default. The Comms surface shows the local mirror and supports intentional outbound sends. Beeper Desktop remains the upstream source. PortOS performs no AI calls during ingestion.

## Setup

1. Enable **Comms → Beeper** under **Settings → Features**.
2. Open **Comms → Beeper** and its settings drawer. Use **Connect Beeper** for OAuth or paste a Desktop API token.
3. Turn on **Enable scheduled Beeper sync**. The first sweep starts on arming and subsequent sweeps use the configured interval, five minutes by default. The attachment budget defaults to 5 GB.
4. Use the loopback endpoint for a local Desktop process. An intentionally configured non-loopback endpoint requires its own explicit setting. Keep PortOS on its private network.

OAuth discovers Desktop's authorization server, uses dynamic client registration where advertised, and binds the local callback to the current authorization with state and PKCE. Follow the Desktop approval flow. A manually issued token uses the same credential-backed adapter and remains a supported path. The credential is separate from generic settings. Changes to credential, feature/group enablement or sync policy reconcile arming immediately. The interval is re-registered when changed. Disconnect revokes when possible, deletes the stored credential and disarms ingestion. Existing mirror data stays available.

A network connected both through Beeper and a built-in reader such as iMessage or Signal can appear twice. Choose the intended reader per network under Features.

## The mirror

A sweep refreshes the account roster, pages active chats and walks new messages using opaque per-chat cursors. It commits message rows, attachment references and the cursor together. A truncated walk keeps the chat eligible for the next sweep. A transient empty first message page is retried while the chat remains eligible. Chat order uses upstream activity. A recent chat with activity but no mirrored messages can show **Syncing…** as catch-up proceeds.

PostgreSQL stores accounts, conversations, participants, messages, attachment metadata and cursors. The realtime socket updates the mirror between sweeps. The sweep reconciles missed changes and tracks per-account results. A realtime change event prompts the client to reconcile state, and mutations apply their responses immediately. Unread views distinguish upstream message state and local read position.

Attachment bytes are cached on disk on demand, under the configured budget. Metadata and references remain even if the cache evicts bytes. Serving an attachment resolves it through its authorized mirror row and the cache. Purging one chat clears its local mirror and cursor, retaining bytes referenced elsewhere. A later sweep can mirror the chat again. Purge neither deletes the upstream conversation nor unsends messages.

## Sending

The composer creates an approved outbox record through an operator action. First contact needs explicit confirmation when neither the mirrored sender history nor the outbox identifies an existing outbound relationship. Dismissing an approved row removes unsent local work. After dispatch, the outcome is resolved through the upstream message ID or the follow-up confirmation path.

An in-flight send is never automatically POSTed a second time. A restart marks an interrupted `sending` record `SEND_INTERRUPTED` and restores the confirmation lookup for `awaiting-confirmation`. Check the upstream chat before retrying an interrupted send. A confirmation timeout can leave `CONFIRMATION_UNRESOLVED`, where delivery is possible and the composer offers no resend. Retry for a definitively failed row creates a new outbox entry. A row still in `approved` can be re-dispatched or dismissed because it never reached the peer. When the connection breaker is open, sending is disabled with the reason.

## Privacy and troubleshooting

The mirror contains private messages. Credentials, messages and attachment bytes stay on this install and are excluded from federation and automatic provider prompts. Log only bounded diagnostics without message text, tokens or private attachments. The deterministic mirror can add configured Tribe touchpoints while retaining messages in the Beeper domain.

Use the settings drawer to verify authentication, scheduler and realtime status. Check that Desktop's local API is running and bound to the configured endpoint. A failed sweep or unavailable socket is distinct from an empty mirror. The live [API Explorer](../API.md) lists installed Beeper operations. Server ownership lives under `server/services/beeper/`, with routes in `server/routes/beeper.js`.
