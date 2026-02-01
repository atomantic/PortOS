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

## Implementation Files

| File | Purpose |
|------|---------|
| `server/lib/errorHandler.js` | Error classes, asyncHandler, middleware |
| `server/services/autoFixer.js` | Auto-fix task creation and deduplication |
| `server/services/socket.js` | Socket.IO error event forwarding |
| `server/routes/*.js` | All routes use asyncHandler wrapper |
| `client/src/hooks/useErrorNotifications.js` | Client-side error event handler with toast notifications |
| `client/src/components/Layout.jsx` | Mounts error notification hook for app-wide coverage |

## Related Features

- [Chief of Staff](./chief-of-staff.md)
- [Autofixer](./autofixer.md)
