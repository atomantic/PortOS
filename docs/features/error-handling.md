# Graceful Error Handling

Enhanced error handling system with automatic recovery and UI notifications.

## Architecture

- **Error Handler** (`server/lib/errorHandler.js`): Centralized error normalization and Socket.IO emission
- **Auto-Fixer** (`server/services/autoFixer.js`): Automatic agent spawning for critical errors
- **Socket.IO Integration**: Real-time error notifications to connected clients
- **Route Protection**: All routes use asyncHandler wrapper for consistent error handling

## Features

1. **Graceful Error Handling**: Server never crashes, all errors caught and handled
2. **Socket.IO Error Events**: Real-time error notifications to UI with severity and context
3. **Auto-Fix Tasks**: Critical errors automatically create CoS tasks for agent resolution
4. **Error Recovery UI**: Client can request manual error recovery via Socket.IO
5. **Process Error Handlers**: Unhandled rejections and exceptions trigger auto-fix
6. **Error Deduplication**: Prevents duplicate auto-fix tasks within 1-minute window

## Error Severity Levels

| Severity | Description | Auto-Fix |
|----------|-------------|----------|
| warning | Non-critical issues | No |
| error | Server errors, failures | No |
| critical | System-threatening errors | Yes |

## Socket.IO Events

| Event | Direction | Payload |
|-------|-----------|---------|
| error:occurred | Server → Client | Error details with severity, code, timestamp |
| system:critical-error | Server → Client | Critical errors only |
| error:notified | Server → Subscribers | Error notification to subscribed clients |
| errors:subscribe | Client → Server | Subscribe to error events |
| errors:unsubscribe | Client → Server | Unsubscribe from error events |
| error:recover | Client → Server | Request manual error recovery |
| error:recover:requested | Server → Client | Recovery task created confirmation |

## Auto-Fix Flow

1. Error occurs in route or service
2. `asyncHandler` catches and normalizes error
3. Error emitted to `errorEvents` EventEmitter
4. `autoFixer` checks if error should trigger auto-fix
5. If yes, creates CoS task with error context
6. Socket.IO broadcasts error to all connected clients
7. CoS evaluates and spawns agent to fix the error
8. Agent analyzes, fixes, and reports back

## Error Context

Errors include rich context for debugging:
- Error code and message
- HTTP status code
- Timestamp
- Stack trace (for 500+ errors)
- Custom context object
- Severity level
- Auto-fix flag

## Browser Error Capture

`main.jsx` wires `window.onerror` + `unhandledrejection` to `reportClientError`, which
POSTs to `/api/client-errors`; the aggregator surfaces each unique group in the Review Hub
as a `type: 'alert'` item (`metadata.category: 'client-error'`).

### Extension errors are filtered out

Extensions (wallets, password managers, ad blockers) inject content scripts into the page's
realm, so anything they throw lands in **our** handlers. Those errors are not in the app's
control and not actionable — the user cannot fix MetaMask by changing PortOS — so
`isExtensionError()` drops them at both ends.

Detection is **provenance-first**: an extension URL scheme (`chrome-extension://`,
`moz-extension://`, `safari-web-extension://`, `webkit-masked-url://`, …) in the script
`source` or at the stack's **originating frame** proves the throw site is not ours. This
does the real work — every extension error observed so far carries such a frame. A single
message pattern (`MetaMask`) backstops the one case provenance cannot see: a wallet
rejecting with a bare string, which carries no frames at all.

Five constraints worth preserving when touching this:

- **Filter before the throttle, on both ends.** The client reporter and the server
  aggregator each gate on a 1/sec throttle. An extension error that takes the slot drops a
  genuine PortOS error arriving <1s behind it. Filtering early keeps the budget for errors
  we can act on — it is a correctness rule, not an optimization.
- **Only the originating (top) frame counts — never "any frame in the stack".** An
  extension that wraps or synchronously invokes our code (a patched `fetch`, an injected
  provider, a dispatched event) leaves its frames *below* ours, so a genuine PortOS error
  that merely passed through extension code carries an extension URL in its stack. Matching
  any frame would silently drop it forever. `originatingFrame()` handles both stack
  dialects — V8 (`at fn (url:1:1)`, after a `Type: message` line) and Firefox/Safari
  (`fn@url:1:1`).
- **Detect on the raw payload (server).** `sanitize()` caps the stack at 4000 chars, so a
  long first line can push the originating frame past the cut and hide the provenance.
- **Never match on `url`.** That field is the *page* location, which is ours even when an
  extension throws on top of it. Only `source` / `stack` / `message` are evidence.
- **Keep the message list near-empty.** Each pattern is a permanent silent-drop rule, and
  the failure modes are asymmetric: a missed extension error is noise the user dismisses in
  one click, while an over-broad pattern hides a real bug forever. Add one only when a real
  observed error escaped provenance *and* the string is absent from our source. Cautionary
  case: `crypto.randomUUID is not a function` *looks* like extension noise but was our own
  crash on insecure origins (see `client/src/lib/uuid.js`) — its live alert had no
  extension frame at all. It is explicitly not filtered, and regression tests pin that on
  the predicate, the aggregator, and the cleanup migration.

The server re-checks rather than trusting the client: PortOS installs update on their own
schedule and a long-lived tab keeps running an old bundle.

The filter is prospective, so `scripts/migrations/196-dismiss-extension-error-alerts.js`
applies the same predicate once to alerts already filed (status → `dismissed`, never
deleted), so existing installs converge instead of carrying stale extension alerts forever.

## Implementation Files

| File | Purpose |
|------|---------|
| `server/lib/errorHandler.js` | Error classes, asyncHandler, middleware |
| `server/lib/extensionErrors.js` | `isExtensionError()` — browser-extension detection (authoritative; mirrored to `client/src/lib/extensionErrors.js`) |
| `server/services/clientErrors.js` | Client-error aggregator: extension filter → throttle → redact → dedup → Review Hub alert |
| `client/src/lib/clientErrorReporter.js` | Browser-side capture + POST, with the same extension filter at the source |
| `server/services/autoFixer.js` | Auto-fix task creation and deduplication |
| `server/services/socket.js` | Socket.IO error event forwarding |
| `server/routes/*.js` | All routes use asyncHandler wrapper |
| `client/src/hooks/useErrorNotifications.js` | Client-side error event handler with toast notifications |
| `client/src/components/Layout.jsx` | Mounts error notification hook for app-wide coverage |

## Related Features

- [Chief of Staff](./chief-of-staff.md)
- [Autofixer](./autofixer.md)
