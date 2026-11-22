# Agent Client Protocol (ACP) adapter

`scripts/portos-acp.js` lets editors that speak the [Agent Client Protocol](https://agentclientprotocol.com) (Zed, VS Code through an ACP client extension, JetBrains IDEs, Neovim plugins) talk to this machine's running PortOS. An editor launches it as a child process and exchanges newline-delimited JSON-RPC over stdin/stdout. The adapter forwards each prompt to PortOS over loopback HTTP and streams the answer back.

It is a thin client. It holds no provider keys and runs no model. Every answer, tool call and capability check happens inside PortOS under the settings you already have, so the editor gains no authority the local CLI agents lack.

## Modes

| Mode | Backend | What it can do |
|------|---------|----------------|
| `ask` (default) | `POST /api/ask` (Ask Yourself) | Digital Twin answers grounded in your Brain, Memory, Autobiography, Goals, Calendar and Catalog. Read-only and tool-free. Retrieval appears as one completed `search` tool call listing the sources. |
| `mind` | `POST /api/cos/mind/messages` plus `GET /api/cos/mind/stream` | Sends a message to the resident Persistent Mind and streams its turn back: thoughts as `agent_thought_chunk`, governed tool activity as `tool_call` / `tool_call_update`, and the reply as `agent_message_chunk`. The mind's capability grants apply exactly as configured in PortOS's Persistent Mind settings. Sending a message counts as consent to start or resume the mind, as it does from the PortOS UI. |

Pick the default for new sessions with `--mode ask|mind`. An editor can also switch a fresh session through the `mode` config option (`session/set_config_option`) or `session/set_mode`. Once a session has a PortOS conversation its mode is fixed; start a new session to use the other one.

## Setup

1. Make sure PortOS is running, then pick a credential. A PortOS-spawned agent already has `PORTOS_API_TOKEN`. Anything else, including an editor, uses the opt-in Agent API key: turn on **Settings → Security → Agent API key** ([AGENT_API_KEY.md](./AGENT_API_KEY.md)). With no instance password set, no credential is needed.
2. Check the connection. This makes no model call:

   ```bash
   node <repo-root>/scripts/portos-acp.js --check
   # ✅ PortOS is reachable at http://127.0.0.1:5555; no password is set.
   ```

   It exits non-zero with the reason on stderr when PortOS is unreachable or rejects the credential.
3. Add the adapter to your editor using the snippets below. Replace `<repo-root>` with the PortOS checkout path.

The base URL resolves exactly as it does for `scripts/portos-api.js`: `PORTOS_URL`, then the Agent API key file's `url`, then the local listener. That is `http://127.0.0.1:5555`, or the loopback HTTP mirror on `:5553` when HTTPS is enabled. The adapter connects only to that address. Never point `PORTOS_URL` at a public relay: PortOS stays on your private network.

### Zed

`settings.json`:

```json
{
  "agent_servers": {
    "PortOS": {
      "type": "custom",
      "command": "node",
      "args": ["<repo-root>/scripts/portos-acp.js"],
      "env": {}
    }
  }
}
```

Add a second entry with `"args": ["<repo-root>/scripts/portos-acp.js", "--mode", "mind"]` to keep a Persistent Mind agent beside the Ask Yourself one. Older Zed builds omit the `"type"` field.

### VS Code

With an ACP client extension installed, register the adapter under that extension's agent list (for example `acp.agents` in `settings.json`):

```json
{
  "acp.agents": {
    "PortOS": {
      "command": "node",
      "args": ["<repo-root>/scripts/portos-acp.js"]
    }
  }
}
```

### JetBrains

JetBrains IDEs with ACP agent support read `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "PortOS": {
      "command": "node",
      "args": ["<repo-root>/scripts/portos-acp.js"]
    }
  }
}
```

### Neovim

ACP-capable plugins (CodeCompanion, avante.nvim) accept a command and arguments for a custom ACP agent: `node <repo-root>/scripts/portos-acp.js`.

Each editor owns its settings key. If your release names it differently, keep the command and arguments and follow the editor's ACP documentation.

## Protocol coverage

| Method | Behavior |
|--------|----------|
| `initialize` | Protocol version 1. Advertises `loadSession`, `sessionCapabilities.list`, text plus embedded-context prompts, no image or audio, no client MCP transports and no auth methods. Makes no PortOS call. |
| `session/new` | Returns a session id with its mode and config options. Writes nothing and calls nothing in PortOS: an editor probing for models leaves no empty conversation behind. Client `mcpServers` are ignored, because PortOS owns its own tools. |
| `session/prompt` | Text, resource links and embedded text resources are sent as written; nothing is rewritten or truncated. A prompt over a backend's limit gets that route's validation error back. Image and audio blocks are refused, never dropped silently. Ends with `end_turn`, or `cancelled` after `session/cancel`. |
| `session/cancel` | Aborts the upstream request. In `ask` mode the server stops the provider when the stream closes and keeps the question and any partial answer. In `mind` mode the adapter stops waiting, but the shared resident mind still finishes the turn it already took. |
| `session/load` | Replays history from PortOS: the Ask conversation's turns, or the session's own exchanges still in the mind's newest trajectory page (500 events). Updates the stored editor `cwd`. |
| `session/list` | Lists saved sessions newest first, optionally filtered by `cwd`, with a `nextCursor` for paging. |
| `session/set_mode`, `session/set_config_option` | Switch a session between `ask` and `mind` until its first prompt. |

`stdout` carries protocol lines only. Diagnostics go to stderr, so an editor's agent log shows them. A JSON-RPC `-32000` error means PortOS rejected or was missing the credential, and the message says which credential was tried.

## Session records

The editor-side session index lives in `~/.portos/acp-sessions.json`, mode `0600`, or `$PORTOS_ACP_SESSIONS_FILE`. A record is written only after a session's first prompt reaches PortOS. It maps the ACP session id to its mode, editor `cwd`, title (the first prompt's opening words) and PortOS conversation or mind message ids, keeping the newest 200 sessions. Message text stays in PortOS and is replayed from there. Deleting the file forgets the editor sessions; the PortOS conversations remain.

The mind stream route `GET /api/cos/mind/stream` sends the same trajectory events the PortOS UI receives over Socket.IO (`cos:mind:event`), behind the same `/api/*` auth gate, and replays nothing.
