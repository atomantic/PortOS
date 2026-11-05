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

## FableLoom static export

The authenticated CLI supports read-only preflight, build, explicit job status/watch,
and protected binary download. Episode IDs retain their supplied package order.
Omitting episode IDs exports all episodes in story order. Draft media is refused
unless `--allow-draft true` is explicit; voice also requires `--characters true`.
Preflight reports graph, outline, production, media and approval findings before a
build. The build repeats validation and checks source bytes; preflight is not a
finished-package certification.

```sh
node scripts/portos-api.js fableloom-export preflight LOOM --episodes EP1,EP2 --player true --profile web-720p
node scripts/portos-api.js fableloom-export start LOOM --episodes EP1,EP2 --player true --profile web-720p
node scripts/portos-api.js fableloom-export status LOOM JOB
node scripts/portos-api.js fableloom-export watch LOOM JOB --timeout 1800
node scripts/portos-api.js fableloom-export download LOOM JOB --output story.zip
```

`watch` prints findings, progress and final size and exits nonzero for a failed or
cancelled job. Downloads use the same credential transport, write ZIP bytes to a
new file with private permissions and refuse overwriting an existing file. The
ZIP is a static managed artifact; these commands do not deploy or host PortOS.

## Diagnosing a rejected CoS credential

`401 AUTH_REQUIRED` is an authentication response, not an unavailable API.
The CLI distinguishes a missing credential from a rejected `PORTOS_API_TOKEN`
or Agent API key. A rejected injected token still takes precedence over a valid
key file: the CLI never retries with another credential. The response alone
cannot distinguish an expired, revoked, foreign, or incorrectly propagated token.

For a controlled fresh CoS run, request its own agent record with
`node scripts/portos-api.js get /api/cos/agents/<current-agent-id>` before claim
binding. Record only the HTTP result, selected credential source, launch mode,
and whether the configured destination is the intended install. Compare token
identity across launch boundaries only as an equality boolean; never print the
token, its hash, environment dumps, session records, or provider configuration.
A passing fresh run is a non-reproduction, not proof that an earlier rejection
was repaired. Preserve that distinction when recording investigation results.

Check explicit `PORTOS_URL` and the key file's destination locally. Obtain a fresh
CoS credential through a new authorized launch; do not mint one by importing the
auth service into a shell or weaken revocation. If the Agent API key is already
enabled, an explicit diagnostic request with `PORTOS_API_TOKEN` removed can test
that separate transport. Its success establishes availability and key validity,
not the cause of the injected token's failure. Do not enable or rotate credentials
merely to make an investigation pass. Public-content reviewers must remain
without host API credentials.
