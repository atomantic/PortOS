# OpenClaw Operator Chat

A generic, first-party operator chat surface inside PortOS that allows a user to communicate with a local or privately reachable OpenClaw runtime without relying on third-party messaging providers like Telegram.

## Why this exists

PortOS is already reachable over Tailscale and is intended to be a secure, self-hosted operating surface. For sensitive operator work, routing chat through Telegram or another third-party messaging network adds avoidable privacy and security exposure.

This feature adds a **generic** assistant/operator chat module to PortOS so users can:

- chat with their assistant directly inside PortOS
- inspect session state without leaving the app
- keep sensitive machine/admin context off third-party transports
- use PortOS as a first-party local operator console

## Critical product constraint

PortOS is a public open-source project used by many people.

Therefore:

- **do not bake any private assistant identity into product features**
- **do not assume one specific assistant persona or relationship model**
- **do not assume one specific machine/network topology**
- **do not assume OpenClaw is always present**

This feature must remain:

- generic
- optional
- instance-configurable
- safe for users running their own OpenClaw or no assistant at all

Identity, assistant naming, local network details, and machine-specific behavior must live in local/private configuration or git-ignored instance data.

## Product framing

This should be presented as something like:

- **Operator Chat**
- **Assistant Console**
- **OpenClaw**
- **Runtime Chat**

Not:

- a hardcoded persona name
- a product-level "Rowan" feature
- a fixed Chief-of-Staff replacement

## Goals

1. Provide a first-party chat UI inside PortOS for talking to an assistant/runtime.
2. Reduce reliance on Telegram for operator/admin conversations.
3. Keep the feature generic enough for any PortOS instance to connect to its own OpenClaw deployment.
4. Preserve clean boundaries between:
   - PortOS UI
   - assistant runtime
   - private instance config
5. Make chat adjacent to PortOS state, apps, repos, tasks, and services.

## Non-goals

- replacing all external messaging integrations
- embedding assistant identity into PortOS core
- making PortOS depend on OpenClaw to function
- exposing private machine details through public/open-source defaults
- coupling this feature tightly to one user's workflow

## Existing PortOS extension points that make this feasible

PortOS already has several relevant building blocks:

### UI patterns
- `client/src/pages/ChiefOfStaff.jsx`
- `client/src/components/cos/*`
- existing tabbed operational UI patterns
- event logs, terminal-style panels, status indicators

### Networking and real-time
- `client/src/services/socket.js` uses relative paths and is already Tailscale-friendly
- `server/index.js` already mounts Socket.IO and API routes for local/private access

### Agent/runtime patterns
- CoS page and agent runner already model:
  - status
  - running jobs
  - event streams
  - agent outputs
- `server/cos-runner/` already provides a process/runtime management pattern

### Messaging patterns
- `client/src/pages/Messages.jsx`
- `server/routes/messages.js`
- existing draft/message/thread models can inform UX, even if operator chat is a separate domain

### Security assumptions
- PortOS already assumes trusted-network/private access via Tailscale
- this is compatible with a local-first assistant console

## High-level architecture

### Separation of concerns

#### PortOS is responsible for:
- operator UI
- session list UI
- message history UI
- context attachment UX
- runtime connection status
- local authentication to PortOS itself
- optional linking between chat and PortOS pages/apps/tasks

#### OpenClaw is responsible for:
- session runtime
- message handling
- tool execution
- subagent/session orchestration
- response generation
- runtime-side security/policy enforcement

### Integration model

PortOS should talk to OpenClaw through a small adapter/integration layer, not by reimplementing assistant logic.

Suggested shape:

- **server integration module**
  - `server/integrations/openclaw/*`
- **PortOS API routes**
  - `server/routes/openclaw.js`
- **client service wrapper**
  - `client/src/services/openclaw.js`
- **UI page**
  - `client/src/pages/OpenClaw.jsx` or `client/src/pages/OperatorChat.jsx`

## Proposed capabilities

### Phase 1 — MVP: first-party assistant chat

A page inside PortOS where the user can:

- see whether an OpenClaw runtime is configured/reachable
- view available sessions or a default session
- load recent message history
- send a message
- receive assistant replies
- see timestamps and basic status

Suggested features:

- session selector
- message timeline
- input composer
- connection status badge
- send/receive loading states
- optional "reply in current session" mode

### Phase 2 — operator-aware context

Allow the user to send a message with attached PortOS context such as:

- current page/app
- selected repo/app
- active task
- system status summary
- current machine/app metadata

Examples:

- "look at this app"
- "review the current queue"
- "inspect the service behind this page"
- "summarize what changed here"

This context should be explicit and user-controlled, not silently leaked.

### Phase 3 — runtime visibility and controls

Expose runtime information such as:

- connected runtime endpoint
- active sessions
- spawned subagents/jobs
- recent tool actions
- execution status
- reminders/cron job visibility if supported

This should feel like an operator console, not just a basic chat box.

### Phase 4 — structured PortOS actions

Optional future capabilities:

- ask assistant to inspect a repo and open linked results
- pass page context to assistant with one click
- show inline approvals/review items
- link assistant output to Review / Goals / Apps / Brain surfaces

## Privacy and security model

### Public/open-source code may contain
- generic OpenClaw connector support
- generic UI for assistant/runtime chat
- generic settings for endpoint/auth/session behavior
- generic local data storage hooks

### Private instance-local data must contain
- assistant identity/persona
- local machine topology
- hostnames, ports, URLs, tokens
- role preferences
- private operator notes
- machine-specific context mapping

### Rules
- no private assistant identity in product defaults
- no machine-specific hostnames or ports in committed code/docs beyond generic examples
- no assumptions about Telegram or other third-party transports
- no assumptions that all users want autonomous operator chat
- fail gracefully when OpenClaw is unconfigured or unreachable

## Configuration model

### Public-safe config surface
PortOS can expose generic settings like:

```json
{
  "enabled": true,
  "provider": "openclaw",
  "transport": "http",
  "sessionMode": "default",
  "allowContextAttachments": true,
  "showRuntimeStatus": true
}
```

### Private instance-local config
Actual endpoint/auth/session defaults should live in local, git-ignored config, for example:

```json
{
  "openclaw": {
    "baseUrl": "http://100.x.x.x:PORT",
    "authToken": "...",
    "defaultSession": "main",
    "label": "Local Operator Runtime"
  }
}
```

The exact file/location should align with PortOS local config conventions, but must remain out of public repo defaults if it contains private topology or credentials.

## Suggested API surface inside PortOS

These would be PortOS routes that proxy or adapt to an OpenClaw runtime.

### Status
- `GET /api/openclaw/status`
  - runtime reachable?
  - configured?
  - default session?

### Sessions
- `GET /api/openclaw/sessions`
- `GET /api/openclaw/sessions/:id/messages`
- `POST /api/openclaw/sessions/:id/messages`
- `POST /api/openclaw/sessions`
  - create or bind a new operator session if needed

### Optional runtime actions
- `GET /api/openclaw/jobs`
- `GET /api/openclaw/subagents`
- `POST /api/openclaw/context/compose`
  - build a safe context bundle from current PortOS state

These should remain thin adapters where possible.

## UI proposal

### New page
A new page such as:

- `/openclaw`
- `/operator-chat`
- `/assistant`

I recommend **`/openclaw`** or **`/operator-chat`**.

### Page layout

#### Left rail
- runtime status
- session list
- quick actions
- optional recent tasks/subagents

#### Main panel
- message timeline
- streamed assistant replies
- tool activity summaries (optional)
- context chips

#### Right rail (future)
- current page/app context
- recent system events
- inspectable attachments

### UX principles
- chat should feel calm and operational, not social-media-like
- context attachments should be explicit
- runtime status should be visible
- errors should be actionable
- chat must not block normal PortOS use

## Integration with existing PortOS surfaces

### Chief of Staff
Relationship:
- CoS remains an autonomous/managed system surface
- OpenClaw chat is a direct operator conversation surface

Possible links:
- "Ask about this CoS task"
- "Open in Operator Chat"
- "Send BTW / additional context"

### Messages
Relationship:
- Messages page manages external communications/accounts
- OpenClaw Operator Chat is an internal/local console

This distinction should stay clear in the UI.

### Review
Assistant outputs that need human attention could eventually create Review items.

### Apps / Instances / DevTools / Shell
These are strong context sources for chat attachments and operator actions.

## Failure modes to design for

- OpenClaw unreachable
- OpenClaw configured incorrectly
- runtime session missing/expired
- streaming disconnects
- PortOS page context too large/noisy
- user accidentally sharing more context than intended
- partial feature deployment on instances without OpenClaw

## Graceful degradation

If OpenClaw is not configured:
- hide the page by default or show a setup screen
- do not break PortOS navigation
- do not throw noisy errors in unrelated pages

If runtime is unavailable:
- show disconnected status
- preserve local UI state where possible
- allow retry/reconnect

## Suggested implementation order

### Step 1 — Spec and extension-point audit
- confirm PortOS route/page placement
- confirm local config pattern
- confirm whether proxying through PortOS server is preferable to direct browser calls

### Step 2 — Thin server adapter
- add OpenClaw integration module
- add status/session/message proxy routes
- keep adapter minimal

### Step 3 — MVP UI page
- session list
- message timeline
- composer
- status badge

### Step 4 — context attachments
- current page/app/task context chips
- explicit attach/send flow

### Step 5 — runtime/operator extras
- subagents
- jobs
- session status
- linked review actions

## Recommended design decisions

1. **Keep the product generic**
   - no private assistant identity in public code

2. **Use local/private config for identity and topology**
   - assistant name, endpoint, role, machine map stay local

3. **Proxy through PortOS server first**
   - keeps auth/config simpler
   - avoids browser-side exposure of private runtime details
   - fits existing PortOS API patterns

4. **Do not merge this into Messages**
   - operator chat is a different domain than email/SMS/Telegram messaging

5. **Keep OpenClaw optional**
   - PortOS must still work cleanly without it

## Open questions

1. Should OpenClaw chat live as a top-level page or under Chief of Staff?
   - My recommendation: top-level page or top-level tool, not hidden under CoS

2. Should PortOS support multiple runtimes or one default runtime first?
   - My recommendation: one default runtime first, design for future plurality

3. Should chat sessions be created/managed by PortOS or discovered from OpenClaw?
   - My recommendation: discover existing sessions first, optionally allow PortOS to create a dedicated operator session

4. Should tool activity be shown in the timeline from the start?
   - My recommendation: basic status first, detailed tool activity later

## Initial deliverables

- this feature spec
- PortOS extension-point audit
- minimal server-side OpenClaw adapter
- minimal `/openclaw` page
- local private config example (git-ignored)

## Bottom line

PortOS should gain a **generic, optional, first-party OpenClaw operator chat surface** so users can communicate with their assistant/runtime directly over their private network instead of depending on Telegram.

That feature should be:
- generic in product code
- private in identity/config
- optional per instance
- aligned with existing PortOS CoS, socket, and Tailscale architecture
