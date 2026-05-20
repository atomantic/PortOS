<p align="center">
  <img src="./docs/media/portos-logo.png" alt="PortOS logo" width="160" />
</p>

<h1 align="center">PortOS</h1>

**Your self-hosted operating system for dev machines.** Manage apps, orchestrate AI agents, build your digital twin, capture knowledge, and track your health — all from a single dashboard accessible anywhere via [Tailscale](https://tailscale.com).

Think [Umbrel](https://umbrel.com), but for your active git repos, AI workflows, and personal knowledge. Access everything from your phone, tablet, or any device on your Tailscale network.

> **Highly opinionated & personal.** PortOS is built for one specific use case: a single developer running it on their own machine, behind Tailscale, with their own AI providers and workflows. It makes strong assumptions about how you work and will keep making them. Pull requests are welcome — but the project will always prioritize the author's needs first, and merges may introduce breaking changes without warning. If something stops working after an update, ask your coding agent of choice to read the changelog and upgrade your local data: `"Read .changelog/vX.Y.Z.md and fix any migration issues in my PortOS data/ directory."`

![PortOS Chief of Staff](./docs/media/portos_1.png)

---

## Why PortOS?

Most developers juggle a dozen tools — PM2 terminals, JIRA boards, AI chat windows, note apps, health trackers. PortOS unifies them into a single local-first dashboard that runs on your dev machine and travels with you over Tailscale.

- **One dashboard** for all your apps, agents, and knowledge
- **AI agents that work while you sleep** — autonomous task execution with multi-model orchestration
- **A complete creative studio** — write prose, generate stills/video, plan multi-issue series, and ship to friends over a synced share folder
- **Your identity, quantified** — genomics, chronotype, taste profiling, and mortality-aware goal tracking
- **Second brain included** — capture thoughts, auto-classify them, and surface insights with daily digests
- **Mobile-first design** — manage your entire dev environment from your phone

---

## Screenshots

| Chief of Staff | AI Agents | AI Providers |
|:-:|:-:|:-:|
| ![Chief of Staff](./docs/media/portos_1.png) | ![AI Agents](./docs/media/portos_2.png) | ![AI Providers](./docs/media/portos_3.png) |

| App Wizard | PM2 Processes | Chief of Staff Tasks |
|:-:|:-:|:-:|
| ![App Wizard](./docs/media/portos_4.png) | ![PM2 Processes](./docs/media/portos_5.png) | ![Chief of Staff Tasks](./docs/media/portos_6.png) |

| Login | CyberCity |
|:-:|:-:|
| ![Login](./docs/media/portos_0.png) | ![CyberCity](./docs/media/portos_7.png) |

---

## Features

### App Management

Bring your entire portfolio of projects under one roof.

- **Dashboard** — Grid of app tiles with real-time status, port links, start/stop/restart controls, and system health monitoring
- **Smart Import** — Point to a directory and auto-detect project config from `package.json`, `vite.config`, and `ecosystem.config` ([App Wizard docs](./docs/features/app-wizard.md))
- **App Templates** — Scaffold new projects from pre-built templates with AI provider integration
- **Real-time Logs** — Stream PM2 logs via Socket.IO with tail length control
- **JIRA Integration** — Per-app board config, active sprint resolution, epic search, and ticket creation from the UI ([Sprint Manager docs](./docs/features/jira-sprint-manager.md))
- **Autofixer** — Autonomous crash detection and repair: polls PM2 for errored processes, invokes AI to diagnose and fix, tracks attempts with cooldowns ([Autofixer docs](./docs/features/autofixer.md))

### Chief of Staff (CoS)

An autonomous AI agent orchestrator that manages your development workflow. Submit a task, and CoS dispatches the right AI agent to handle it — then learns from the result. ([Full docs](./docs/features/chief-of-staff.md))

- **Multi-Agent Orchestration** — Run Claude Code, Codex, Gemini CLI, Ollama, and LM Studio concurrently with global and per-project limits, capacity management, and fair scheduling ([Agent Runner docs](./docs/features/cos-agent-runner.md))
- **Intelligent Routing** — 6 agent skill templates (bug-fix, feature, security-audit, refactor, docs, mobile) route tasks to the best model based on complexity ([Agent Skills docs](./docs/features/agent-skills.md))
- **Task Learning** — Tracks success rates, error patterns, and model performance to dynamically improve routing decisions ([Memory System docs](./docs/features/memory-system.md))
- **Goal Tracking** — Define goals and track progress across hundreds of completed tasks with success rate metrics
- **Scheduled Automation** — Cron-based self-improvement and app-improvement jobs with per-app interval overrides
- **Error Recovery** — 6 strategies (retry, escalate, fallback, decompose, defer, investigate) for automatic diagnosis and retry ([CoS Enhancement docs](./docs/features/cos-enhancement.md))
- **Hybrid Memory Search** — BM25 + vector search with Reciprocal Rank Fusion for semantic retrieval across agent history
- **Productivity Analytics** — Work streaks, hourly/daily patterns, milestones, and AI-generated weekly digests
- **Decision Transparency** — Every skip, switch, and routing decision is logged with reasons, surfaced on the dashboard

### Create Suite

A full creative studio for taking an idea from blank page to finished media. Each surface feeds the next — prose drafted in Writers Room becomes a series in the Pipeline, the Pipeline pulls characters and locations from a Universe Builder canon, the canon generates reference images through Media Gen, and finished work goes out through Sharing.

- **Writers Room** — Distraction-free writing environment with folders, works, drafts, and version history. Includes a "write for 10" timed exercise with live word count and explicit AI passes (summary, character/scene extraction, expansion recommendations, prose-to-script, media planning) ([Writers Room docs](./docs/features/writers-room.md))
- **Universe Builder** — Describe a world in one prompt, expand it into a full bible (logline, premise, style notes, characters, locations, items, factions, lore), generate per-category variations, promote them to canon, and render reference images that all land in one auto-named collection. Lockable fields prevent regenerate-overwrites of approved canon
- **Series Pipeline** — Long-lived parent for multi-issue/episode productions. Each series carries its own arc shape (Pixar / Save the Cat / Freytag / custom), volume + season outlines, story bible, and per-issue stages (script → storyboard → comic pages or video render). Arc-stage approval locks freeze the approved version against accidental regeneration
- **Media Gen** — Unified surface for image and video generation across local and external backends:
  - **Image** — FLUX.1, FLUX.2 (klein), Z-Image via MFLUX/diffusers locally; A1111 / external endpoints; OpenAI Codex `gpt-image` mode
  - **Video** — LTX models via `mlx_video` on macOS, diffusers on Windows. Modes: text-to-video, image-to-video, first/last-frame, extend, audio-to-video
  - **Creative Director** — Treatment → scene plan → render orchestration for short films, with a media job queue serializing local GPU work
  - **Timeline Editor** — Stitch clips, scenes, and audio into longer videos
  - **Collections / History / Models / LoRAs** — Browse generated assets, install Civitai LoRAs by URL, and manage installed model weights
- **Importer** — Drop in an external manuscript (short story, novel, screenplay, comic script). The importer analyzes the text, suggests an arc shape, classifies characters/locations/scenes, and commits the result as either a new Writers Room work or a Pipeline series with a pre-filled bible
- **Sharing** — Cross-network share buckets via cloud-synced folders (Dropbox / iCloud / etc.). Register a bucket, pick `auto-merge` or `inbox` mode, and outgoing PortOS records (universes, series, characters, media) propagate to friends running their own PortOS instance. Live subscription indicators surface when the sender is actively editing
- **Image Cleaner** — Strip backgrounds, remove unwanted elements, and prep stills for downstream renders

### Digital Twin

An identity scaffolding system for building a quantified AI representation of yourself. Your digital twin informs every agent prompt, ensuring AI interactions align with your values and style. ([Full docs](./docs/features/digital-twin.md) | [Identity System docs](./docs/features/identity-system.md))

- **Genome Analysis** — Upload 23andMe data for 117 curated SNP markers across 32 categories with ClinVar integration ([Soul System docs](./docs/features/soul-system.md))
- **Chronotype Profiling** — 5 sleep-related genetic markers derive evening/morning preference with caffeine and meal timing recommendations
- **Taste Profiling** — Likert-scale preference scoring across 7 aesthetic domains (movies, music, art, architecture, food, fashion, digital) with AI-generated summaries
- **Mortality-Aware Goals** — Life expectancy from actuarial data + 10 genome longevity markers, with urgency scoring for goal prioritization (Goals tab supports tree + list views)
- **Behavioral Testing** — Run alignment tests across 14 dimensions with multi-model comparison
- **Contradiction Detection** — AI analysis flags inconsistencies across identity documents
- **Enrichment Questionnaire** — Guided questions across 14 categories to deepen the identity model
- **Writing Style Analysis** — Extract voice patterns and communication style from writing samples
- **Autobiography** — Long-form narrative biography assembled from identity, documents, and journal data
- **Ask Yourself** — Chat with your own twin: ask questions and get answers grounded in your identity, goals, memory, and Brain content
- **Character Sheet** — RPG-style aggregate view of your stats, traits, achievements, and current quests
- **Time Capsule** — Snapshot your current twin and seal it; the future can replay how you saw yourself today
- **Accounts** — Aggregate external accounts (Spotify, Google, etc.) that feed identity signals
- **Import/Export** — Import from Spotify and other sources; export as system prompt, CLAUDE.md, JSON, or individual files
- **Creation Wizard** — 5-step guided setup for building a new digital twin from scratch

### Brain (Second Brain)

A thought capture and knowledge management system — your offline-first external memory. ([Full docs](./docs/features/brain-system.md))

- **Thought Capture** — Natural language input with AI-powered auto-classification into People, Projects, Ideas, and Admin
- **Inbox Review** — Validate and correct AI classifications before they're filed (confidence threshold gating)
- **Daily Log + Notes** — Append-only daily journal alongside long-form notes; both flow into the same retrieval surface
- **Feeds (RSS)** — Subscribe to RSS sources; new items land in the Brain inbox for review/triage
- **Rapid Reader** — Speed-reading view for long inbox items with adjustable WPM
- **Knowledge Links + Graph** — Build a graph of connections between thoughts, people, and projects; visualize it
- **Memory System** — Long-term memory storage with vector similarity search, BM25 retrieval, and automatic consolidation ([Memory docs](./docs/features/memory-system.md))
- **Insights** — Cross-domain narratives (genome↔health correlations, taste↔identity themes) generated from captured data
- **Daily/Weekly Digest** — AI-curated summaries of captured knowledge (< 150 / 250 words)
- **Trust Scoring** — Rate data source reliability for better knowledge hygiene
- **Import** — Pull in data from external sources into the Brain pipeline
- **JSONL Audit Trail** — Full provenance tracking for every classified item

### Comms

Unified inbox for everything that talks back at you — email, chat, agent-generated drafts, and external operator chats.

- **Inbox / Drafts / Sync** — Aggregated message inbox with AI-generated drafts you can approve, edit, or discard before sending
- **OpenClaw** — In-app chat with external operator agents (computer-use, Anthropic operator, etc.) with app context, attachments, and streaming responses ([OpenClaw docs](./docs/features/openclaw-operator-chat.md))
- **Social Agents** — Personality-driven agents that handle specific accounts/personas

### Calendar

A unified calendar surface that pulls from Google Calendar (and other sources) and lays them out across multiple horizons.

- **Day / Week / Month / Agenda** — Standard calendar views with edit-in-place event handling
- **Lifetime View** — Your life as a grid of weeks against actuarial-derived life expectancy (powered by MortalLoom)
- **Review** — End-of-period retrospective surface that pulls in completed tasks, CoS digests, and journal entries
- **Sync** — Configurable bidirectional sync with external calendars

### Wiki

Personal long-form knowledge base — separate from Brain (capture surface) and Notes (drafts) — for curated, evergreen reference material.

- **Browse / Search / Graph / Log** — Wiki-style page navigation with full-text search, backlink graph, and edit history

### POST (Daily Cognitive Training)

A gamified daily cognitive self-test in ~5 minutes across 5 domains. ([Full docs](./docs/features/post.md))

- **Mental Math** — Speed and accuracy challenges with progressive difficulty
- **Memory Builder** — Elements Song spaced repetition with karaoke mode and flash cards
- **Wordplay** — Language analysis and verbal reasoning exercises
- **Verbal Agility** — Communication skill challenges
- **Imagination** — Creative thinking exercises scored by LLM
- **Progress Tracking** — Streaks, rolling averages, and performance history

### Developer Tools

Everything you need to manage your dev environment without leaving the browser.

- **Web Shell** — Full terminal emulator (xterm.js + node-pty) with multi-session support, attach/detach across browsers, and Ghostty theme integration
- **AI Runner** — Execute prompts across any configured provider directly from the UI ([Prompt Manager docs](./docs/features/prompt-manager.md))
- **AI Runs / AI Agents** — Live + historical views of every AI invocation across PortOS with runtime stats, app badges, and JIRA ticket links
- **Feature Agents** — Long-running, scoped agents that own a feature area and pick up work autonomously
- **Process Monitor** — View all PM2 processes with live memory, CPU, uptime, and restart controls
- **GitHub** — Per-repo branch/PR status, release workflows, and PR creation from the dashboard
- **Submodules** — Track and update git submodules across all registered apps
- **JIRA + JIRA Reports** — Per-app sprint board, ticket creation, and weekly/monthly reporting ([Sprint Manager docs](./docs/features/jira-sprint-manager.md))
- **DataDog** — Wire in a DataDog API key to surface logs/metrics from monitored apps
- **Loops** — Schedule recurring work (cron-style) for any PortOS action or agent task
- **Action History** — Searchable log of all executed actions with filtering and statistics
- **Usage** — Token spend and cost tracking across all configured AI providers
- **CyberCity** — 3D voxel city visualization of your apps and agents in real-time ([CyberCity V2 docs](./docs/features/cybercity-v2.md))
- **Browser Control** — Remote Chrome DevTools Protocol integration for headless browser management ([Browser docs](./docs/features/browser.md))
- **Code Runner** — In-app code execution with syntax highlighting
- **Reference Repos** — Cross-app index of reference repositories (libraries you read but don't own) for grounding agents
- **Templates** — Scaffold new apps from pre-built templates wired up to your AI providers
- **Review Hub** — Single inbox for actionable items (CoS approvals, alerts, todos, briefings) across every PortOS subsystem

### Voice Mode (Local)

Push-to-talk and hands-free voice assistant with no PortOS-hosted server dependencies. TTS and LLM run locally; STT is fully offline with whisper.cpp.

- **STT** — browser Web Speech API by default (zero-latency, no PortOS server process needed). **Note:** the Web Speech API in Chrome and most Chromium browsers forwards audio to a vendor cloud speech service (Google); for fully-offline STT with no data leaving the machine, select local [whisper.cpp](https://github.com/ggerganov/whisper.cpp) under *Settings → Voice → STT engine*. Optional CoreML encoder gives 2–3× speedup on Apple Silicon
- **Local TTS** — [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) running in-process via ONNX Runtime (default, cross-platform), or [Piper](https://github.com/rhasspy/piper) CLI as a lightweight alternative
- **Local LLM** — routed through your existing LM Studio installation
- **Push-to-talk** — click and hold the mic widget or hold `Space` to speak; release to send
- **Barge-in** — start a new turn while the assistant is speaking to interrupt and redirect
- **Configurable** — STT engine, TTS engine, voice, Whisper model size, CoreML, speech rate, system prompt all editable from Settings

Enable under *Settings → Voice*; PortOS provisions required voice components as needed on first enable — `whisper-cpp` via Homebrew (when STT is whisper), Piper + phonemize libs pulled from [rhasspy/piper](https://github.com/rhasspy/piper) GitHub Releases (when TTS is Piper), and selected Whisper/Piper models downloaded into `~/.portos/voice/`. Full setup in [Voice Mode docs](./docs/features/voice.md).

### Meatspace (Physical Health)

Track your biological self alongside your digital one.

- **Genome Visualization** — Genetic trait markers, cancer risk categories, and health predispositions (117 SNP markers)
- **Blood Work** — Biomarker data tracking and trend analysis
- **Body Composition** — Physical measurements and body tracking
- **Age Metrics** — Biological vs chronological age tracking
- **Lifestyle Tracking** — Alcohol, nicotine, and lifestyle factor monitoring
- **Health Import** — Import data from Apple Health and other sources

### Infrastructure

- **Mobile Ready** — Responsive design with collapsible sidebar for on-the-go access
- **Ambient Mode** — Full-screen "always-on display" view for a wall tablet or spare monitor (clock, agenda, death-clock, key metrics)
- **Command Palette (⌘K)** — Fuzzy-search every page, action, and dashboard layout in PortOS from one input. The same manifest powers voice navigation (`ui_navigate`)
- **Dashboard Layouts** — Multiple named dashboard layouts (default, focus, morning-review, ops) with a 12-column drag/resize grid; switch between them from `⌘K`
- **Theming** — Day/night theme pairs with one-click toggle
- **Multi-Provider AI** — Configure Claude, OpenAI, Gemini, Ollama, LM Studio, and more with model tiers, fallback chains, and per-provider availability tracking
- **Secret Management** — Environment variable masking, API key redaction, and PTY shell allowlisting
- **File Uploads** — Drag-and-drop file storage with preview support
- **Multi-Instance** — Peer-to-peer networking between PortOS instances with app and agent availability across nodes
- **Cross-Network Sharing** — Sync universes, series, characters, and media to friends via cloud-folder share buckets (Dropbox, iCloud, etc.) without a central server
- **Telegram Integration** — Bot integration for notification routing
- **Database Backups** — Scheduled PostgreSQL backups with cron configuration
- **Filesystem Backups** — rsync-based scheduled backups with overridable default-excludes for re-downloadable assets (LoRAs, model weights, COS caches)
- **Graceful Error Handling** — Centralized error normalization with real-time UI notifications and automatic CoS task creation for critical failures ([Error Handling docs](./docs/features/error-handling.md))

---

## Quick Start

```bash
git clone https://github.com/atomantic/PortOS.git
cd PortOS
./setup.sh
pm2 start ecosystem.config.cjs
pm2 save
```

Access PortOS at `http://localhost:5555` (or via Tailscale at `http://<machine>.<tailnet>.ts.net:5555`).

For HTTPS (recommended — required for the in-browser microphone, and you'll get a trusted cert via Tailscale's Let's Encrypt integration):

```bash
npm run setup:cert                   # Tailscale + Let's Encrypt (trusted)
npm run setup:cert -- --self-signed  # fallback if you don't have Tailscale
pm2 restart ecosystem.config.cjs
```

After that, `https://<machine>.<tailnet>.ts.net:5555` is the user-facing URL on every device. The same `:5555` is used for both HTTP and HTTPS — only the scheme changes. When HTTPS is enabled a loopback-only HTTP mirror also spawns at `http://localhost:5553` so local curl/scripts skip cert warnings (override with `PORTOS_HTTP_PORT`).

> A fresh install with no Tailscale **stays on HTTP**, so `http://localhost:5555` works out of the box. `npm start` will only auto-provision a cert when Tailscale's `tailscale cert` succeeds — it won't silently flip you to a self-signed HTTPS that breaks the URL above. Pass `--self-signed` if you want HTTPS without Tailscale (browser warning included).

PM2 keeps PortOS running in the background and auto-restarts on reboot (with `pm2 save` + `pm2 startup`).

### Development Mode

```bash
npm run install:all    # Install all dependencies
npm run dev            # Vite hot-reload on :5554, API on :5555 — open :5554 in dev
```

`:5554` is **only** used in dev for the Vite hot-reload server; in production (`npm start` / PM2) the React build is served from `:5555` directly.

## Network Access

PortOS binds to `0.0.0.0` so you can access it from any device on your Tailscale network:

- Manage apps running on your home dev machine from anywhere
- Check logs and restart services from your phone
- View dashboard on your tablet while coding on your laptop

> **Security Note**: PortOS is designed for private Tailscale networks. Do not expose ports 5553-5561 to the public internet. See the [Security Audit](./docs/SECURITY_AUDIT.md) for hardening details.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 18, Vite, Tailwind CSS, Three.js, xterm.js |
| **Backend** | Express.js, Socket.IO, PM2, Zod validation |
| **Data** | PostgreSQL, JSON file persistence, vector embeddings |
| **AI** | Claude Code, Codex, Gemini CLI, Ollama, LM Studio (via [portos-ai-toolkit](https://www.npmjs.com/package/portos-ai-toolkit)) |

## Project Structure

```
PortOS/
├── client/              # React + Vite frontend (Vite dev on :5554)
├── server/              # Express.js API (always serves on :5555)
├── data/                # Runtime data (apps, providers, history, brain, pipeline, …)
├── data.sample/         # Sample configurations to copy on first install
├── docs/                # Documentation and screenshots
├── lib/slashdo/         # Slashdo submodule (provides /do:* slash commands)
├── scripts/             # Setup, migration, and maintenance scripts
└── ecosystem.config.cjs # PM2 configuration
```

## PM2 Commands

```bash
pm2 start ecosystem.config.cjs    # Start PortOS
pm2 status                         # View status
pm2 logs portos-server --lines 100 # View server logs
pm2 restart portos-server portos-ui # Restart processes
pm2 stop portos-server portos-ui   # Stop processes
pm2 save                           # Save process list (survives reboot)
```

## Configuration

### Apps (`data/apps.json`)
Each registered app includes:
- **name** — Display name in the dashboard
- **repoPath** — Absolute path to project directory
- **uiPort / apiPort** — Port numbers for quick access links
- **startCommands** — Commands to start the app (used by PM2)
- **pm2ProcessNames** — PM2 process identifiers for status tracking

### AI Providers (`data/providers.json`)
Configure AI providers for the runner and Chief of Staff:
- **CLI-based**: Claude Code, Codex, Gemini CLI
- **API-based**: OpenAI, Anthropic, Google (with model tier management)
- **Local models**: Ollama, LM Studio (OpenAI-compatible endpoints)

## Documentation

### Architecture & Operations
- [Architecture Overview](./docs/ARCHITECTURE.md) — System design, data flow, and service diagram
- [API Reference](./docs/API.md) — 50+ REST endpoints and WebSocket events
- [Port Allocation](./docs/PORTS.md) — Port conventions (5553-5561) and allocation guide
- [PM2 Configuration](./docs/PM2.md) — PM2 patterns and best practices

### Development
- [Contributing Guide](./docs/CONTRIBUTING.md) — Development setup and code conventions
- [GitHub Actions](./docs/GITHUB_ACTIONS.md) — CI/CD workflow patterns
- [Versioning & Releases](./docs/VERSIONING.md) — Semantic versioning and release process
- [Security Audit](./docs/SECURITY_AUDIT.md) — Hardening audit (10/10 items resolved)
- [Troubleshooting](./docs/TROUBLESHOOTING.md) — Common issues and solutions

### Feature Deep Dives

- [Voice Mode](./docs/features/voice.md) — local STT/TTS/LLM voice assistant setup
- [Chief of Staff](./docs/features/chief-of-staff.md) — Autonomous agent orchestrator
- [Agent Skills](./docs/features/agent-skills.md) — Task-type-specific agent prompts
- [CoS Agent Runner](./docs/features/cos-agent-runner.md) — Isolated agent process architecture
- [CoS Enhancement](./docs/features/cos-enhancement.md) — Hybrid search, proactive execution, error recovery
- [Memory System](./docs/features/memory-system.md) — Semantic memory with vector search and importance decay
- [Digital Twin](./docs/features/digital-twin.md) — Genome, chronotype, taste, and mortality-aware goals
- [Identity System](./docs/features/identity-system.md) — Extended identity modeling (P1-P3)
- [Soul System](./docs/features/soul-system.md) — Identity scaffold with behavioral testing
- [Brain System](./docs/features/brain-system.md) — Offline-first second brain
- [POST](./docs/features/post.md) — Daily cognitive training
- [App Wizard](./docs/features/app-wizard.md) — App registration and scaffolding
- [Autofixer](./docs/features/autofixer.md) — Autonomous crash detection and repair
- [Browser](./docs/features/browser.md) — Headless browser automation
- [CyberCity V2](./docs/features/cybercity-v2.md) — 3D systems visualization
- [Prompt Manager](./docs/features/prompt-manager.md) — Customizable AI prompt templates
- [JIRA Sprint Manager](./docs/features/jira-sprint-manager.md) — Autonomous JIRA triage and implementation
- [Writers Room](./docs/features/writers-room.md) — Prose-to-media writing environment with explicit AI passes
- [OpenClaw](./docs/features/openclaw-operator-chat.md) — In-app operator-agent chat
- [Error Handling](./docs/features/error-handling.md) — Centralized error normalization and recovery

## Contributing

Pull requests are welcome. This is a personal project, so:

- **Breakage happens.** Major version bumps (e.g. v2.0.0) may rename pages, reorganize data directories, or change schemas in ways that require a migration pass on your local data. Check the relevant `.changelog/vX.Y.Z.md` for what changed.
- **Data migration.** If something stops working after an update, the fastest fix is to point your coding agent at the changelog: `"Read .changelog/vX.Y.Z.md and fix any migration issues in my PortOS data/ directory."` Most data issues are trivially auto-fixable this way.
- **Opinionated by design.** Architecture decisions (single-user, no auth, JSON files over a full ORM, Tailscale-only networking) are intentional and will not change. PRs that add multi-user support, HTTPS-by-default, or general-purpose hardening will not be merged.
- **Style.** Match the existing conventions in [CLAUDE.md](./CLAUDE.md) before opening a PR — especially the no-try/catch route convention, emoji-prefixed logging, and Zod validation on all inputs.

## License

MIT
