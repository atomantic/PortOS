# Port OS - Implementation Plan

## Quick Reference

### Tech Stack
- Frontend: React + Tailwind CSS + Vite (port 5555)
- Backend: Express.js (port 5554)
- Process Manager: PM2
- Data Storage: JSON files in `./data/`

### Commands
```bash
# Install all dependencies
npm run install:all

# Start development (both client and server)
npm run dev

# Start with PM2
pm2 start ecosystem.config.cjs

# View PM2 logs
pm2 logs
```

---

## Milestones

### Completed

- [x] **M0-M3**: Bootstrap, app registry, PM2 integration, log viewer - Core infrastructure
- [x] **M4**: App Wizard - Register existing apps or create from templates. See [App Wizard](./docs/features/app-wizard.md)
- [x] **M5**: AI Providers - Multi-provider AI execution with headless Claude CLI
- [x] **M6**: Dev Tools - Command runner with history and execution tracking
- [x] **M8**: Prompt Manager - Customizable AI prompts with variables and stages. See [Prompt Manager](./docs/features/prompt-manager.md)
- [x] **M9**: Streaming Import - Real-time websocket updates during app detection
- [x] **M10**: Enhanced DevTools - Provider/model selection, screenshots, git status, usage metrics
- [x] **M11**: AI Agents Page - Process detection and management with colorful UI
- [x] **M12**: History Improvements - Expandable entries with runtime/output capture
- [x] **M13**: Autofixer - Autonomous crash detection and repair. See [Autofixer](./docs/features/autofixer.md)
- [x] **M14**: Chief of Staff - Autonomous agent manager with task orchestration. See [Chief of Staff](./docs/features/chief-of-staff.md)
- [x] **M15**: Error Handling - Graceful error handling with auto-fix. See [Error Handling](./docs/features/error-handling.md)
- [x] **M16**: Memory System - Semantic memory with LLM classification. See [Memory System](./docs/features/memory-system.md)
- [x] **M17**: PM2 Config Enhancement - Per-process port detection and CDP_PORT support
- [x] **M18**: PM2 Standardization - LLM-powered config refactoring
- [x] **M19**: CoS Agent Runner - Isolated PM2 process for agent spawning. See [CoS Agent Runner](./docs/features/cos-agent-runner.md)
- [x] **M20**: AI Error Handling - Enhanced error extraction and CoS integration
- [x] **M21**: Usage Metrics - Comprehensive AI usage tracking and mobile UI
- [x] **M22**: Orphan Auto-Retry - Automatic retry for orphaned agents
- [x] **M23**: Self-Improvement - Automated UI/security/code analysis with Playwright
- [x] **M24**: Goal-Driven Mode - COS-GOALS.md mission file and always-working behavior
- [x] **M25**: Task Learning - Completion tracking and success rate analysis
- [x] **M26**: Scheduled Scripts - Cron-based automation with agent triggering
- [x] **M27**: CoS Capability Enhancements - Dependency updates, performance tracking, learning insights
- [x] **M28**: Weekly Digest UI - Visual digest with insights and comparisons
- [x] **M29**: App Improvement - Comprehensive analysis extended to managed apps
- [x] **M30**: Configurable Intervals - Per-task-type scheduling (daily, weekly, once, on-demand)
- [x] **M31**: LLM Memory Classification - Intelligent memory extraction with quality filtering
- [x] **M32**: Brain System - Second-brain capture and classification. See [Brain System](./docs/features/brain-system.md)
- [x] **M33**: Soul System - Digital twin identity scaffold management. See [Soul System](./docs/features/soul-system.md)
- [x] **M34 P1-P2,P4**: Digital Twin - Quantitative personality modeling and confidence scoring. See [Digital Twin](./docs/features/digital-twin.md)
- [x] **M35**: Chief of Staff Enhancement - Proactive autonomous agent with hybrid memory, missions, LM Studio, thinking levels. See [CoS Enhancement](./docs/features/cos-enhancement.md)
- [x] **M35.1**: CoS UI - Added Arcane Sigil (3D) avatar style option alongside Cyberpunk 3D
- [x] **M36**: Browser Management - CDP/Playwright browser page with status, controls, config, and logs
- [x] **M37**: Autonomous Jobs - Recurring scheduled jobs that the CoS executes proactively using digital twin identity
- [x] **M38**: Agent Tools - AI content generation, feed browsing, and autonomous engagement for Moltbook agents
- [x] **M39**: Agent-Centric Drill-Down - Redesigned Agents section with agent-first hierarchy, deep-linkable URLs, and scoped sub-tabs

### Planned

- [ ] **M7**: App Templates - Template management and app scaffolding from templates
- [ ] **M34 P3,P5-P7**: Digital Twin - Behavioral feedback loop, multi-modal capture, advanced testing, personas
- [ ] **M40**: Agent Skill System - Task-type-specific prompt templates with routing logic, negative examples, and embedded workflows for improved agent accuracy and reliability

---

## Documentation

### Architecture & Guides
- [Architecture Overview](./docs/ARCHITECTURE.md) - System design, data flow
- [API Reference](./docs/API.md) - REST endpoints, WebSocket events
- [Contributing Guide](./docs/CONTRIBUTING.md) - Code guidelines, git workflow
- [PM2 Configuration](./docs/PM2.md) - PM2 patterns and best practices
- [Port Allocation](./docs/PORTS.md) - Port conventions and allocation
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process
- [GitHub Actions](./docs/GITHUB_ACTIONS.md) - CI/CD workflow patterns
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Common issues and solutions

### Feature Documentation
- [App Wizard](./docs/features/app-wizard.md) - Register apps and create from templates
- [Autofixer](./docs/features/autofixer.md) - Autonomous crash detection and repair
- [Brain System](./docs/features/brain-system.md) - Second-brain capture and classification
- [Chief of Staff](./docs/features/chief-of-staff.md) - Autonomous agent orchestration
- [CoS Agent Runner](./docs/features/cos-agent-runner.md) - Isolated agent process management
- [CoS Enhancement](./docs/features/cos-enhancement.md) - M35 hybrid memory, missions, thinking levels
- [Digital Twin](./docs/features/digital-twin.md) - Quantitative personality modeling
- [Error Handling](./docs/features/error-handling.md) - Graceful error handling with auto-fix
- [Memory System](./docs/features/memory-system.md) - Semantic memory with LLM classification
- [Prompt Manager](./docs/features/prompt-manager.md) - Customizable AI prompts
- [Soul System](./docs/features/soul-system.md) - Digital twin identity scaffold
- [Browser Management](./docs/features/browser.md) - CDP/Playwright browser management

---

## Next Actions

Based on recent work and incomplete milestones:

1. **Complete M7: App Templates** - Implement template management UI and app scaffolding from templates
2. **Digital Twin P3: Behavioral Feedback Loop** - Add "sounds like me" response validation and adaptive weighting
3. **Vision API Polish** - Continue refining LM Studio vision integration based on test results
4. **Memory Consolidation** - Implement automatic memory consolidation for similar memories
5. **M40: Agent Skill System** - See details below

---

## M40: Agent Skill System

Inspired by [OpenAI Skills & Shell Tips](https://developers.openai.com/blog/skills-shell-tips), this milestone improves CoS agent accuracy and reliability through better task routing, prompt specificity, and context management.

### P1: Task-Type-Specific Agent Prompts (Skill Templates)
Currently all agents use the same generic `cos-agent-briefing.md` prompt template regardless of task type. Create specialized prompt templates per task category that include:
- **Routing descriptions**: "Use when..." / "Don't use when..." sections that help the system match tasks to the right skill template
- **Embedded examples**: Worked examples of successful completions for that task type (bug fix, feature, security audit, etc.)
- **Task-specific guidelines**: E.g., security audit skills include OWASP checklist; feature skills include test requirements; refactor skills include before/after patterns

**Implementation**:
- Add a `data/prompts/skills/` directory with task-type templates (e.g., `bug-fix.md`, `feature.md`, `security-audit.md`, `refactor.md`, `documentation.md`, `mobile-responsive.md`)
- Update `buildAgentPrompt()` in `subAgentSpawner.js` to select the appropriate skill template based on task type/description keywords
- Each template loaded only when matched (avoids token inflation for unrelated tasks)

### P2: Agent Context Compaction
Long-running agents can hit context limits causing failures. Add proactive context management:
- Pass `--max-turns` or equivalent context budget hints when spawning agents
- Track agent output length and detect when agents are approaching context limits
- Add compaction metadata to agent error analysis so retries can include "compact context" instructions
- Update the agent briefing to include explicit output format constraints for verbose task types

### P3: Negative Example Coverage for Task Routing
Improve task-to-model routing accuracy by adding negative examples to the model selection logic:
- Document which task types should NOT use light models (already partially done, but formalize it)
- Add "anti-patterns" to task learning: when a task type fails with a specific model, record the negative signal
- Surface routing accuracy metrics in the Learning tab so the user can see misroutes

### P4: Deterministic Workflow Skills
For recurring autonomous jobs (daily briefing, git maintenance, security audit, app improvement), encode the full workflow as a deterministic skill:
- Each skill defines exact steps, expected outputs, and success criteria
- Prevents prompt drift across runs (currently the same autonomous job prompt can produce different quality results)
- Skills are versioned and editable via the Prompt Manager UI

---

## Error Handling Summary

The server implements comprehensive error handling:
- **asyncHandler**: All routes wrapped with error handler that catches uncaught errors
- **ServerError**: Custom error class with status, code, severity, and context
- **Socket.IO Events**: Errors broadcast to UI via `error:occurred` event
- **Process Handlers**: Unhandled rejections and uncaught exceptions emit socket events
- **Logging**: Errors logged with emoji prefixes, no server crashes
- See [Error Handling](./docs/features/error-handling.md) for details

---

## Security Audit (2026-01-08)

Comprehensive security audit performed by CoS Self-Improvement agent.

### Vulnerabilities Found and Fixed

1. **Command Injection in Git Service** (CRITICAL - FIXED)
   - File: `server/services/git.js`
   - Fix: Replaced `exec()` with `spawn()` and `shell: false`, added path validation

2. **Path Traversal in Screenshots Route** (HIGH - FIXED)
   - File: `server/routes/screenshots.js`
   - Fix: Added `sanitizeFilename()` and path validation

### Secure Patterns (No Issues Found)
- Command execution uses allowlist
- PM2 operations use spawn with shell: false
- Input validation with Zod schemas
- No dangerouslySetInnerHTML in React
- API keys stored server-side only
- JSON content type required for mutations

---

## Planned Feature Details

### M7: App Templates

Templates allow creating new apps from pre-configured project structures.

**Built-in Template: PortOS Stack**
- Express.js API server
- React + Vite frontend
- Tailwind CSS styling
- PM2 ecosystem configuration
- GitHub Actions CI/CD workflows
- Auto-versioning system

**Features**
1. Template Selection - Browse available templates with feature descriptions
2. App Creation - Scaffold new project with chosen name and target directory
3. Custom Templates - Register additional templates from local paths
4. Template Management - View, edit, delete custom templates

**Pages**
- `/templates` - Template browser and app creation
- `/templates/new` - Register custom template

**API Endpoints**
| Route | Description |
|-------|-------------|
| GET /api/templates | List all templates |
| POST /api/templates | Add custom template |
| POST /api/templates/create | Create app from template |
| DELETE /api/templates/:id | Remove custom template |
