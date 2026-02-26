# PortOS — Goals

> A self-hosted operating system for your dev machine that centralizes app management, AI agent orchestration, personal knowledge capture, digital identity modeling, and health tracking into a single dashboard — accessible anywhere via Tailscale.

## Purpose

PortOS transforms a local development machine into an intelligent personal operating system. This app is intended to help the user manage their life, their health, their goals, their projects, and their machines. It exists to solve the fragmentation of developer workflows — managing apps, orchestrating AI agents, capturing knowledge, tracking health, and modeling personal identity are all scattered across dozens of tools with no unified interface. PortOS brings these together in a single dashboard that runs on your own hardware, keeps your data local, and is accessible from any device on your private Tailscale network.

## Core Goals

### 1. Centralized App Lifecycle Management

Single dashboard for managing active git repos, PM2 processes, logs, and JIRA integration. Real-time status monitoring, streaming log output, and smart project detection eliminate the need to juggle terminal windows and browser tabs across projects.

### 2. Autonomous AI Agent Orchestration

Chief of Staff (CoS) system that autonomously generates tasks from goals, routes them to the best AI provider based on learned success rates, and executes without human intervention. Multi-provider support (Claude, Codex, Gemini, Ollama, LM Studio) with fallback chains, model tier selection, and continuous learning from outcomes. The system should get smarter over time, not just execute.

### 3. Personal Knowledge Management

Brain (thought capture and classification) and Memory (vector-embedded semantic retrieval) systems that function as a persistent second brain. Thoughts are captured, auto-classified by LLM, and indexed for hybrid retrieval (vector similarity + BM25 keyword search). Daily and weekly digests surface patterns and connections across captured knowledge.

### 4. Digital Identity Modeling

Build a persistent digital twin — a machine-readable representation of identity, personality, preferences, and history. Includes behavioral testing, taste profiling, genome visualization, autobiography, and social account mapping. The twin briefs AI agents on tone, style, and preferences so they can act authentically on your behalf.

### 5. Developer Productivity Toolkit

Web-based shell, git tools, process monitoring, browser control (CDP/Playwright), action history, and AI run tracking. Everything a developer needs for daily work, accessible from any device. CyberCity 3D visualization brings the system to life.

### 6. Self-Improving Intelligence

The system learns from its own operation — task success rates inform provider routing, corrupted metrics self-heal on startup, and autonomous jobs generate code quality improvements. This isn't static tooling; it's a system that gets better at serving you the longer it runs.

### 7. Full Digital Autonomy

AI agents should be capable of operating fully autonomously across all connected platforms without requiring human intervention. From generating content to managing social presence to executing scheduled workflows, the goal is a system that can act on your behalf around the clock with the judgment and taste of your digital twin.

### 8. Knowledge Legacy

Preserve personal knowledge, identity, decision-making patterns, and life story beyond a single lifetime. The autobiography system, genome data, behavioral profiles, and captured memories form a durable record — not just of what you built, but of who you are and how you think.

### 9. Anywhere Access on Private Network

Tailscale VPN enables secure access from any device without public internet exposure. The entire system — dashboard, shell, browser, AI agents — is available from your phone, tablet, or any remote machine on your mesh network.

### 10. Health & Longevity

Help the user live a long, healthy life. MeatSpace tracks physical health data — alcohol consumption, blood work, body metrics, epigenetic age, eye health, genome markers, and lifestyle factors — and surfaces it alongside mortality projections and longevity escape velocity tracking. Combined with genome-derived life expectancy and mortality-aware goal scoring, the system makes health data actionable: not just recording what happened, but informing what to do next. The same goal-tracking system that manages digital projects manages meatspace goals — exercise targets, biomarker improvements, habit changes — with the same urgency scoring and progress visualization.

## Secondary Goals

- **Multi-Modal Identity Capture**: Voice, video, and image-based identity modeling beyond text
- **Apple Health Integration**: Live sync from iOS and bulk historical import to unify all health data in one place
- **Chronotype-Aware Scheduling**: Align task scheduling to natural energy patterns derived from genome sleep markers

## Non-Goals

- **Multi-user support**: PortOS is a personal tool built for one person. Adding auth, roles, or multi-tenancy would add complexity with no benefit.
- **Public internet deployment**: Runs on a private Tailscale network. No HTTPS, CORS, rate limiting, or public-facing hardening needed.
- **Database-backed persistence**: JSON files are intentional. They're human-readable, git-friendly, and sufficient for single-user scale. No Postgres, SQLite, or MongoDB.
- **Authentication / Authorization**: Single-user on a private network. Auth would be security theater here.
- **Cloud hosting**: Runs on your local machine. Your data stays on your hardware.

## Target Users

PortOS is built for Adam Eivy — a single developer managing active git repos, orchestrating AI workflows, and building a persistent digital identity on a local machine. It's a personal tool designed around one person's workflows, preferences, and ambitions. While open source (MIT), it's not designed for general adoption or onboarding other users.

## Current State

See [PLAN.md](./PLAN.md) for detailed milestone tracking and roadmap.

| Goal | Status | Notes |
|------|--------|-------|
| Centralized App Management | Complete | Core infrastructure, app wizard, streaming import, PM2 standardization. |
| Autonomous AI Orchestration | Ongoing | CoS, agent runner, skill system, autonomous jobs, task learning all operational. Continuous refinement. |
| Personal Knowledge Management | Ongoing | Brain capture, semantic memory, weekly digests, memory classification all complete. Quality tuning continues. |
| Digital Identity Modeling | Ongoing | Soul, digital twin, identity orchestrator (M42 P1-P4), behavioral feedback, taste profiling, autobiography all shipped. Cross-insights engine (M42 P5) next. |
| Developer Productivity Toolkit | Complete | Shell, git, browser, history, usage, JIRA, CyberCity all shipped. |
| Self-Improving Intelligence | Ongoing | Task learning, self-improvement analysis, autonomous jobs, self-healing metrics active. |
| Full Digital Autonomy | Ongoing | Agent tools, Moltworld, scheduling, skill system operational. Expanding platform coverage and autonomy tiers. |
| Knowledge Legacy | Early | Autobiography, genome, behavioral profiles captured. Legacy export format not yet built. |
| Anywhere Access | Complete | Tailscale integration working. Mobile-responsive UI. All features accessible remotely. |
| Health & Longevity | Ongoing | MeatSpace shipped with death clock, LEV tracker, alcohol/blood/body/epigenetic/eye/genome/lifestyle tracking. Apple Health integration planned. |

## Operational Goals

The CoS autonomous agent system reads these goals to guide its behavior and task generation.

### Goal 1: Codebase Quality
- Run security audits weekly
- Check for mobile responsiveness issues
- Find and fix DRY violations
- Remove dead code and unused imports
- Improve test coverage
- Fix console errors and warnings

### Goal 2: Self-Improvement
- Add new capabilities to the CoS system
- Improve the self-improvement task prompts
- Add new analysis types (a11y, i18n, SEO)
- Better error recovery and retry logic
- Smarter task prioritization
- Learn from completed tasks

### Goal 3: Documentation
- Keep PLAN.md up to date with completed milestones
- Document new features in /docs
- Generate daily/weekly summary reports
- Track metrics and improvements over time
- Maintain clear task descriptions

### Goal 4: User Engagement
- Prompt user for feedback on completed tasks
- Suggest new features based on usage patterns
- Help user define and track their goals
- Provide status updates and progress reports
- Ask clarifying questions when tasks are ambiguous

### Goal 5: System Health
- Monitor PM2 processes continuously
- Check for memory leaks and performance issues
- Verify all services are running correctly
- Alert on critical errors immediately
- Auto-fix common issues when safe

### Task Generation Priorities

When idle, generate tasks in this priority order:

1. **Critical Fixes**: Security vulnerabilities, crashes, data loss risks
2. **User Tasks**: Any pending tasks from TASKS.md
3. **Health Issues**: PM2 errors, failed processes, high memory
4. **Self-Improvement**: UI bugs, mobile issues, code quality
5. **Documentation**: Update docs, generate reports
6. **Feature Ideas**: New capabilities, enhancements

### Core Principles

1. **Proactive Over Reactive**: Don't wait for problems - find and fix them before they become issues
2. **Continuous Improvement**: Always look for ways to make things better
3. **User Partnership**: Prompt the user to help curate tasks and provide feedback
4. **Documentation First**: Maintain rich documentation, plans, and task tracking
5. **Quality Over Speed**: Use the heavy model (Opus) for important work - quality matters
