# OpenClaw Operator Chat — Extension Point Audit

This audit maps the real PortOS insertion points for a generic OpenClaw/operator chat feature.

It is a companion to:
- `docs/features/openclaw-operator-chat.md`

## Summary

PortOS already has the major primitives needed for a first-party OpenClaw/operator chat surface:

- top-level routed pages
- server-side API proxy patterns
- Socket.IO real-time plumbing
- CoS/agent UI patterns for operational state
- Messages UI patterns for threaded communication
- Tailscale/private-network assumptions

That means the MVP does **not** require a new architectural subsystem. It can be added as a conventional PortOS page + server route pair.

## Best fit in current architecture

### Recommended route/page
Add a new top-level page:

- `/openclaw`

Why top-level instead of nesting under CoS:
- CoS is an autonomous system manager
- OpenClaw/operator chat is a direct operator conversation surface
- keeping them separate preserves product clarity
- it avoids forcing OpenClaw into a Chief-of-Staff mental model

### Recommended server route
Add a new API route group:

- `/api/openclaw`

Why:
- matches existing route conventions in `server/index.js`
- keeps browser-side config simple
- lets PortOS proxy requests to OpenClaw without exposing runtime topology/auth in the frontend

## Concrete insertion points

## 1. Frontend routing

### Existing file
- `client/src/App.jsx`

### Recommended change
Add:
- lazy-loaded page import or static import for `./pages/OpenClaw`
- route:
  - `<Route path="openclaw" element={<OpenClawPage />} />`

### Why this is the right place
`App.jsx` is already the top-level router for:
- `messages`
- `cos`
- `brain`
- `shell`
- `instances`
- etc.

OpenClaw belongs at the same tier.

## 2. Frontend page

### Recommended new file
- `client/src/pages/OpenClaw.jsx`

### MVP responsibilities
- load runtime status
- load available sessions
- select a session
- load recent messages
- send a message
- show assistant replies
- show connection errors cleanly

### Best UI references in current codebase
Use these as patterns rather than duplicating their semantics:

#### Operational shell patterns
- `client/src/pages/ChiefOfStaff.jsx`
- `client/src/components/cos/*`

Useful patterns there:
- status banners
- event logs
- live operational feedback
- left/right panel layout ideas
- tabbed operational workflows

#### Communication UI patterns
- `client/src/pages/Messages.jsx`
- `client/src/components/messages/*`

Useful patterns there:
- threaded/timeline communication views
- account/session selection concepts
- message detail handling
- draft/send interaction patterns

### Recommendation
For MVP, bias more toward:
- **CoS operational shell feel**
than toward:
- email/inbox complexity

This should feel like an operator console, not a normal messaging product.

## 3. Frontend API wrapper

### Existing file
- `client/src/services/api.js`

### Recommended additions
Add a small OpenClaw section with helpers like:

- `getOpenClawStatus()`
- `getOpenClawSessions()`
- `getOpenClawMessages(sessionId, options)`
- `sendOpenClawMessage(sessionId, message, context)`
- optional later:
  - `getOpenClawJobs()`
  - `getOpenClawSubagents()`
  - `createOpenClawSession(payload)`

### Why here
This file is the existing client-side API facade for nearly all PortOS features.
Adding OpenClaw here follows the same convention and avoids one-off fetch logic scattered through the page.

## 4. Server route mounting

### Existing file
- `server/index.js`

### Recommended change
Add:
- `import openclawRoutes from './routes/openclaw.js';`
- `app.use('/api/openclaw', openclawRoutes);`

### Why here
This is the normal route registration point for all PortOS API features.

## 5. Server route module

### Recommended new file
- `server/routes/openclaw.js`

### MVP responsibilities
- status endpoint
- list sessions endpoint
- get session history/messages endpoint
- send message endpoint

### Thin-adapter rule
This route should be a **thin integration adapter**, not a new assistant runtime.
Its job is to:
- validate PortOS-side requests
- consult local config
- proxy to OpenClaw runtime
- normalize responses for PortOS UI

## 6. Server integration layer

### Recommended new directory/files
- `server/integrations/openclaw/api.js`
- optional later:
  - `server/integrations/openclaw/config.js`
  - `server/integrations/openclaw/normalize.js`

### Why add this layer
Keeps route handlers clean and prevents OpenClaw-specific HTTP shapes from leaking all over PortOS.

### MVP responsibilities
- build runtime base URL from local config
- attach auth if configured
- perform fetches to OpenClaw
- normalize common failures:
  - unconfigured
  - unreachable
  - unauthorized
  - malformed response

## 7. Local/private configuration

This is the most important boundary.

### What should NOT go in public product defaults
- actual local/private OpenClaw endpoint
- machine-specific hostnames/IPs
- auth tokens
- assistant identity name/persona
- machine-role semantics tied to one user

### Best likely fit
Use existing local data/config conventions under PortOS data storage, not committed source defaults.

Relevant existing server-side patterns:
- `PATHS.data` in `server/lib/fileUtils.js`
- PortOS already uses local data directories for instance-specific state

### Recommended approach
Keep a git-ignored config file under local data, something conceptually like:

- `data/openclaw/config.json`

Example shape:

```json
{
  "enabled": true,
  "baseUrl": "http://private-runtime",
  "authToken": "...",
  "defaultSession": "main",
  "label": "Local Operator Runtime"
}
```

If a sample/public config exists, it should contain only generic placeholders and no private topology.

## 8. Real-time events / streaming

### Existing infrastructure
- `client/src/services/socket.js`
- `server/services/socket.js`
- `server/index.js` Socket.IO initialization

### Recommendation for MVP
Do **not** start with full token streaming if it complicates delivery.

MVP can work with:
- request/response message send
- subsequent message refresh/history fetch

### Later phase
If OpenClaw supports streaming or event subscription cleanly, PortOS can add:
- live reply streaming
- tool activity summaries
- session state updates

This should reuse existing Socket.IO patterns rather than invent a parallel browser transport.

## 9. Navigation / discoverability

### Existing likely insertion point
- `client/src/components/Layout.jsx`

### Recommended change
Add a nav item for:
- OpenClaw
- or Operator Chat

Use a generic icon/label.
Do not use private assistant identity in shared UI.

## 10. Security posture

### Existing assumptions
PortOS already assumes:
- self-hosted
- private-network/Tailscale usage
- server-side route mediation

### Recommended posture for this feature
- browser talks only to PortOS `/api/openclaw`
- PortOS server talks to OpenClaw runtime
- runtime details stay server-side
- local config stays git-ignored
- page should degrade cleanly if runtime is absent

### Why this is better than direct browser-to-OpenClaw
- no leaking runtime endpoint/auth to client bundle
- simpler multi-instance behavior
- consistent error handling
- better future room for policy/context filtering

## 11. Existing feature boundaries to preserve

### Keep separate from Messages
Why:
- `Messages` is about external communication accounts and inboxes
- OpenClaw operator chat is internal/local runtime communication

Do not merge these domains in MVP.

### Keep separate from CoS
Why:
- CoS is autonomous system orchestration
- OpenClaw chat is direct operator conversation

They can link to each other, but should not be the same page.

## 12. MVP file plan

### Frontend
New:
- `client/src/pages/OpenClaw.jsx`

Modify:
- `client/src/App.jsx`
- `client/src/services/api.js`
- likely `client/src/components/Layout.jsx`

Optional new components if needed:
- `client/src/components/openclaw/SessionList.jsx`
- `client/src/components/openclaw/ChatTimeline.jsx`
- `client/src/components/openclaw/Composer.jsx`
- `client/src/components/openclaw/RuntimeStatusCard.jsx`

### Backend
New:
- `server/routes/openclaw.js`
- `server/integrations/openclaw/api.js`

Modify:
- `server/index.js`

Optional later:
- `server/integrations/openclaw/config.js`
- `server/integrations/openclaw/errors.js`

### Data/config
Local/private only:
- `data/openclaw/config.json` (git-ignored or machine-local)

Optional public-safe sample:
- `data.sample/openclaw/config.json` with placeholders only

## 13. MVP endpoint sketch

Inside PortOS:

- `GET /api/openclaw/status`
  - configured?
  - reachable?
  - default session?
  - label?

- `GET /api/openclaw/sessions`
  - list sessions available to PortOS

- `GET /api/openclaw/sessions/:id/messages?limit=...`
  - get recent session history

- `POST /api/openclaw/sessions/:id/messages`
  - send a message
  - optional context attachments payload

Optional:
- `POST /api/openclaw/sessions`
  - create/bind a session

## 14. Suggested MVP UI shape

### Header
- runtime label
- connection state
- session selector

### Main body
- message list
- composer

### Side panel (optional but useful)
- current page context toggle
- session metadata
- quick links to relevant PortOS surfaces

## 15. Risks and watchouts

### 1. Identity leakage into product code
Avoid:
- hardcoded private assistant names
- private relationship language in public UI

### 2. Feature becoming too CoS-specific
Avoid:
- assuming all assistant interaction is through the Chief of Staff model

### 3. Context oversharing
Avoid:
- silently attaching full page/system state without explicit user action

### 4. Tight runtime coupling
Avoid:
- making PortOS unusable when OpenClaw is missing

### 5. Premature streaming complexity
Avoid:
- shipping a fragile streaming layer before simple request/response works

## 16. Recommended implementation order

### Phase A — thin vertical slice
1. local config loader
2. server integration adapter
3. `/api/openclaw/status`
4. `/api/openclaw/sessions`
5. `/api/openclaw/sessions/:id/messages`
6. `/api/openclaw/sessions/:id/messages` POST
7. basic `/openclaw` page
8. nav link

### Phase B — usability
9. session persistence in UI
10. better error states
11. optional context attachment controls
12. runtime metadata/status card

### Phase C — deeper operator integration
13. socket-driven live updates
14. subagent/job visibility
15. links to Review / Apps / CoS / DevTools

## Recommendation
The MVP should be:
- a new top-level `/openclaw` page
- backed by `/api/openclaw` routes
- implemented through a thin server-side integration adapter
- configured through local/private instance config
- visually aligned with CoS operational patterns, not Messages inbox complexity

That is the cleanest way to add first-party assistant chat to PortOS without contaminating the public project with private identity or machine-specific assumptions.
