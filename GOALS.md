# PortOS — Goals

> A self-hosted operating system for your dev machine that centralizes app management, AI agent orchestration, personal knowledge capture, and digital identity modeling into a single dashboard — accessible anywhere via Tailscale.

## Purpose

PortOS transforms a local development machine into an intelligent personal operating system. This app is intended to help the user manage their life, their goals, their projects, and their machines. It exists to solve the fragmentation of developer workflows — managing apps, orchestrating AI agents, capturing knowledge, and modeling personal identity are all scattered across dozens of tools with no unified interface. PortOS brings these together in a single dashboard that runs on your own hardware, keeps your data local, and is accessible from any device on your private Tailscale network.

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

## Secondary Goals

- **Behavioral Feedback Loop**: "Sounds like me" response validation with adaptive weighting to continuously refine the digital twin
- **Mortality-Aware Goal Tracking**: Birth date + genome longevity markers to urgency-score goals based on projected lifespan
- **Multi-Modal Identity Capture**: Voice, video, and image-based identity modeling beyond text

## Non-Goals

- **Multi-user support**: PortOS is a personal tool built for one person. Adding auth, roles, or multi-tenancy would add complexity with no benefit.
- **Public internet deployment**: Runs on a private Tailscale network. No HTTPS, CORS, rate limiting, or public-facing hardening needed.
- **Database-backed persistence**: JSON files are intentional. They're human-readable, git-friendly, and sufficient for single-user scale. No Postgres, SQLite, or MongoDB.
- **Authentication / Authorization**: Single-user on a private network. Auth would be security theater here.
- **Cloud hosting**: Runs on your local machine. Your data stays on your hardware.

## Target Users

PortOS is built for Adam Eivy — a single developer managing active git repos, orchestrating AI workflows, and building a persistent digital identity on a local machine. It's a personal tool designed around one person's workflows, preferences, and ambitions. While open source (MIT), it's not designed for general adoption or onboarding other users.

## Current State

| Goal | Status | Notes |
|------|--------|-------|
| Centralized App Management | Complete | Core infrastructure (M0-M4, M9, M17-M18) all shipped. |
| Autonomous AI Orchestration | In Progress | CoS fully operational (M14, M19-M31, M35, M37, M40). Learning system active. Continuous refinement. |
| Personal Knowledge Management | In Progress | Brain (M32) and Memory (M16, M31) complete. Digest system running. Ongoing quality tuning. |
| Digital Identity Modeling | In Progress | Soul (M33), Digital Twin (M34 P1-P2,P4), Genome, Autobiography complete. Identity orchestrator (M42) planned next. |
| Developer Productivity Toolkit | Complete | Shell, git, browser (M36), history, usage, CyberCity (M41) all shipped. |
| Self-Improving Intelligence | In Progress | Task learning (M25), self-improvement (M23), autonomous jobs (M37) active. Self-healing metrics recently added. |
| Full Digital Autonomy | In Progress | Agent tools (M38), Moltworld (M43), scheduling (M26, M30) operational. Expanding platform coverage. |
| Knowledge Legacy | Early | Autobiography prompts (M34 P5) launched. Genome data captured. Long-term preservation strategy not yet defined. |
| Anywhere Access | Complete | Tailscale integration working. Mobile-responsive UI. All features accessible remotely. |

## Direction

PortOS is entering its **identity integration phase**. The next major work (M42) unifies the digital twin, genome, chronotype, and behavioral data under a single identity orchestrator. This enables:

1. **Chronotype-aware scheduling** — CoS tasks aligned to your natural energy patterns derived from genome sleep markers
2. **Personalized AI prompting** — Every AI interaction informed by unified identity context
3. **Mortality-aware goals** — Urgency scoring based on projected lifespan

Beyond M42, the trajectory is toward deeper autonomy (agents that need less supervision), richer identity modeling (multi-modal capture, behavioral feedback loops), and knowledge preservation as a durable legacy.

Recent momentum: 43 milestones shipped, security audit (S1-S10) complete, v0.18.5 on dev. The project iterates rapidly — 3 minor versions in the last month with both features and hardening in each release.

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
