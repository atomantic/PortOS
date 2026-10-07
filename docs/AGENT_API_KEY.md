# Agent API key

Lets an AI agent that PortOS did **not** spawn — a Claude Code or Codex session you run in a terminal on the PortOS machine — call the PortOS API without the instance password. Agents PortOS spawns already get `PORTOS_API_TOKEN` injected (`server/services/agentApiAuth.js`) and need nothing here.

## Turning it on

**Settings > Security > Agent API key > Turn on.** The card appears once a login password is set; without a password the API needs no credential.

While on, the server keeps one session token (label `agent-key`) in `~/.portos/agent-key.json`, with the file at mode `0600` and its directory at `0700`:

```json
{
  "version": 1,
  "url": "http://127.0.0.1:5553",
  "token": "<session token>",
  "sessionId": "<opaque id>",
  "expiresAt": "<ISO time>",
  "cli": "<repo-root>/scripts/portos-api.js",
  "usage": "Send \"Authorization: Bearer <token>\" to url. ..."
}
```

`url` is the loopback origin for this install: the HTTP mirror on `:5553` when HTTPS is on, else `:5555`. Set `PORTOS_AGENT_KEY_FILE` (for both the server and the CLI) to use another path, for example when two installs share one home directory.

The server re-mints the key a week before its 30-day session expires (checked at boot and daily), and right after a password change or log-out-everywhere drops every session. **Rotate** replaces it on demand. **Turn off and revoke** revokes the session and deletes the file.

## Calling the API

```bash
node <repo-root>/scripts/portos-api.js whoami
node <repo-root>/scripts/portos-api.js task "Fix the flaky upload test" --app portos --priority HIGH
node <repo-root>/scripts/portos-api.js get /api/cos/tasks
node <repo-root>/scripts/portos-api.js post /api/image-gen/generate '{"prompt":"a lighthouse at dusk"}'
node <repo-root>/scripts/portos-api.js post /api/music-video/autonomous @brief.json
node <repo-root>/scripts/portos-api.js get /api/api-docs/catalog.json
```

`npm run --silent api -- <args>` from the repo root is the same command. Bodies can be inline JSON, `@file`, or `-` for stdin. A path without `/api/` or `/data/` gets `/api` prepended. Output is the response body; a non-2xx exits 1 with the body on stderr.

`PORTOS_API_TOKEN` and `PORTOS_URL`, when set, win over the key file, so the same command works inside a PortOS-spawned agent.

Requests wait up to 30 minutes for long-running AI routes, including reading the response body. Pass `--timeout <seconds>` to change that deadline, for example `portos-api post /api/music-video/autonomous @brief.json --timeout 3600`. A timeout closes the client connection and reports the elapsed limit; the server may still be working, so check the outcome before submitting the same operation again.

Plain `curl` works too:

```bash
curl -sS "$(jq -r .url ~/.portos/agent-key.json)/api/cos/tasks" \
  -H "Authorization: Bearer $(jq -r .token ~/.portos/agent-key.json)"
```

## Security model

- The key is a session token, never the password. It carries the same operator authority as a signed-in browser or a PortOS-spawned agent, and the request audit identity names it as the `agent-key` session.
- Holding the token is the only thing that grants it. Requests are never trusted for arriving on loopback: Tailscale serve and the dev proxy both deliver remote traffic to `127.0.0.1`.
- Anything that can read a `0600` file in the host user's home already runs as that user and could mint a session from `data/auth-sessions.json`, so the file widens no boundary. It lives outside `data/` so backups and peer sync never carry the plaintext token (`auth-sessions.json` stores hashes only).
- The on/off flag lives under `secrets.agentKey` in `settings.json`, out of reach of the generic settings GET/PUT. `PUT /api/auth/agent-key` and `POST /api/auth/agent-key/rotate` are on the host-control list (`server/lib/hostControlRoutes.js`). `GET /api/auth/agent-key` reports state and never the token.
