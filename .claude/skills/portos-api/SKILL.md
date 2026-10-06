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
node scripts/portos-api.js get /api/api-docs/catalog.json   # discover endpoints
```

- Credential order: `PORTOS_API_TOKEN` (set inside PortOS-spawned agents), then `~/.portos/agent-key.json` (the agent API key).
- `whoami` answering `"authenticated": false`, or a `401 AUTH_REQUIRED`, means no key is available: ask the user to turn on **Settings > Security > Agent API key**. Never ask for, store, or type the instance password.
- Never print the token or paste it into a commit, PR, issue, or chat.
- Public Suno publication and social posting still need the human (root `AGENTS.md`, Security Model).

Details: [docs/AGENT_API_KEY.md](../../../docs/AGENT_API_KEY.md).
