# iTerm2 sessions on the Shell page

On a Mac running iTerm2, PortOS can list the terminals you already have open in iTerm2, show one live with its colors and cursor, and type into it. This is the Shell page's **iTerm2 view** (#8114). On any other host nothing changes: there is no iTerm2 UI, no connection attempt, and no AppleScript runs.

## Requirements

- macOS, with iTerm2 installed in `/Applications/iTerm.app` or `~/Applications/iTerm.app`.
- iTerm2's Python API turned on: **iTerm2 → Settings → General → Magic → Enable Python API**. (PortOS does not use Python; the setting enables the API server that PortOS talks to.)
- The **iTerm2 sessions** feature on in **Settings → Features**. On a fresh install it turns on by itself when the two checks above pass. The check only looks for the app bundle and reads one `defaults` value (`com.googlecode.iterm2 EnableAPIServer`). It never runs AppleScript and never connects.

The first time PortOS connects, macOS may ask whether PortOS (the process running `osascript`) may control iTerm2. Allow it under **System Settings → Privacy & Security → Automation**.

## Security

Input is delivered to the selected live terminal exactly as typed and can run commands with the host user's privileges. Treat access to the PortOS socket as host-command access; this view adds no command allowlist. PortOS authentication and HTTPS are optional and off by default, so keep the instance on its private network and use a strong, unique instance password.

## Using it

With the feature on, the Shell page header shows a `PortOS | iTerm2` switch. `/shell` and `/shell/:sessionId` stay PortOS shells. `/shell/iterm` lists the iTerm2 sessions, grouped window › tab › pane, and `/shell/iterm/iterm-<uuid>` opens one directly (⌘K "iterm" goes there too). The view has an amber iTerm2 frame and badge plus a `cols×rows · sized by iTerm` geometry badge. The input helpers (Ctrl-C, Esc, arrows, paste, quick commands, fullscreen) all work. New, Stop, Restart, the cd picker and the provider launcher are absent on purpose.

## How it works

- **In-process and demand-driven.** `server/services/itermBridge.js` holds one WebSocket to iTerm2's private Unix socket (`~/Library/Application Support/iTerm2/private/socket`, subprotocol `api.iterm2.com`). It connects only while the feature is on **and** a browser is listing or viewing iTerm2 sessions (`iterm:list`). It disconnects 60s after the last viewer leaves, and at once when the feature is turned off. Server boot never connects.
- **Never launches iTerm2.** Before every connection attempt it checks `application "iTerm2" is running`. Only then does it ask iTerm2 for a fresh auth cookie (`request cookie and key for app named "PortOS"`). A plain `tell application` would launch the app. The cookie is never logged.
- **Streams only what you view.** Screen-update notifications are subscribed per session only while it is being viewed. A burst of updates collapses into one buffer fetch in flight plus one trailing fetch. Each fetch becomes one full-screen ANSI repaint (`server/lib/itermScreenRender.js`).
- **Input is exact and ordered.** Keystrokes, escape sequences and bracketed pastes are sent byte-for-byte through a per-session queue.
- **iTerm2 owns size and lifecycle.** The web view never resizes the iTerm2 window, because a phone would shrink the desktop window. The server reports iTerm2's grid and the view sizes itself to match. PortOS cannot create, close or restart iTerm2 sessions; leaving a session only stops viewing it.
- **Reconnects by itself.** If iTerm2 quits, the list clears and the status becomes `not-running`. PortOS retries with backoff (1s → 2s → … capped at 30s) while the view is open, and reconnects once iTerm2 is running again.

## Status states

`GET /api/iterm/status` returns capability state only, `{ state, detail }`, never session contents.

| State | Meaning | Fix |
|---|---|---|
| `unsupported-platform` | Not macOS | None; the feature does not apply |
| `not-installed` | No iTerm.app found | Install iTerm2 in `/Applications` or `~/Applications` |
| `api-disabled` | iTerm2's API server is off | iTerm2 → Settings → General → Magic → Enable Python API |
| `not-running` | iTerm2 isn't running | Launch iTerm2; PortOS never launches it |
| `auth-failed` | iTerm2 refused the cookie request | Allow PortOS to control iTerm2 in System Settings → Privacy & Security → Automation |
| `connect-failed` | The socket or handshake failed | Check that the API is enabled and iTerm2 is up to date |
| `disconnected` | Not currently connected (nothing is viewing, or the feature is off) | None needed |
| `connected` | Live | None needed |

## Why iTerm2 sessions are separate from PortOS shells

iTerm2 sessions have their own registry (`itermBridge.js`) and their own socket events (`iterm:list`, `iterm:unlist`, `iterm:attach`, `iterm:detach`, `iterm:input`, and outbound `iterm:sessions`, `iterm:attached`, `iterm:output`, `iterm:exit`, `iterm:error`). They are **never** added to `server/services/shell.js` `shellSessions`. That registry also feeds the Workspaces widget (`workspaceContext.js` groups `listAllSessions()` by cwd), the session cap, and the agent runners' session lookups. Registering iTerm2 sessions there would leak them into Workspaces. It would also force iTerm2 special cases into kill/resize/attach and put the pause-while-watched behavior of TUI runs at risk. `itermBridge.test.js` asserts the bridge's import graph never reaches `shell.js` or `workspaceContext.js`.

Nothing here enters federation or sync. iTerm2 sessions stay on this machine.

## Clean-room protocol rule

iTerm2 and its Python client are GPLv2; PortOS is MIT. The wire codec (`server/lib/protobufWire.js`) and the message declarations (`server/lib/itermMessages.js`) are written by PortOS. They declare only the messages and fields PortOS uses, with field numbers that match iTerm2's published API protocol. **Do not vendor `api.proto`, paste its text, or port reference-client code.** Unknown fields on the wire are skipped, so declaring less than the full protocol is safe.
