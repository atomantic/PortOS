# Autofixer Integration

Autonomous crash detection and isolated repair using the configured CLI provider. Validated fixes are staged by default; the live app stays unchanged until the operator applies a patch.

## Architecture

- **Daemon Process** (`autofixer/server.js`): Monitors PM2 for crashed processes registered in PortOS
- **UI Server** (`autofixer/ui.js`): Web interface for viewing logs and fix history on port 5560
- **PM2 Integration**: Runs as `portos-autofixer` and `portos-autofixer-ui` processes

## Features

1. **Crash Detection**: Polls PM2 every 15 minutes for `errored` status on registered apps
2. **Isolated repair**: Invokes the CLI provider selected in Settings → Autofixer with crash context, validates the patch, and optionally runs the configured verify command
3. **Session History**: Stores fix attempts with prompts, outputs, and success/failure status
4. **Cooldown**: 30-minute cooldown per process to prevent repeated fix loops
5. **Log Streaming**: Real-time SSE log streaming from any PM2 process
6. **Tailscale Compatible**: Dynamic hostname for remote access

## Data Storage

```
./data/autofixer/
├── index.json           # Fix session index
└── sessions/
    └── {sessionId}/
        ├── prompt.txt    # Prompt sent to Claude
        ├── output.txt    # Claude's response
        └── metadata.json # Session details
```

## Autofixer UI

Port 5560 provides:
- Process sidebar with live status indicators
- SSE-powered log viewer with pause/clear controls
- History tab showing staged fixes per app, patch diffs, and Apply and restart / Discard actions
- Apply and Discard require an operator session, or a genuine local connection when no password is configured
- Links back to PortOS Dashboard

## Configuration

Settings → Autofixer offers **Apply fixes automatically** (off by default) and an optional **Verify command**, run in the isolated checkout before a fix is staged or applied. Enabling automatic application applies validated patches to the live checkout and restarts the process. Manual application checks that the patch still applies and rolls it back if restart fails. Discard retires the proposal while retaining its history artifact.


| Setting | Value |
|---------|-------|
| UI Port | 5560 |
| Check Interval | 15 minutes |
| Fix Cooldown | 30 minutes |
| Max History | 100 entries |

## Related Features

- [Error Handling](./error-handling.md)
- [Chief of Staff](./chief-of-staff.md)
- [PM2 Configuration](../PM2.md)
