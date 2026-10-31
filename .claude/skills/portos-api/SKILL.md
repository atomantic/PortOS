---
name: portos-api
description: Call this machine's PortOS API from a Claude Code or Codex session PortOS did not spawn — create Chief of Staff tasks, run image generation, drive music video projects — without the instance password. Invoke before any curl or script against PortOS's own /api.
---

# Calling the PortOS API from an outside session

Use the bundled CLI. It finds the URL and credential itself:

```bash
node scripts/portos-api.js whoami
node scripts/portos-api.js task "<what the agent should do>" --app <app-id> --priority MEDIUM
node scripts/portos-api.js get /api/cos/tasks
node scripts/portos-api.js post /api/image-gen/generate '{"prompt":"..."}'
node scripts/portos-api.js post /api/music-video/autonomous @brief.json
node scripts/portos-api.js post /api/human-actions/plans @plan.json   # schedule steps the user must take
node scripts/portos-api.js get /api/api-docs/catalog.json   # discover endpoints
```

- When the user has to do something by hand later (post, reply, upload, sign), schedule it with `POST /api/human-actions/plans` instead of only saying so in chat: each step gets a due time with a UTC offset, explicit `instructions`, and the exact text to paste in `content`. It lands in Review Hub › Actions and notifies them when due. Reuse the same `planKey` to replace a plan. Shape: [docs/API.md › Human Actions](../../../docs/API.md#human-actions).

- URL order: `PORTOS_URL`, then the agent key file’s URL, then the configured local HTTP listener. With a usable TLS certificate, the fallback uses the loopback HTTP mirror and honors `PORTOS_HTTP_PORT` (exported value, then `.env`, then the shared default). Explicit URLs are never retried against a different listener.
- Credential order: `PORTOS_API_TOKEN` (set inside PortOS-spawned agents), then `~/.portos/agent-key.json` (the agent API key).
- `401 AUTH_REQUIRED` means authentication was rejected: check whether the selected credential is missing, expired, revoked, or invalid without printing it. A set `PORTOS_API_TOKEN` takes precedence over the agent-key file, so a stale injected token can shadow a valid key; obtain a fresh credential through the supported flow. `whoami` answering `"authenticated": false` alone does not prove a missing key, since local requests may be allowed when authentication is disabled. If an external agent needs authentication and no credential is available, ask the user to enable **Settings > Security > Agent API key**. Never ask for, store, or type the instance password.
- Never print the token or paste it into a commit, PR, issue, or chat.
- Public Suno publication and social posting still need the human (root `AGENTS.md`, Security Model).

Details: [docs/AGENT_API_KEY.md](../../../docs/AGENT_API_KEY.md).

For an outside terminal agent, use the assigned GitHub/GitLab repository and your authorized forge identity. The hosting provider enforces merge eligibility; pin the PR head and confirm its merged state. Do not require a PortOS admission lease, local attestation, preparation turn or additional configuration as merge certification. Never invent or borrow a CoS `agentId`. Local cleanup still uses authenticated PortOS APIs and verifies the exact target, active ownership and unique content.

For FableLoom static package handoff, use `fableloom-export preflight|start LOOM`
with `--episodes EP1,EP2`, `--player true`, `--characters true`, `--voice true`,
`--allow-draft true`, `--profile source|web-720p|web-1080p`, and `--webm true`
as needed. Flags are explicit values; voice requires character opt-in. Inspect
preflight findings before `start`. Use `fableloom-export status|watch LOOM JOB`
for findings/progress/size, then `fableloom-export download LOOM JOB --output
story.zip` for its protected ZIP (refuses overwrite). This exports a static
artifact and never deploys PortOS. See `docs/AGENT_API_KEY.md`.
