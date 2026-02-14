# Documentation Skill Template

## Routing
**Use when**: Task description contains keywords like "document", "documentation", "docs", "readme", "jsdoc", "comment", "explain", "describe", "api docs", "guide", "tutorial", "changelog", "wiki"
**Don't use when**: Task is primarily about code changes with documentation as a side note, or task just needs inline code comments

## Task-Specific Guidelines

You are writing or updating documentation. Focus on clarity, accuracy, and usefulness.

### 1. Understand the Audience
- Developer documentation: assume familiarity with the tech stack
- User documentation: assume no codebase knowledge
- API documentation: include request/response examples
- Architecture docs: include the "why" behind decisions

### 2. Accuracy First
- Read the actual code before documenting it — never guess at behavior
- Test any commands or code snippets you include
- Verify file paths, function signatures, and configuration options exist
- If behavior is ambiguous, check the implementation rather than assuming

### 3. Documentation Style
- Use clear, direct language — avoid jargon when simpler words work
- Include practical examples for every concept
- Structure with headers for scanability
- Keep sections focused — one topic per section
- Use code blocks with language identifiers for syntax highlighting

### 4. What NOT to Do
- Don't document obvious code (e.g., `// increment counter` above `counter++`)
- Don't create documentation files unless explicitly requested
- Don't add JSDoc to functions you didn't write or modify
- Don't duplicate information that exists elsewhere — link to it instead

### 5. Commit Message Format
Use prefix: `docs(scope): description`

## Example: Successful Documentation Task

**Task**: "Document the WebSocket events used between client and server"

**What the agent did**:
1. Read `server/services/socket.js` and `client/src/services/socket.js` to catalog all events
2. Found 12 events: 6 server→client, 4 client→server, 2 bidirectional
3. Created a table with event name, direction, payload shape, and when it fires
4. Added code examples showing how to listen/emit each event
5. Committed: `docs(websocket): document all socket events with payload shapes`

**Why it succeeded**: Derived documentation from actual code, structured for quick reference, included practical examples.
