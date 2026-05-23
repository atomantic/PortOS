# Feature Implementation Skill Template

## Routing
**Use when**: Task description contains keywords like "add", "create", "implement", "build", "new", "feature", "support", "enable", "integrate", "endpoint", "page", "component"
**Don't use when**: Task is fixing a bug, refactoring existing code, or writing documentation for existing features

## Task-Specific Guidelines

You are implementing a new feature. Follow this structured approach:

### 1. Understand the Requirements
- Parse the task description for explicit and implicit requirements
- Identify the scope boundary — what's included and what's NOT
- Check for existing patterns in the codebase that your feature should follow

### 2. Plan Before Coding
- Identify all files that need to be created or modified
- Follow existing architectural patterns (routes → services → data layer)
- Check if similar features exist and mirror their structure
- Plan the API contract (if adding endpoints) before writing implementation

### 3. Implementation Order
- Start with data layer / backend logic
- Add route/API handlers with Zod validation
- Add client-side service calls
- Add UI components last
- Follow existing code conventions exactly — match spacing, naming, patterns

### 4. Quality Checklist
- All new routes must have Zod validation
- No hardcoded localhost — use `window.location.hostname`
- Full URL route paths for any new UI views (no modals without deep links)
- No try/catch — let errors bubble to centralized middleware
- Single-line emoji-prefixed logging for server code

### 5. Commit Message Format
Use prefix: `feat(scope): description`

## Example: Successful Feature Implementation

**Task**: "Add a health check endpoint that returns system uptime and version"

**What the agent did**:
1. Read existing routes to understand patterns (`server/routes/system.js`)
2. Added `GET /api/health` route with Zod response schema
3. Created service function `getHealthStatus()` returning `{ uptime, version, timestamp }`
4. Added `console.log('🏥 Health check requested')` logging
5. Ran `npm test` — all passing
6. Committed: `feat(system): add health check endpoint with uptime and version`

**Why it succeeded**: Followed existing patterns, proper validation, no over-engineering, clean logging.
