# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **M50 P8**: Messages — Digital Twin voice drafting for email responses (reads COMMUNICATION.md, PERSONALITY.md, VALUES.md + thread context)
2. **M42 P5**: Cross-Insights Engine — connect genome + taste + personality + goals into derived insights. See [Identity System](./docs/features/identity-system.md)
3. **M34 P5-P7**: Digital Twin — Multi-modal capture, advanced testing, personas

## Backlog

- [x] **Keyboard Shortcuts Help Modal** — Press `?` to show all keyboard shortcuts; global overlay with section grouping, accessible dialog
- [ ] **God file decomposition** — Split cos.js, subAgentSpawner.js, digital-twin.js, routes/scaffold.js, routes/cos.js, client/api.js into focused modules; resolve circular dependency
- [ ] **Test coverage** — Critical gaps: cos.js, cosRunnerClient.js, agentActionExecutor.js (~29% service, ~12% route coverage)
- [ ] **M50 P9**: CoS Automation & Rules — Automated email classification, rule-based pre-filtering, email-to-task pipeline
- [ ] **M50 P10**: Auto-Send with AI Review Gate — Per-account trust level, second LLM reviews drafts. See [Messages Security](./docs/features/messages-security.md)

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

---

## Future Ideas

- **Chronotype-Aware Scheduling** — Genome sleep markers for peak-focus task scheduling
- **Identity Context Injection** — Per-task-type digital twin preamble toggle
- **Agent Confidence & Autonomy Levels** — Dynamic tiers based on success rates
- **Content Calendar** — Unified calendar across platforms
- **Proactive Insight Alerts** — Brain connections, success drops, goal stalls, cost spikes
- **Goal Decomposition Engine** — Auto-decompose goals into task sequences
- **Knowledge Graph Visualization** — Extend BrainGraph 3D to full knowledge graph
- **Time Capsule Snapshots** — Periodic versioned digital twin archives
- **Autobiography Prompt Chains** — LLM follow-ups building on prior answers
- **Legacy Export Format** — Identity as portable Markdown/PDF
- **Dashboard Customization** — Drag-and-drop widgets, named layouts
- **Workspace Contexts** — Project context syncing across shell, git, tasks
- **Inline Code Review Annotations** — One-click fix from self-improvement findings
- **Major Dependency Upgrades** — React 19, Zod 4, PM2 6, Vite 8
- **Voice Capture for Brain** — Microphone + Web Speech API transcription
- **RSS/Feed Ingestion** — Passive feed ingestion classified by interests
- **Ambient Dashboard Mode** — Live status board for wall-mounted displays
- **Dynamic Skill Marketplace** — Self-generating skill templates from task patterns
