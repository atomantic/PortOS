# Autofixer Integration

Autonomous crash detection and repair using Claude CLI.

## Architecture

- **Daemon Process** (`autofixer/server.js`): Monitors PM2 for crashed processes registered in PortOS
- **UI Server** (`autofixer/ui.js`): Web interface for viewing logs and fix history on port 5560
- **PM2 Integration**: Runs as `portos-autofixer` and `portos-autofixer-ui` processes

## Features

1. **Crash Detection**: Polls PM2 every 15 minutes for `errored` status on registered apps
2. **Auto-Fix**: Invokes Claude CLI with crash context (error logs, app info) to diagnose and repair
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
- History tab showing fix attempts with success/failure status
- Links back to PortOS Dashboard

## Configuration

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
