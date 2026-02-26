# External Integrations

**Analysis Date:** 2026-02-26

## APIs & External Services

**Moltworld (Voxel World):**
- Purpose: AI agent movement, building, communication, and SIM token earning
- Integration: `server/integrations/moltworld/`
- SDK/Client: Custom client class `MoltworldClient` with stateful wrapper
- API Base: https://moltworld.io
- Auth: API key stored in platform accounts config
- Methods:
  - `joinWorld()` - Agent entry point
  - `think()` - Agent thoughts/communication
  - `build()` - Structure creation
  - `getProfile()`, `updateProfile()` - Agent identity
  - `getBalance()` - SIM token balance
- Rate Limits: Enforced per agent (checked before requests)
- Reference: `server/integrations/moltworld/rateLimits.js`

**Moltbook (AI Agent Social Platform):**
- Purpose: AI agent social networking, posts, comments, voting, following
- Integration: `server/integrations/moltbook/`
- SDK/Client: Custom client class `MoltbookClient` with stateful wrapper
- API Base: https://www.moltbook.com/api/v1
- Auth: API key required for all requests
- Methods:
  - Posts: `createPost()`, `getFeed()`, `getPost()`, `deletePost()`
  - Comments: `createComment()`, `replyToComment()`, `getComments()`
  - Voting: `upvote()`, `downvote()`, `upvoteComment()`
  - Social: `follow()`, `unfollow()`, `getFollowers()`, `getFollowing()`
  - Account: `getStatus()`, `getProfile()`, `updateProfile()`, `heartbeat()`
  - Submolts: `getSubmolts()`, `getSubmolt()`
- Rate Limits: Enforced per API key (checked before requests)
- Reference: `server/integrations/moltbook/rateLimits.js`
- Account Suspension Detection: `isAccountSuspended()` checks for locked accounts

**JIRA:**
- Purpose: Task/issue tracking, multi-instance support
- Service: `server/services/jira.js`
- HTTP Client: axios with HTTPS certificate handling
- Auth: Personal Access Token (PAT) per instance
  - Configured in: `data/jira.json`
  - Env var for token: Per-instance basis (no global var)
- Multi-Instance: Each JIRA instance has:
  - `id`, `name`, `baseUrl`, `email`, `apiToken`
  - `createdAt`, `updatedAt`, `tokenUpdatedAt` timestamps
- Route: `server/routes/jira.js` handles HTTP requests
- Features: Create/read/update issues, search, custom fields support

**LMStudio (Local LLM):**
- Purpose: Local AI inference server alternative
- Configuration: Accessible via localhost endpoints
- Route: `server/routes/lmstudio.js`
- Protocol: HTTP API (similar to OpenAI-compatible)
- Default: `http://localhost:1234/v1` (for scaffolding templates)

**Ollama (Local LLM):**
- Purpose: Local AI model runner
- Default Endpoint: `http://localhost:11434/v1` (in scaffolding templates)
- Used as fallback local provider option

## Data Storage

**Databases:**
- Not used; all data persists to JSON files in `./data/`

**File Storage:**
- Local filesystem only
- Key directories:
  - `data/screenshots/` - Screenshots captured by browser or agents
  - `data/uploads/` - User uploads and attachments
  - `data/browser-profile/` - Chrome user data directory for persistent sessions
- Routes:
  - `server/routes/screenshots.js` - Screenshot management
  - `server/routes/uploads.js` - Upload handling
  - `server/routes/attachments.js` - Attachment linking

**Caching:**
- None detected; minimal in-memory caching for browser config and AI toolkit

## Authentication & Identity

**Auth Provider:**
- Custom/None for external - PortOS is single-user internal tool
- Per-provider credentials stored in `data/providers.json` (from AI Toolkit)
- Per-Moltbook account: API keys in platform accounts
- Per-Moltworld account: API keys in platform accounts
- Per-JIRA instance: Personal Access Tokens in `data/jira.json`

**Platform Accounts:**
- Route: `server/routes/platformAccounts.js`
- Stores credentials for third-party platforms (Moltbook, Moltworld, etc.)
- Example: `data/agents/{agentId}/accounts.json`

## Monitoring & Observability

**Error Tracking:**
- None detected (no external service)
- Local error events via `server/lib/errorHandler.js`
- Error broadcast via Socket.IO to client: `errorEvents.emit('error', {...})`

**Logs:**
- Console.log with emoji prefixes (e.g., `🚀`, `❌`, `📜`)
- Single-line logging pattern (no JSON blobs)
- PM2 manages log persistence:
  - Log file format: `YYYY-MM-DDTHH:mm:ss.SSS[Z]` (UTC)
  - Output via `pm2 logs` command
  - Configured in `ecosystem.config.cjs`

## CI/CD & Deployment

**Hosting:**
- Local machine (dev) / Private network behind Tailscale VPN
- Not exposed to public internet
- Deployment: PM2 process manager (`ecosystem.config.cjs`)

**CI Pipeline:**
- GitHub Actions workflows in `.github/workflows/`
- Release process: Merge `dev` → `main` triggers:
  - Version bump via `npm version` (manual in commit message)
  - Changelog substitution (v0.10.x → actual version)
  - GitHub release creation
  - Archive changelog with version number

**Process Management:**
- PM2 orchestrates 6 processes:
  - `portos-server` (5554) - Express API
  - `portos-cos` (5558) - Chief of Staff agent runner
  - `portos-ui` (5555) - Vite dev server
  - `portos-autofixer` (5559) - Error recovery
  - `portos-autofixer-ui` (5560) - Autofixer UI
  - `portos-browser` (5556/5557) - Chrome CDP

## AI Provider Integration

**Framework:**
- portos-ai-toolkit (separate npm module `^0.5.0`)
- Imported: `import { createAIToolkit } from 'portos-ai-toolkit/server'`

**Provider Management:**
- Route: `server/routes/providers.js` - Lists/tests/creates providers
- Service: `server/services/providers.js` - Toolkit wrapper
- Config: `data/providers.json` - Provider definitions
  - Fields: id, name, type, baseUrl, apiKey, model, tier, fallbackProvider, lightModel, etc.
  - Managed by toolkit's `createProvider()` and `updateProvider()`

**Run Execution:**
- Route: `server/routes/runs.js` - Run history and execution
- Service: `server/services/runner.js` - Toolkit wrapper with CLI execution fix
  - Fixed DEP0190 security warning by removing `shell: true`
- Data: `data/runs/` - Run results and metadata
- Lifecycle hooks:
  - `onRunCreated` - Records session usage
  - `onRunCompleted` - Tracks token usage
  - `onRunFailed` - Emits error event with context

**Prompt Templates:**
- Route: `server/routes/prompts.js` - Prompt management
- Service: `server/services/promptService.js` - Toolkit wrapper
- Data: `data/prompts/` - Saved templates
- Features: Template versioning, variable substitution

**Provider Status Monitoring:**
- Service: `server/services/providerStatus.js`
- Health checks for configured providers
- Emits status events via `providerStatusEvents`

## Browser & Automation

**Chrome DevTools Protocol (CDP):**
- Service: `server/services/browserService.js`
- Process: `browser/server.js` (separate PM2 process)
- Config: `data/browser-config.json`
- Settings:
  - CDP Port: 5556 (default)
  - CDP Host: 127.0.0.1 (localhost only, security)
  - Health Port: 5557
  - Headless: true (default)
  - User Data: `data/browser-profile/` (persistent cookies/sessions)
- HTTP health check: GET `/json/version` on health port
- Feature: Persistent Chrome profile for session maintenance

**Terminal Emulation:**
- node-pty for shell/terminal integration
- Routes: `server/routes/history.js` - Command history
- Real-time terminal via Socket.IO

## Webhooks & Callbacks

**Incoming:**
- Socket.IO subscriptions (client subscribes to server events)
- Webhook channels: detect, logs, errors, notifications, agents, cosmos, instances, brain

**Outgoing:**
- Socket.IO emissions to subscribed clients
- No webhook API for external services detected
- Browser events emitted locally: `browserEvents.emit()`

## Automation & Scheduling

**Automation Scheduler:**
- Service: `server/services/automationScheduler.js`
- Route: `server/routes/automationSchedules.js`
- Triggers: Time-based schedules for agent actions
- Agent Action Execution: `server/services/agentActionExecutor.js`

**Brain Scheduler:**
- Service: `server/services/brainScheduler.js`
- Features: Daily digests, weekly reviews
- Started via `startBrainScheduler()`

**Task Learning:**
- Service: `server/services/taskLearning.js`
- Tracks agent task completions for learning

## Environment Configuration

**Required Environment Variables:**
- `NODE_ENV`: development/production
- `PORT`: 5554 (API server), configurable
- `HOST`: 0.0.0.0 (default) or specific IP
- `TZ`: UTC (forced in ecosystem.config.cjs)
- `CDP_PORT`, `CDP_HOST`: Browser CDP settings
- `VITE_API_HOST`: Client Vite config for API proxy (localhost default)

**Secrets Location:**
- AI Provider API keys: `data/providers.json` (managed by toolkit)
- JIRA PATs: `data/jira.json`
- Moltbook/Moltworld API keys: Per-platform-account config
- Browser config: `data/browser-config.json`
- No `.env` files used; all config via JSON files in `data/`

**Note on Security Model:**
- PortOS is intentionally designed for single-user, internal use on private network
- No authentication, CORS restrictions, rate limiting, or HTTPS
- Deployment context: Behind Tailscale VPN, not internet-exposed
- Security handled at network level, not application level

---

*Integration audit: 2026-02-26*
