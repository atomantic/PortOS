# PortOS — Goals

> A self-hosted "everything app" for the user's second brain and digital identity — centralizing creative production, knowledge capture, AI agent orchestration, health & longevity tracking, app management, communications, and lifelong learning into a single dashboard, accessible anywhere via Tailscale.

## Purpose

PortOS transforms a local development machine into an intelligent personal operating system — the user's everything app for managing their life, their health, their goals, their projects, their machines, and their creative output. It exists to help the user **interface more deeply with the world and with themselves**, **create more than they consume**, and **learn, grow, and explore the evolving world of software engineering**. It solves the fragmentation of modern life — knowledge capture, identity modeling, creative production, health tracking, AI orchestration, communication, and app management are scattered across dozens of tools with no unified interface. PortOS brings these together in a single dashboard that runs on your own hardware, keeps your data local, and is accessible from any device on your private Tailscale network.

## Core Goals

### 1. Centralized App Lifecycle Management

Single dashboard for managing active git repos, PM2 processes, logs, and JIRA integration. Real-time status monitoring, streaming log output, and smart project detection eliminate the need to juggle terminal windows and browser tabs across projects.

### 2. Autonomous AI Agent Orchestration

Chief of Staff (CoS) system that autonomously generates tasks from goals, routes them to the best AI provider based on learned success rates, and executes without human intervention. Multi-provider support (Claude, Codex, Antigravity, Ollama, LM Studio) with fallback chains, model tier selection, and continuous learning from outcomes. The system should get smarter over time, not just execute.

### 3. Personal Knowledge Management

Brain (thought capture and classification) and Memory (vector-embedded semantic retrieval) systems that function as a persistent second brain. Thoughts are captured, auto-classified by LLM, and indexed for hybrid retrieval (vector similarity + BM25 keyword search). Daily and weekly digests surface patterns and connections across captured knowledge.

### 4. Digital Identity Modeling

Build a persistent digital twin — a machine-readable representation of identity, personality, preferences, and history. Includes behavioral testing, taste profiling, genome visualization, autobiography, and social account mapping. The twin briefs AI agents on tone, style, and preferences so they can act authentically on your behalf. Ask Yourself (`/ask`) closes the loop in the other direction: a chat interface with the twin grounded in identity, goals, memory, and Brain captures, so the user can interrogate their own patterns and history.

### 5. Creative Production Suite

Make it easier to create than to consume. PortOS is an end-to-end creative studio: **Writers Room** (distraction-free prose with timed exercises and AI passes for summary, extraction, expansion, prose-to-script, media planning); **Universe Builder** (world bible generation, characters, locations, items, factions, and lore on a lockable canon canvas); **Series Pipeline** (multi-issue/episode production for comics, episodic video, and novel chapters with arc shapes, volume + season outlines, story bible, and per-stage prompts); **Creative Director** (treatment → scene plan → render orchestration for short films); **Image Gen** (FLUX, Z-Image, A1111, external endpoints); **Video Gen** (LTX text-to-video, image-to-video, audio-to-video, extend); **Timeline Editor** (stitch, composite, trim clips and audio); and asset/model management (Collections, LoRAs with Civitai sync, HuggingFace model cache, Image Cleaner). External work flows **in** through the **Importer** (analyze novels, screenplays, comics into structured Universes or Pipeline series). Finished work flows **out** through **Sharing** (cloud-synced buckets for cross-network distribution of universes, series, characters, and media). The Digital Twin briefs every creative tool on voice and taste so output reflects the user's authentic style.

### 6. Developer Productivity Toolkit

Web-based shell, git tools, process monitoring, browser control (CDP/Playwright), action history, AI run tracking, in-app code runner, submodule tracking, reference-repo indexing, and prompt management. Everything a developer needs for daily work, accessible from any device. The toolkit doubles as a vehicle for **exploring the evolving world of software engineering** — every new AI provider, agent framework, or modeling technique gets a first-class integration so the user can build with it, not just read about it. CyberCity 3D visualization brings the running system to life.

### 7. Self-Improving Intelligence

The system learns from its own operation — task success rates inform provider routing, corrupted metrics self-heal on startup, and autonomous jobs generate code quality improvements. This isn't static tooling; it's a system that gets better at serving you the longer it runs.

### 8. Full Digital Autonomy

AI agents should be capable of operating fully autonomously across all connected platforms without requiring human intervention. From generating content to managing social presence to executing scheduled workflows, the goal is a system that can act on your behalf around the clock with the judgment and taste of your digital twin.

### 9. Knowledge Legacy

Preserve personal knowledge, identity, decision-making patterns, creative output, and life story beyond a single lifetime. The autobiography system, genome data, behavioral profiles, captured memories, written work, and built worlds form a durable record — not just of what you built, but of who you are and how you think.

### 10. Anywhere Access on Private Network

Tailscale VPN enables secure access from any device without public internet exposure. The entire system — dashboard, shell, browser, AI agents, creative studio — is available from your phone, tablet, or any remote machine on your mesh network.

### 11. Health & Longevity

Help the user live a long, healthy life. MeatSpace tracks physical health data — alcohol consumption, blood work, body metrics, epigenetic age, eye health, genome markers, and lifestyle factors — and surfaces it alongside mortality projections and longevity escape velocity tracking. Combined with genome-derived life expectancy and mortality-aware goal scoring, the system makes health data actionable: not just recording what happened, but informing what to do next. The same goal-tracking system that manages digital projects manages meatspace goals — exercise targets, biomarker improvements, habit changes — with the same urgency scoring and progress visualization.

### 12. Personal Productivity & Life Management

Calendar integration, life goal tracking, and communication management transform PortOS from a developer tool into a complete personal operating system. Google Calendar sync with chronotype-aware scheduling ensures the user's human time is optimized alongside their digital systems. Goal tracking with AI-powered check-ins keeps long-term ambitions on track with calendar-booked work sessions. Email management with AI categorization, Digital Twin voice drafting, and a review-before-send outbox reduces email overhead while maintaining authentic communication. Voice agent, Telegram bot, and OpenClaw (operator chat) extend the interface across modalities so the user can act on PortOS data from any context.

### 13. Cognitive Training & Lifelong Learning

Sharpen the mind alongside everything else. **POST** delivers a daily 5-minute self-test across five domains — mental math, wordplay, memory (spaced repetition for the Elements Song, karaoke, flashcards), verbal agility, and imagination (LLM-scored creativity). Specialized modes cover **Morse code** (CW, Koch method) and **Rapid Reader** (adjustable-WPM speed reading). The **Wiki** captures long-form personal knowledge as a browsable, searchable, graph-linked corpus. The aim is sustained cognitive growth — not just capturing what you learn, but actively strengthening how you learn.

## Secondary Goals

- **Multi-Modal Identity Capture**: Voice, video, and image-based identity modeling beyond text
- **Chronotype-Aware Scheduling**: Align task scheduling to natural energy patterns derived from genome sleep markers
- **Music & Audio Production**: MusicGen-style local generation, whole-episode audio mixing strategy, audio recording / podcast studio (deferred until 128GB hardware arrives)
- **Inspiration & Mood Board**: A dedicated canvas for collecting visual / textual references that feed into Universe Builder, Writers Room, and Creative Director — distinct from raw Media History
- **Sketch & Annotation Canvas**: Lightweight drawing surface for storyboarding, panel sketches, and marking up generated images before re-rendering
- **Federated Sharing**: Direct peer-to-peer distribution between PortOS instances on the same Tailnet, beyond the cloud-bucket-based Sharing system
- **Cross-Domain Insights Engine**: M42 P5 — connect genome ↔ health ↔ taste ↔ identity ↔ creative output into narrative insights surfaced in Brain

## Non-Goals

- **Multi-user support**: PortOS is a personal tool built for one person. Adding auth, roles, or multi-tenancy would add complexity with no benefit.
- **Public internet deployment**: Runs on a private Tailscale network. No CORS, rate limiting, or public-facing hardening needed. (HTTPS is supported via `npm run setup:cert` for browser-API and cert-trust convenience — not as public-exposure hardening.)
- **ORM / heavyweight database tooling**: PostgreSQL + pgvector is the primary datastore for app-native relational records (see the [storage contract](./docs/STORAGE.md) and the [Postgres ADR](./docs/decisions/2026-06-07-postgres-as-primary-datastore.md)), but PortOS deliberately uses plain SQL — no ORM, no query builder. Binary assets and externally-synced/ephemeral state stay as files under `data/`.
- **Authentication / Authorization**: Single-user on a private network. Auth would be security theater here.
- **Cloud hosting**: Runs on your local machine. Your data stays on your hardware.

## Target Users

PortOS is built for Adam Eivy — a single developer managing active git repos, orchestrating AI workflows, and building a persistent digital identity on a local machine. It's a personal tool designed around one person's workflows, preferences, and ambitions. While open source (MIT), it's not designed for general adoption or onboarding other users.

## Current State

The active roadmap lives in the GitHub issue tracker — open issues labeled
[`plan`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Aplan)
(claimable) and [`future`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Afuture)
(parked ideas). See [PLAN.md](./PLAN.md) for the pointer.

| Goal | Status | Notes |
|------|--------|-------|
| Centralized App Management | Complete | Core infrastructure, app wizard, streaming import, PM2 standardization. |
| Autonomous AI Orchestration | Ongoing | CoS, agent runner, skill system, autonomous jobs, task learning all operational. Continuous refinement. |
| Personal Knowledge Management | Ongoing | Brain capture, semantic memory, weekly digests, memory classification all complete. Quality tuning continues. |
| Digital Identity Modeling | Ongoing | Soul, digital twin, identity orchestrator (M42 P1-P4), behavioral feedback, taste profiling, autobiography, Ask Yourself all shipped. Cross-insights engine (M42 P5) next. |
| Creative Production Suite | Ongoing | Writers Room, Universe Builder, Series Pipeline, Creative Director, Image Gen, Video Gen, Timeline Editor, Collections, LoRAs, Importer, Sharing all shipped. FLUX.2 multi-reference, whole-episode audio, rich-text prose editor, episodic-video provider expansion in flight. |
| Developer Productivity Toolkit | Complete | Shell, git, browser, history, usage, JIRA, code runner, submodules, reference repos, CyberCity all shipped. |
| Self-Improving Intelligence | Ongoing | Task learning, self-improvement analysis, autonomous jobs, self-healing metrics active. |
| Full Digital Autonomy | Ongoing | Agent tools, Moltworld, scheduling, skill system operational. Expanding platform coverage and autonomy tiers. |
| Knowledge Legacy | Ongoing | Autobiography, genome, behavioral profiles, written work, built worlds captured. Portable Legacy Export bundle (Digital Twin → Legacy Bundle) ships a self-contained Markdown + JSON + manifest archive, with optional rendered PDF. Richer key-decisions sourcing and deeper domain coverage continue. |
| Anywhere Access | Complete | Tailscale integration working. Mobile-responsive UI. All features accessible remotely. |
| Health & Longevity | Ongoing | MeatSpace shipped with death clock, LEV tracker, alcohol/blood/body/epigenetic/eye/genome/lifestyle tracking. Apple Health integration shipped (live ingest, metrics/correlation queries, bulk XML/clinical import). |
| Personal Productivity & Life Management | Ongoing | Calendar (agenda/day/week/month/lifetime/review), Messages inbox + drafts, voice agent, Telegram bot, OpenClaw operator chat all shipped. Proactive CoS speech triggers and voice-tool coverage expanding. |
| Cognitive Training & Lifelong Learning | Ongoing | POST (math/wordplay/memory/verbal/imagination), Morse, Rapid Reader, Wiki shipped. Adding more training domains and integrating cross-domain insights (e.g. genome-informed cognitive load patterns). |

## Operational Guidance

CoS task-generation rules, runtime priorities, and per-domain operational goals are tracked in [docs/GOALS_OPERATIONAL.md](./docs/GOALS_OPERATIONAL.md) — separate from the strategic goals above so this file stays focused on mission and direction.
