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

## Outside-agent merge admission

An outside terminal agent uses `POST /api/cos/merge-admission/external`; it does
not create a CoS agent record or borrow another run's `agentId`. The existing
operator boundary applies: a verified session (including the agent key) when
password protection is on, or a genuine local connection when it is off.
Anonymous remote and scoped peer requests cannot acquire or release admission.

Create one secret for this run and retain it until release is confirmed:

```bash
export PORTOS_ADMISSION_SESSION="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
```

`portos-api.js` sends it as `X-PortOS-Admission-Session` only to the external
admission endpoint. Keep it out of logs, reviewer environments, PRs and shared
files. It separates concurrent terminal runs sharing the same agent-key
credential. The server stores only a hash bound to the verified credential
identity. A different credential or run secret cannot check or release the
handle, even if it knows the lease token. Rotating/revoking the credential
invalidates its authority; an interrupted holder remains reserved until the
five-minute maximum hold elapses. This is the same bounded coordination as CoS
leases, not a forge-side fence against a merge already in flight at expiry.

Before acquiring, finish all configured reviews, required CI for the exact PR
head, and this repository's combined-tree structural guards **outside** the
lease. Keep the checked head and base SHAs and the base branch name. The worktree-private
`portos-review-status` file must name that exact `REVIEW_HEAD` and the workflow's
`REVIEW_STATUS=clean`, or `optional-inconclusive` when all configured reviewers
are optional and unavailable. The latter records an attempted head, never a
clean reviewer verdict. The outside operator remains responsible for satisfying
its configured review policy; admission is coordination, not CI certification.

Write the acquisition request to a private JSON file (mode `0600`). For example:

```json
{
  "action": "acquire",
  "appId": "example-app",
  "worktreePath": "/example/repository-worktree",
  "prUrl": "https://github.com/example/repo/pull/7",
  "headSha": "1111111111111111111111111111111111111111",
  "baseBranch": "main",
  "baseSha": "2222222222222222222222222222222222222222"
}
```

```bash
node <portos-root>/scripts/portos-api.js post /api/cos/merge-admission/external @admission-target.json
```

The app must already exist in the local app registry. The server verifies its
origin and the checkout's real Git common directory, separate linked checkout,
branch, identity, local review receipt, live same-repository open PR, head and
base branch/SHA. The base SHA is the live `refs/heads/<baseBranch>` commit,
not GitHub's historical PR `baseRefOid`. Acquire and check read that ref with
the PR's repository, base branch and head through the app's authorized forge
transport; a moved or missing ref withholds admission until guards are rerun.
An active/uncertain CoS owner, checkout lock, retirement fence, changed
proof or unreadable state withholds admission. Fork PRs and detached/primary
checkouts are outside this bounded flow. Repository keys are shared with CoS
parents and the pending-merge sweep, so all three contend on the same lease;
different repositories remain independent.

Only `admitted: true` grants a lease. Retain its opaque `token` privately. A
repeat acquire by the same credential and run secret for the unchanged target
returns the same token without extending its deadline. Check and release take
no caller-selected target:

```json
{"action":"check","token":"<lease UUID>"}
```

```json
{"action":"release","token":"<lease UUID>","outcome":"merged"}
```

Use the same CLI endpoint and secret for both. Inside admission, perform the
final live PR/required-check read and confirm both the recorded head and base;
`check` also revalidates the stored target. If either SHA changed, release with
`resync`, repeat the relevant validation outside the lease, then acquire again.
Merge with `gh pr merge --match-head-commit <CI-verified-head>` and the repository's
chosen merge method; never use `--delete-branch`, `--admin` or deferred auto-merge.
Read the remote PR back and require `MERGED` at the expected head. Release with
`merged`, or `leave-open` when no merge occurred, and require `released: true`
before any cleanup. Release remains available to the same owner after a merge
or checkout change. Use the supported checkout preservation/retirement service
for cleanup; admission itself never mutates a checkout or Git ref.

A timeout, failed persistence or uncertain response is not proof of release.
Preserve the checkout/ref and handle, resolve the actual outcome, and report a
blocker if it cannot be established. Do not edit the CoS state file, manufacture
a running parent, or borrow another owner's token. After expiry, an old holder
must reacquire and repeat final live checks; its old token cannot release a
successor's lease.
