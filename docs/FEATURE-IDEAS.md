# PortOS Feature Ideas

> Brainstormed from GOALS.md gaps and current codebase analysis. Organized by goal area, prioritized by alignment with the current **identity integration phase** direction.

---

## Priority Tier 1: Identity Integration Phase (aligns with M42 direction)

### 1. Chronotype-Aware Task Scheduling
**Goal**: Autonomous AI Orchestration + Digital Identity Modeling
**Gap**: CoS schedules tasks by cron intervals, but ignores the user's natural energy patterns.

Derive peak-focus windows from genome sleep markers (already in `genome.json`) and chronotype data. CoS should schedule deep-work tasks (code reviews, feature implementations) during peak hours and routine tasks (digests, cleanup) during low-energy periods. Display an "energy curve" overlay on the Schedule tab showing when tasks are optimally placed.

**Touches**: `server/services/taskSchedule.js`, `server/services/genome.js`, CoS Schedule tab

---

### 2. Identity Context Injection for All AI Calls
**Goal**: Digital Identity Modeling + Self-Improving Intelligence
**Gap**: AI providers receive generic system prompts. The digital twin data (personality, taste, chronotype) isn't systematically injected.

Create an identity context builder that assembles a concise identity brief from `EXISTENTIAL.md`, taste profile, personality scores, and autobiography excerpts. Inject this as a system-level preamble for every AI call through the toolkit's provider layer. Include a toggle per-task-type (some tasks like code fixes don't need personality context).

**Touches**: `portos-ai-toolkit`, `server/services/runner.js`, CoS Config

---

### 3. Mortality-Aware Goal Dashboard Widget
**Goal**: Knowledge Legacy + Digital Identity Modeling
**Gap**: GOALS.md lists mortality-aware goal tracking as a secondary goal, and M42 P3 is planned but not started. No UI exists to visualize urgency.

Add a Dashboard widget that calculates a "life urgency score" per goal based on birth date + genome longevity markers. Display goals sorted by urgency with a visual timeline showing projected remaining years. This turns abstract long-term goals into concrete "you have X years to accomplish this" motivation.

**Touches**: `client/src/components/dashboard/`, `server/services/goalProgress.js`, `server/services/genome.js`

---

### 4. Behavioral Feedback Loop ("Sounds Like Me")
**Goal**: Digital Identity Modeling (Secondary Goal in GOALS.md)
**Gap**: M34 P3 is planned. Agent-generated content has no feedback mechanism to refine the twin.

When agents generate content (social posts, commit messages, responses), show a quick "Sounds like me / Doesn't sound like me" toggle. Track response patterns to build an adaptive style model. Over time, the twin learns which phrasings, tones, and structures feel authentic. Store feedback in `data/digital-twin/feedback.json` with weighted scoring.

**Touches**: Agent Tools UI, `server/services/agentContentGenerator.js`, Digital Twin service

---

## Priority Tier 2: Deeper Autonomy

### 5. Agent Confidence & Autonomy Levels
**Goal**: Full Digital Autonomy + Self-Improving Intelligence
**Gap**: All CoS tasks use the same approval flow. There's no graduated autonomy based on task risk or agent track record.

Introduce confidence tiers: tasks with high historical success rates and low blast radius execute without human review. Medium-confidence tasks show a summary for quick approval. Low-confidence or high-impact tasks require full review. The system earns more autonomy over time as success rates climb.

**Touches**: `server/services/cos.js`, `server/services/taskLearning.js`, CoS Tasks UI

---

### 6. Cross-Platform Content Calendar
**Goal**: Full Digital Autonomy + Autonomous AI Orchestration
**Gap**: Social agents can generate content, but there's no unified view of what's scheduled across platforms.

Build a calendar view showing planned content across all connected platforms (Moltworld, future social integrations). CoS can auto-schedule posts based on engagement pattern analysis. The calendar shows draft → review → published pipeline status for each piece of content.

**Touches**: New `client/src/pages/ContentCalendar.jsx`, `server/routes/contentCalendar.js`, agent scheduling integration

---

### 7. Proactive Insight Alerts
**Goal**: Self-Improving Intelligence + Personal Knowledge Management
**Gap**: Brain digests run on schedule. No real-time alerting when the system discovers something noteworthy.

Add a notification layer that triggers when: a brain capture connects to an old memory (serendipity detection), an agent's success rate drops below threshold, a goal hasn't had progress in X days, or usage costs spike. These appear as toast notifications and accumulate in the existing notification dropdown.

**Touches**: `server/services/notifications.js`, `server/services/brain.js`, `server/services/taskLearning.js`

---

### 8. Goal Decomposition Engine
**Goal**: Autonomous AI Orchestration + Self-Improving Intelligence
**Gap**: COS-GOALS.md is manually maintained. Goals don't automatically break down into executable tasks.

When a new goal is added, have the CoS analyze it against the codebase, existing milestones, and learned capabilities to automatically decompose it into a sequence of tasks with dependencies. Track goal → task → outcome lineage so the system can report "Goal X is 60% complete based on 12/20 tasks finishing successfully."

**Touches**: `server/services/cos.js`, `server/services/goalProgress.js`, `server/services/missions.js`

---

## Priority Tier 3: Knowledge & Legacy

### 9. Knowledge Graph Visualization
**Goal**: Personal Knowledge Management + Knowledge Legacy
**Gap**: Brain captures and memories are searchable but not visually connected. No way to see how ideas relate.

Build an interactive force-directed graph that maps connections between brain captures, memories, goals, and agent outputs. Nodes are color-coded by type (thought, memory, goal, decision). Edges form when the LLM classifier identifies semantic links. Click a node to expand its context. This makes the "second brain" browsable as a web of knowledge, not just a search index.

**Touches**: New visualization component (could use React Three Fiber already in deps), `server/services/brain.js`, `server/services/memory.js`

---

### 10. Time Capsule Snapshots
**Goal**: Knowledge Legacy
**Gap**: Identity data evolves but there's no way to compare your current self to past states.

Periodically snapshot the entire digital twin state (personality scores, taste profile, goals, autobiography progress, behavioral feedback) into versioned archives. Build a "Then vs. Now" comparison view showing how scores, preferences, and goals have shifted over months or years. This is the beginning of knowledge preservation — not just capturing who you are now, but tracking who you're becoming.

**Touches**: New `server/services/timeCapsule.js`, `data/digital-twin/snapshots/`, Digital Twin UI tab

---

### 11. Autobiography Prompt Chains
**Goal**: Knowledge Legacy + Digital Identity Modeling
**Gap**: M34 P5 launched autobiography prompts, but they're standalone. No guided narrative arc.

Create themed prompt chains that build on previous answers: "childhood → education → career → relationships → turning points → regrets → hopes." Each chain uses the LLM to generate follow-up questions based on prior responses, creating a conversational autobiography rather than isolated Q&A. Export the full narrative as a readable document.

**Touches**: `server/services/autobiography.js`, Digital Twin Autobiography tab, prompt service

---

### 12. Legacy Export Format
**Goal**: Knowledge Legacy
**Gap**: All data lives in JSON files. No portable, human-readable export of the full digital identity.

Build an export pipeline that compiles the autobiography, personality profile, genome summary, taste profile, key decisions, and brain highlights into a single formatted document (Markdown or PDF). This is the "if PortOS disappears tomorrow" safeguard — a complete human-readable snapshot of everything captured.

**Touches**: New export service, Digital Twin UI export button

---

## Priority Tier 4: Developer Experience

### 13. Unified Search
**Goal**: Developer Productivity Toolkit
**Gap**: Brain, Memory, History, Agents, and Tasks all have separate search. No way to search everything at once.

Add a global search bar (Cmd+K / Ctrl+K) that queries across brain captures, memories, action history, agent outputs, tasks, and app data simultaneously. Results grouped by source type with quick navigation to the relevant page. Uses the existing memory retriever's hybrid search (vector + BM25) extended to other data sources.

**Touches**: New `client/src/components/GlobalSearch.jsx`, Layout.jsx, new aggregation endpoint

---

### 14. Dashboard Customization
**Goal**: Developer Productivity Toolkit + Anywhere Access
**Gap**: Dashboard widgets are fixed. Different contexts (phone vs. desktop, morning vs. evening) benefit from different layouts.

Allow drag-and-drop widget reordering and show/hide toggles. Persist layout to `data/settings.json`. Optionally support named layouts ("morning briefing" shows goals + digest + schedule; "deep work" shows just tasks + shell access).

**Touches**: `client/src/pages/Dashboard.jsx`, `server/services/settings.js`, dnd-kit (already a dependency)

---

### 15. Workspace Contexts
**Goal**: Developer Productivity Toolkit
**Gap**: The shell, git tools, and browser all operate independently. No concept of "I'm working on project X right now."

Add workspace context that sets the active project across all tools. When you switch to "Project Foo", the shell opens in its directory, git shows its status, relevant tasks filter to that project, and the browser opens its dev URL. Context persists across page navigation.

**Touches**: New workspace state in settings, Layout context provider, Shell/Git/Browser integration

---

### 16. Inline Code Review Annotations
**Goal**: Developer Productivity Toolkit + Autonomous AI Orchestration
**Gap**: Self-improvement (M23) analyzes code but results are task outputs. No in-context code annotation.

When CoS runs code analysis on a managed app, surface findings as inline annotations in a code viewer — similar to GitHub PR reviews but within PortOS. Group by severity, allow one-click "fix this" to spawn a CoS task. This makes the self-improvement loop visual and actionable.

**Touches**: New code viewer component, `server/services/selfImprovement.js`, CoS integration

---

## Priority Tier 5: Multi-Modal & Future

### 17. Voice Capture for Brain
**Goal**: Personal Knowledge Management + Multi-Modal Identity Capture (Secondary Goal)
**Gap**: Brain capture is text-only. Voice is often the fastest way to capture fleeting thoughts.

Add a microphone button to the Brain capture UI. Use the browser's Web Speech API for transcription (runs locally, no external API needed). Transcribed text feeds into the normal brain classification pipeline. Store original audio as an attachment for fidelity.

**Touches**: Brain capture UI, `server/routes/attachments.js`, browser Web Speech API

---

### 18. RSS/Feed Ingestion Pipeline
**Goal**: Personal Knowledge Management + Full Digital Autonomy
**Gap**: Knowledge capture requires manual input or agent browsing. No passive ingestion from followed sources.

Add an RSS/Atom feed manager that periodically fetches subscribed feeds, classifies items through the brain pipeline, and surfaces relevant ones in the Brain inbox. The LLM classifier filters noise — only items matching the user's interests (derived from taste profile + brain history) appear. This turns the brain into a personalized news/research aggregator.

**Touches**: New `server/services/feedIngestion.js`, Brain inbox integration, settings for feed URLs

---

### 19. Ambient Dashboard Mode
**Goal**: Anywhere Access + Developer Productivity Toolkit
**Gap**: CyberCity is immersive but informational density is low. No "glance at the wall" ambient display.

Create a dedicated ambient mode that turns any screen into a live status board: current tasks, agent activity, system health, next scheduled events, and the energy curve — all updating in real-time via WebSocket. Designed for a wall-mounted tablet or secondary monitor. Minimal interaction, maximum information density.

**Touches**: New `client/src/pages/AmbientDashboard.jsx`, WebSocket subscriptions, responsive layout

---

### 20. Agent Skill Marketplace (Local)
**Goal**: Self-Improving Intelligence + Autonomous AI Orchestration
**Gap**: Agent skills are defined in code. No way to dynamically add new skills without code changes.

Allow skills to be defined as JSON/YAML documents in a `data/skills/` directory. CoS can discover, load, and route to these skills dynamically. The Prompt Manager UI extends to edit skill templates directly. When a new task type emerges that doesn't match existing skills, CoS can draft a new skill template based on the task pattern — self-generating its own capabilities.

**Touches**: `server/services/taskClassifier.js`, Prompt Manager, `data/skills/` directory, CoS routing

---

## Summary Matrix

| # | Feature | Goal Alignment | Effort | Impact |
|---|---------|---------------|--------|--------|
| 1 | Chronotype-Aware Scheduling | Identity + CoS | Medium | High |
| 2 | Identity Context Injection | Identity + AI | Medium | High |
| 3 | Mortality-Aware Goal Widget | Legacy + Identity | Low | Medium |
| 4 | Behavioral Feedback Loop | Identity | Medium | High |
| 5 | Agent Confidence Levels | Autonomy + Learning | Medium | High |
| 6 | Content Calendar | Autonomy + CoS | High | Medium |
| 7 | Proactive Insight Alerts | Learning + Knowledge | Low | Medium |
| 8 | Goal Decomposition Engine | CoS + Learning | High | High |
| 9 | Knowledge Graph | Knowledge + Legacy | High | High |
| 10 | Time Capsule Snapshots | Legacy | Low | Medium |
| 11 | Autobiography Chains | Legacy + Identity | Medium | Medium |
| 12 | Legacy Export | Legacy | Low | Medium |
| 13 | Unified Search | Productivity | Medium | High |
| 14 | Dashboard Customization | Productivity | Medium | Medium |
| 15 | Workspace Contexts | Productivity | High | Medium |
| 16 | Inline Code Annotations | Productivity + CoS | High | Medium |
| 17 | Voice Capture | Knowledge + Multi-Modal | Medium | Medium |
| 18 | RSS Feed Ingestion | Knowledge + Autonomy | Medium | Medium |
| 19 | Ambient Dashboard | Access + Productivity | Low | Low |
| 20 | Dynamic Skill Marketplace | Learning + CoS | High | High |

---

*Generated 2026-02-25 by CoS feature brainstorming task. These ideas supplement the existing PLAN.md roadmap (M42, M34 P3-P7, M7) and are meant as candidates for future milestone planning.*
