# PortOS Product Surface Map

PortOS is a local-first operating system for a developer's machines, work, and personal data. It unifies managed application lifecycles, autonomous agent delegation, a multi-modal creative production suite, personal knowledge and identity modeling, daily cognitive training, and federated peer operations into a single private-network platform.

This document is the **canonical user-facing feature inventory** for PortOS. It serves three primary functions:
1. **User & Contributor Orientation**: A comprehensive map of every major surface, route, and capability in PortOS.
2. **Autonomous Repo-Study Reference**: The canonical baseline consumed by the `repo-study` task (`server/services/repoIntake.js`) when studying external repositories (github.com / gitlab.com) to map new capabilities, enhancements, and UX patterns onto PortOS.
3. **Architecture & Guide Index**: Quick pointers to dedicated feature deep dives in `docs/features/` and root architectural guides in `docs/`.

---

## Operating Philosophy & Architecture Principles

- **Local-First & Private Network**: Every install runs locally behind a private network (Tailscale VPN) without public internet exposure. Mutual trust is scoped to authenticated tailnet peers.
- **PostgreSQL as Primary Datastore**: Mandatory local PostgreSQL with `pgvector` for relational records, creative catalogs, and semantic embeddings.
- **No Cold-Bootstrap LLM Calls**: PortOS never triggers unannounced AI provider calls on server boot or startup backfills. AI invocations require explicit user action, configured recurring schedules, or active CoS tasks.
- **Deterministic & Local Model Acceleration**: Heavy emphasis on local model execution (Ollama, LM Studio, vLLM, SGLang, llama.cpp) accelerated via speculative decoding (DSpark, DFlash 2, MTPLX) and local GPU/NPU utilization.
- **Strict Privacy Boundaries**: Sensitive identity records (PII Vault, Organizations, Data Brokers) remain strictly machine-local and never cross the federation layer or enter general LLM context prompts by default. Under an explicit double opt-in (`includePrivacyContext: true` plus fields flagged `share_with_twin`), permitted vault facts and organization/broker summaries are injected into the digital twin context for authorized Chief of Staff prompts.

---

## 1. Run and Manage Software (App Management & Dev Tools)

Manage local applications, terminal environments, system resources, and developer integrations.

| Surface / Page | Route(s) | Key Capabilities & Workflows | Related Guides |
|---|---|---|---|
| **Dashboard** | `/` | System overview, active agent count, PM2 process vitals, Quick Capture widget, fast jump to recent projects. | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| **Apps Manager** | `/apps`, `/apps/:id` | Managed app registry: launch, stop, restart processes, live process logs, environment variables, Git branch switcher, and per-app feature tabs. | [PM2.md](../PM2.md) |
| **App Templates & Scaffolding** | `/templates` | Pre-configured starter stacks (React, Vite, Node, Python) and interactive project scaffolding. | [App Wizard](./app-wizard.md) |
| **PortOS Submodules** | `/apps/portos-default/submodules`, `/devtools/submodules` | Git submodule management for PortOS and managed repositories, submodule update checks, and recursive synchronization. | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| **Web Shell** | `/shell` | Browser-based interactive terminal multiplexer for host command execution and active debugging. | — |
| **Process Manager** | `/devtools/processes` | Real-time PM2 process table, status inspection, memory/CPU usage, and manual process restarts. | [PM2.md](../PM2.md) |
| **System Resources & Health** | `/system-resources/overview`, `/system-resources` | Host-level operational signals, CPU/RAM utilization, disk thresholds, top processes, and running build/commit hash validation. | [METRICS.md](../METRICS.md) |
| **Storage Report & Disk Cleanup** | `/system-resources/storage` | Comprehensive disk usage breakdown, cache directory inspection, AI-assisted cleanup triage, and temporary artifact removal. | [STORAGE.md](../STORAGE.md) |
| **Active Queues** | `/system-resources/queues` | Live inspection of background job queues (media renders, agent tasks, batch jobs), queue prioritization, and cancellation. | — |
| **Uploads Staging** | `/uploads` | File upload manager and staging directory for media, documents, and datasets. | — |
| **Activity & Action History** | `/devtools/history` | Historical audit log of user actions, system mutations, and automated tasks. | — |
| **Code & Script Runner** | `/devtools/runner` | Ad-hoc code execution environment and script runner for quick operational utilities. | — |
| **GitHub Integration** | `/devtools/github` | Pull request tracking, open issue triage, commit log browsing, branch switching, and upstream synchronization. | [GITHUB_ACTIONS.md](../GITHUB_ACTIONS.md) |
| **JIRA Sprint Manager & Reports** | `/devtools/jira`, `/devtools/jira/reports` | JIRA sprint planning, active board triage, backlog management, velocity metrics, and sprint burndown reports. | [JIRA Sprint Manager](./jira-sprint-manager.md) |
| **DataDog Monitoring** | `/devtools/datadog` | APM dashboard, service error tracking, latency metrics, and synthetic monitoring. | — |
| **GSD Project Planning** | `/cos/gsd`, app tab | "Get Stuff Done" hierarchical milestone tracking, project breakdown, and execution roadmaps. | — |
| **Integration Flows** | `/devtools/flows` | Interactive visual architecture diagrams showing live data flows between PortOS subsystems and external services. | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| **Browser Control** | `/browser` | Persistent managed Chrome instance over Chrome DevTools Protocol (CDP) for automated web extraction, UI testing, and assisted browsing. | [Browser Management](./browser.md) |
| **Image Cleaner** | `/devtools/image-clean` | Strips metadata, C2PA, and Content Credentials from images; Sharp-based image optimization and denoising. | — |
| **Video Downloader** | `/devtools/video-download` | Video and audio capture from YouTube, X.com, and web links via `yt-dlp`. | — |
| **Quota Burn Automation** | `/devtools/quota-burn` | Autonomous batch worker designed to consume subscription-backed AI CLI quotas (Claude Code, Codex, Grok, Antigravity) before reset windows expire. | [QUOTA-BURN.md](../QUOTA-BURN.md) |
| **Workspace Contexts** | `/workspace-contexts` | Fast workspace switcher restoring working Git branches, active shell sessions, task queues, and editor state. | — |
| **API Explorer & Swagger** | `/api-reference/catalog` | Interactive OpenAPI documentation, route explorer, and Agent Tools MCP semantic tool catalog. | [API.md](../API.md), [API Tool Contract](../API_TOOL_CONTRACT.md) |
| **Autofixer & Self-Healing** | `/settings/autofixer` | Background watchdog detecting PM2 process crash loops and executing self-healing diagnostic repair loops. | [Autofixer](./autofixer.md), [Error Handling](./error-handling.md) |

---

## 2. Delegate Work to Agents (Chief of Staff & AI Delegation)

Submit tasks, manage durable autonomous agents, schedule recurring automations, and govern AI capabilities.

| Surface / Page | Route(s) | Key Capabilities & Workflows | Related Guides |
|---|---|---|---|
| **Chief of Staff Tasks** | `/cos/tasks` | Task dispatch queue, priority scheduling (HIGH, MEDIUM, LOW), auto-execution vs user approval gates, task context preparation, and learning ETAs. | [Chief of Staff](./chief-of-staff.md), [CoS Enhancement](./cos-enhancement.md) |
| **Agent Runs & Feedback** | `/cos/agents` | Live streaming agent output, token counts, transcript inspection, and durable rating/feedback collection for continuous learning. | [Agent Runner](./cos-agent-runner.md) |
| **Schedule Timeline & Workflows** | `/cos/workflow`, `/cos/schedule` | Visual Gantt-style schedule editor showing launch order, task dependencies, concurrency limits, and cron schedules. | [Chief of Staff](./chief-of-staff.md) |
| **Operational Briefings & Digest** | `/cos/briefing`, `/cos/digest` | Morning briefings of operational signals, system alerts, pending approvals, and end-of-day accomplishment rollups. | [GOALS_OPERATIONAL.md](../GOALS_OPERATIONAL.md) |
| **CoS Health & Diagnostics** | `/cos/health`, `/cos/jobs` | Agent runner daemon health, PM2 worker telemetry, background maintenance jobs, and queue diagnostics. | [Agent Runner](./cos-agent-runner.md) |
| **Learning & Productivity** | `/cos/learning`, `/cos/productivity` | Task duration models, success rate metrics, category learning curves, and operational work patterns. | — |
| **Persistent Mind** | `/cos/mind` | Resident long-term conversational AI agent with persistent context memory, annotation support, and continuous system oversight. | [Agent Tools (MCP)](./agent-context.md), [Memory System](./memory-system.md) |
| **Mind Tools Governance** | `/cos/mind?panel=tools` | Fine-grained tool permission controls, MCP context disclosure settings (metadata-only vs redacted summaries), and semantic action grants. | [Agent Tools (MCP)](./agent-context.md), [Agent Skills](./agent-skills.md) |
| **Feature Agents** | `/feature-agents` | Durable, specialized agents assigned to specific feature domains or managed codebases. | — |
| **Review Hub** | `/review` | Centralized triage inbox for agent-generated diffs, pull request reviews, approval requests, and code quality findings. | — |
| **Social Agents** | `/agents` | Autonomous agent personas for managing external social communications and community presence. | — |
| **AI Providers & Model Runner** | `/ai` | Multi-provider configuration supporting CLI agents (Claude Code, Codex, Antigravity, OpenCode), cloud APIs (OpenAI, Anthropic, Gemini, Grok), and local endpoints (Ollama, LM Studio, vLLM, SGLang). | [Claude on Ollama](./claude-ollama.md) |
| **Prompt Manager** | `/prompts` | Reusable prompt template library, variable substitution engine, prompt versioning, and auto-upgrade migrations. | [Prompt Manager](./prompt-manager.md) |
| **Runs & Run Events Ledger** | `/cos/runs`, `/cos/run-events` | Comprehensive ledger of past and in-flight AI runs, lifecycle event replay, and orphaned process recovery. | — |
| **Code Reviewers** | `/settings/code-reviewers` | Configurable multi-reviewer chain (Codex, Claude, Copilot, Ollama) with stop conditions, max rounds, and dispute workflows. | — |

---

## 3. Create Stories, Media, Music, and Games (Create Suite)

An end-to-end creative production suite for authors, worldbuilders, filmmakers, musicians, and game developers.

| Surface / Page | Route(s) | Key Capabilities & Workflows | Related Guides |
|---|---|---|---|
| **Start a Story** | `/start-story` | Creative onboarding on-ramp: choose between guided story building, Writers Room prose, FableLoom branching narrative, or manuscript import. | — |
| **Story Builder** | `/story-builder` | Step-by-step guided story wizard: concept ideation, universe attachment, character arc design, reader emotional mapping, and episode outlines. | — |
| **Writers Room** | `/writers-room` | Focused Markdown prose studio: version history, structural analysis, emotional roadmaps, and timed sprint exercises ("write for 10"). | [Writers Room](./writers-room.md) |
| **Writers Room Guide** | `/writers-room/guide` | Craft reference guide: word count standards (flash fiction to epic novel), length targets, and narrative pacing rules. | [Writers Room](./writers-room.md) |
| **Authors Management** | `/authors` | Author personas, bylines, pen names, distinct literary writing styles, and cover metadata. | — |
| **FableLoom** | `/fableloom` | Interactive branching fiction engine: visual story graph editor, choice tree logic, intent routing, and node-based reader. | [FableLoom](./fableloom.md) |
| **Manuscript Importer** | `/importer` | Ingests external manuscripts, screenplays, novels, and comic scripts to extract characters, locations, lore, and structural scenes. | — |
| **Series Pipeline** | `/pipeline` | Multi-issue/episode production tracking, comic script staging, storyboard generation, and visual prompt conditioning. | — |
| **Editorial Checks** | `/pipeline/editorial-checks` | Deterministic and LLM-assisted linting for exposition dumps, character naming collisions, pacing flaws, and continuity drift. | — |
| **Series Continuity Bible** | `/pipeline` | Canon facts ledger, timeline verification, prop and wardrobe tracking, and character knowledge-leak prevention. | — |
| **Voice Fingerprint** | `/pipeline` | Prose style analytics: sentence rhythm, syntactic complexity, register consistency, and vocabulary outlier detection across chapters. | — |
| **Prose Series Export** | `/pipeline` | Compile engine outputting formatted ePub, trade paperback interior PDF (custom trim sizes, front matter, TOC), and print-ready bundles. | — |
| **Universes & Canon** | `/universes`, `/universes/:id` | Worldbuilding bibles: sci-fi/fantasy lore, style templates, canon entries, characters, settings, and visual consistency anchors. | — |
| **Creative Catalog** | `/catalog`, `/catalog?settings=1` | Searchable relational entity database (characters, places, objects, lore, scenes) with vector search and taxonomy management. | [STORAGE.md](../STORAGE.md) |
| **Catalog Ingest** | `/catalog/ingest` | Paste unstructured scraps, scenes, or notes to automatically extract structured catalog ingredients. | — |
| **Mood Boards** | `/mood-boards` | Visual pinboards, style canvases, color palettes, and conceptual reference collections. | — |
| **Media Gen (Image & Video)** | `/media`, `/media/image`, `/media/video` | Local and federated text-to-image (Stable Diffusion, FLUX, MFLUX) and text-to-video (LTX-Video, MiniMax H3) generation. | [Video Speed Profiles](./video-speed-profiles.md), [Video Text Encoders](./video-text-encoders.md) |
| **Media History & Timeline** | `/media/history`, `/media/timeline` | Asset gallery, multi-track video timeline editor, clip trimming, audio overlay, and video stitching. | — |
| **Image Annotation** | `/media/annotate` | Canvas drawing, sketch-over, visual markup, and region labeling for image conditioning. | — |
| **Media Collections** | `/media/collections` | Visual asset organization, project stacks, and media albums. | — |
| **3D Meshes & Three.js** | `/3d`, `/media/threejs` | Neural image-to-3D mesh generation (TRELLIS, Pixal3D) and procedural Three.js 3D model generation with interactive WebGL preview. | [Three.js Models](../THREEJS_MODELS.md) |
| **Game Studio & Sprites** | `/game`, `/sprites` | 2D game asset creation: 8-directional sprite sheets, animation tracks (walk cycles, idle, actions), atlas compilation, and game asset bundles. | [Sprite Export Contract](./sprite-export-contract.md) |
| **Music Studio & Designer** | `/music`, `/music/generate` | Local and federated AI music synthesis (Ace-Step, AudioLDM, MusicGen), prompt enrichment, lyric generation, and reference-track style matching. | [Music Renderer Benchmarks](./music-renderer-benchmarks.md), [Federated Media Providers](../FEDERATED_MEDIA_PROVIDERS.md) |
| **Music Catalog** | `/music/artists`, `/music/albums`, `/music/tracks` | Virtual artist personas, discographies, album cover art, tracklists, and audio streaming player. | — |
| **Rounds & Rounds Guide** | `/rounds`, `/rounds/guide` | Composition and learning tool for a cappella musical rounds, multi-part vocal harmonies, lead sheets, and solfège notation. | — |
| **SongBook** | `/songbook` | Interactive chord charts, guitar tablature, lyric repertoire, and auto-scrolling practice sheet music. | — |
| **Creative Director** | `/creative-director` | Multi-scene episodic video production orchestrator: turn briefs into treatments, storyboards, render plans, and completed episodes. | — |
| **Creative Commissions** | `/creative-commission` | Standing briefs and scheduled/nightly autonomous media generation aligning with personal taste profiles and feedback. | — |
| **Music Video Studio** | `/music-video` | Audio-reactive video creation, beat-detection synchronization, scene choreography, and tempo alignment. | — |
| **Sharing & Conflict Resolution** | `/sharing`, `/sharing/duplicates`, `/sharing/conflicts` | Collaborative asset exchange via cloud storage buckets (Google Drive, Dropbox, iCloud, Syncthing) with duplicate reconciliation and conflict recovery journals. | — |

---

## 4. Personal Knowledge, Life Modeling, Identity, & Health

Capture thoughts, build personal memory graphs, model your identity and taste, protect private data, and monitor physical vitality.

| Surface / Page | Route(s) | Key Capabilities & Workflows | Related Guides |
|---|---|---|---|
| **Brain Inbox & Notes** | `/brain/inbox`, `/brain/notes` | Universal thought capture, AI classification (People, Projects, Ideas, Admin), confidence scoring, note editor, and GTD reviews. | [Brain System](./brain-system.md) |
| **Brain Links & Repo Ingest** | `/brain/links` | Link vault with automated malware scanning, web clipping, and repo study triggers. | [Brain System](./brain-system.md) |
| **YouTube Transcripts & Ingest** | `/brain/config`, `/brain/youtube` | Captures YouTube video transcripts (collapsing auto-caption repetition), downloads audio/video, mirrors markdown to Obsidian, and syncs watch history. | [Brain System](./brain-system.md) |
| **Feeds & RSS** | `/brain/feeds` | RSS/Atom feed reader, article capture, and knowledge extraction. | — |
| **Knowledge Graph** | `/brain/graph`, `/wiki/graph` | Interactive visual graph of entities, tags, and cross-document semantic links. | — |
| **Daily Log & Digest** | `/brain/daily-log`, `/brain/digest` | Daily markdown journaling, automated daily summaries, and weekly GTD-style reviews. | [Brain System](./brain-system.md) |
| **Rapid Reader** | `/rapid-reader` | RSVP (Rapid Serial Visual Presentation) speed-reading engine with adjustable WPM and focal point markers. | — |
| **Trust & Verification** | `/brain/trust` | Audit trail of AI classification decisions and source credibility records. | [Brain System](./brain-system.md) |
| **Third-Party Import** | `/brain/import` | Ingests ChatGPT and OpenAI export archives into structured Brain memory. | — |
| **Activity Timeline** | `/timeline` | Unified chronological human activity ledger aggregating events from iMessage, Signal, WhatsApp, Spotify, Discord, YouTube, and Calendar. | — |
| **Tribe Relationship Manager** | `/tribe` | Dunbar-number social network management, relationship health scores, care cadence reminders, and contact resolution. | — |
| **Multi-Scale Calendar** | `/calendar/*` | Time management across Agenda, Day, Week, Month, and Lifetime perspectives, periodic reflection reviews, and external sync (iCal/CalDAV/Google). | — |
| **Digital Twin Profile & Identity** | `/digital-twin/overview`, `/digital-twin/identity`, `/digital-twin/autobiography`, `/digital-twin/personas`, `/digital-twin/taste`, `/digital-twin/goals` | Core identity attributes, autobiography, dynamic personas (professional, casual, creative), quantified aesthetic taste, and personal goals. | [Digital Twin](./digital-twin.md), [Identity System](./identity-system.md) |
| **Twin Presence & Avatars** | `/digital-twin/appearance`, `/digital-twin/avatar-bio`, `/digital-twin/voice` | Visual appearance reference photos, live avatar bios (HeyGen, Tavus, Simli, ElevenLabs), and comparative spoken-vs-written voice fingerprinting. | [Digital Twin](./digital-twin.md) |
| **Personality & Assessment** | `/digital-twin/personality`, `/digital-twin/test` | Big Five (OCEAN) quantitative trait scoring, values hierarchy, model sycophancy comparison radar, and automated behavioral test suites. | [Digital Twin](./digital-twin.md), [Soul System](./soul-system.md) |
| **Knowledge Sources & Interviews** | `/digital-twin/documents`, `/digital-twin/interview`, `/digital-twin/enrich`, `/digital-twin/import`, `/digital-twin/accounts` | Soul document manager (`SOUL.md`, `VALUES.md`), interactive AI-driven life interviews, enrichment questionnaires, and external data imports (Goodreads, Spotify, Letterboxd, iCal). | [Soul System](./soul-system.md) |
| **Ask Yourself & Character Chat** | `/ask`, `/character` | Conversational reflection interface allowing you to chat directly with your modeled digital twin or authored characters. | [Digital Twin](./digital-twin.md) |
| **Legacy Bundle & Time Capsule** | `/digital-twin/legacy`, `/digital-twin/time-capsule`, `/digital-twin/export` | Portable, self-contained legacy archive bundle, time capsule snapshots, and PDF summaries. | [Digital Twin](./digital-twin.md) |
| **Privacy Center Overview** | `/privacy/overview` | PII exposure summary, personal data inventory, and strict machine-local isolation gates. | [Privacy Center](./privacy-center.md), [Privacy ADR](../decisions/2026-08-08-privacy-records-machine-local.md) |
| **PII Encrypted Vault** | `/privacy/vault` | Encrypted-at-rest vault for sensitive identity numbers (passports, SSNs, financial IDs, private addresses). | [Privacy Center](./privacy-center.md) |
| **Organizations Registry** | `/privacy/organizations` | Catalog of third-party institutions holding personal data, tracking data retention policies and account numbers. | [Privacy Center](./privacy-center.md) |
| **Changes Workflow** | `/privacy/changes` | Change-of-address and contact update tracking matrix across all registered organizations. | [Privacy Center](./privacy-center.md) |
| **Data Brokers Registry** | `/privacy/brokers` | Removal tracking and opt-out status for people-search sites and data aggregators (CCPA/GDPR). | [Privacy Center](./privacy-center.md) |
| **Cross-Domain Insights & Goals** | `/insights/*`, `/goals/list`, `/goals/tree` | Correlation engine linking genetics, chronotype, lifestyle, aesthetic taste, and hierarchical goal trees with alignment scorecards. | [Identity System](./identity-system.md) |
| **Health & Biomarkers (MeatSpace)** | `/meatspace/*` | Personal vitals, blood biomarker panels, lifestyle tracking, biological age computation, substance logging (alcohol, nicotine), and 23andMe genomic marker analysis (117 curated SNPs across 32 categories). | [POST](./post.md) |
| **Clinician Health Export** | `/meatspace/export` | Generation of doctor-ready clinical PDF health summaries. | — |
| **MortalLoom Sync** | `/settings/mortalloom` | Longevity modeling and iCloud HealthKit synchronization. | — |

---

## 5. Cognitive Training (POST — Power On Self Test)

A daily cognitive training and self-test system designed to build and measure cognitive endurance, verbal fluency, and executive control.

| Surface / Drill Domain | Route(s) | Key Capabilities & Workflows | Related Guides |
|---|---|---|---|
| **POST Launcher & Library** | `/post/launcher`, `/post/explore`, `/post/plan` | 5-minute daily training sessions, custom study curriculum, and exploratory drill catalog. | [POST System](./post.md) |
| **Mental Math** | `/post/launcher` | Timed mental arithmetic: doubling chains, serial subtraction, multiplication, powers, and numerical estimation. | [POST System](./post.md) |
| **Memory Builder & "The Elements"** | `/post/memory`, `/post/memory/elements/*` | Progressive recall training for structured texts and poetry; dedicated module for Tom Lehrer's "The Elements" (flash cards, lyric recall, and learn modes). | [POST System](./post.md) |
| **Morse Code (CW) Trainer** | `/post/morse/*` | Koch method audio decoding, audio-only head copy, straight-key keyboard transmission, and visual reference charts (binary tree, symbol length, alphabet table). | [POST System](./post.md) |
| **Rhetoric & Prose Meter** | `/post/rhetoric/*` | Iambic pentameter rhythm calibration, rhetorical figure generation (diacope, chiasmus, progressia), and divergent angle brainstorming. | [POST System](./post.md) |
| **Wordplay & Verbal Agility** | `/post/wordplay/*` | Compound word chains, linking bridge words, pun & double-meaning generation, and idiom domain-twisting. | [POST System](./post.md) |
| **Cognitive & Executive Control** | `/post/launcher` | Deterministically scored drills: N-back, digit span, Stroop effect, Schulte tables, mental rotation, reaction time, Task Switching, Go/No-Go inhibition, and Flanker control. | [POST System](./post.md) |
| **Progress & Session History** | `/post/progress`, `/post/progress/sessions` | Accuracy trends, response speed analytics, streak tracking, and session attempt logs. | [POST System](./post.md) |

---

## 6. Communications, Voice, Social, & Spatial UI

Unified communication channels, local voice assistant, community stewardship, and 3D spatial navigation.

| Surface / Page | Route(s) | Key Capabilities & Workflows | Related Guides |
|---|---|---|---|
| **Comms Inbox & Drafts** | `/messages/inbox`, `/messages/drafts`, `/messages/sync` | Centralized message triage, drafting assistant, and cross-channel message synchronization. | [Messages Security](./messages-security.md) |
| **iMessage Sync & Contacts** | `/messages/imessage`, `/messages/contacts` | Local macOS `chat.db` SQLite ingestion, sender identity resolution, spam filtering, and address book contact merging. | [Messages Security](./messages-security.md) |
| **Signal Integration** | `/settings/signal` | Encrypted local sync from Signal Desktop SQLCipher database. | [Messages Security](./messages-security.md) |
| **Telegram & X (Twitter)** | `/settings/telegram`, `/x` | Social channel monitoring, outreach staging, engagement diagnostics, and shadowban checks. | — |
| **Stacker News Stewardship** | `/stacker-news` | Community territory moderation, Bitcoin Lightning tipping, post review, and encrypted credential storage. | [Stacker News](./stacker-news.md) |
| **OpenClaw Operator Chat** | `/openclaw` | Real-time interactive operator agent runtime with streaming sessions and persistent execution. | [OpenClaw Operator Chat](./openclaw-operator-chat.md) |
| **Evergreen Personal Wiki** | `/wiki/*` | Curated personal knowledge base with markdown editing, link graphs, and full-text search. | — |
| **Voice Mode** | `/settings/voice` | Hands-free voice assistant with continuous VAD (AudioWorklet), speech-to-text (Whisper local or Web Speech), local LLM orchestration, text-to-speech (Kokoro-82M in-process or Piper), barge-in support, and `ui_navigate` tool execution. | [Voice Mode](./voice.md) |
| **Ambient Display Mode** | `/ambient` | Fullscreen idle dashboard, ambient animations, system status ticker, and display screensaver. | — |
| **Eidoverse Worlds** | `/eidoverse` | Private, install-local 3D world for the human and Persistent Mind/CoS agents, with durable name-based identity, world history, deterministic PortOS resource projection, and governed world augmentation. | [Eidoverse Worlds](./eidoverse.md) |
| **OpenWorld (retired compatibility surface)** | `/openworld`, `/city` | Historical Three.js / React Three Fiber world; legacy routes redirect to Eidoverse so existing bookmarks remain usable. | [OpenWorld](./openworld.md) |

---

## 7. System Infrastructure, Local Models, & Federation

Local AI model acceleration, multi-machine peer federation, storage classification, backup, and security.

| Surface / Area | Route(s) | Key Capabilities & Workflows | Related Guides |
|---|---|---|---|
| **Local LLM Runtimes** | `/models/llms` | Management of local model servers: Ollama, LM Studio, vLLM, SGLang, and llama.cpp / llama-server. | [Claude on Ollama](./claude-ollama.md) |
| **Speculative Decoding** | `/models/llms` | Accelerated token generation using DSpark, DFlash 2, and MTPLX speculative drafting pairs. | [DFlash2 & DSpark](./dflash2.md), [MTPLX](./mtplx.md), [RTX 3090 vLLM](./qwen38-rtx3090.md), [SGLang Qwen](./sglang-qwen38.md) |
| **Embeddings Management** | `/models/embeddings` | Local text embedding models (Nomic, Ollama) and pgvector semantic index configuration. | [STORAGE.md](../STORAGE.md) |
| **LoRAs & Model Training** | `/models/loras`, `/models/training` | LoRA adapter discovery, Civitai downloads, image captioning, and local FLUX LoRA training dataset management. | — |
| **Media Models Storage** | `/models/media` | Hugging Face cache management and storage inspection for image/video diffusion models. | — |
| **Model Status & VRAM** | `/models/status` | Live resident VRAM/RAM inspection, model unloading, and memory optimization. | — |
| **Performance Benchmarks** | `/models/performance` | Automated throughput measurement (tokens/sec, chars/sec, TTFT) across models and engines. | — |
| **LLM Playground** | `/local-llm/playground` | Side-by-side prompt testing, latency benchmarking, and model evaluation. | — |
| **3D Neural Runtimes** | `/models/3d` | TRELLIS and Pixal3D image-to-3D on-device installation and diagnostics. | [Three.js Models](../THREEJS_MODELS.md) |
| **Instances & Peer Federation** | `/instances`, `/settings/sharing` | Multi-install peer federation across Tailscale VPN, capability discovery, and federated media generation offloading. | [FEDERATED_MEDIA_PROVIDERS.md](../FEDERATED_MEDIA_PROVIDERS.md) |
| **PostgreSQL Datastore** | `/settings/database` | Mandatory local PostgreSQL datastore with pgvector extension, migrations, and storage classification contract. | [STORAGE.md](../STORAGE.md), [Postgres ADR](../decisions/2026-06-07-postgres-as-primary-datastore.md) |
| **Backup & Restore** | `/settings/backup` | Automated filesystem rsync snapshots and database dumps with point-in-time restore. | [BACKUP.md](../BACKUP.md) |
| **Security & Trust Model** | `/settings/security`, `/security` | Opt-in instance password authentication, TLS certificates (`setup:cert`), Tailscale trust boundary, port allocation, and audit logs. | [SETUP.md](../SETUP.md), [PORTS.md](../PORTS.md), [REMOTE_DESKTOP.md](../REMOTE_DESKTOP.md) |

---

## 8. Repo-Study Mapping Guide (for Agents & Contributors)

When performing a **repo-study** task (`server/services/repoIntake.js`) or proposing new integrations, map the external repository or concept to PortOS surfaces using the following matrix:

| External Repository Domain | Target PortOS Product Surface(s) | Primary Lens & Considerations |
|---|---|---|
| **3D Scenes, WebGL, Game Engines** | **Create → 3D & Sprites** (`/3d`, `/sprites`, `/game`) or **Main → Eidoverse Worlds** (`/eidoverse`) | Visual asset pipeline, procedural geometry, Three.js shaders, low-poly rendering, and install-local PortOS world projection. |
| **Chatbots, Conversational LLMs, Assistants** | **Chief of Staff → Persistent Mind** (`/cos/mind`) or **Settings → Voice** (`/settings/voice`) or **Settings → OpenClaw** (`/openclaw`) | Context memory, MCP tool calling, speech-to-text/text-to-speech integration, barge-in support. |
| **Note-Taking, Markdown Wikis, Second Brains** | **Brain → Inbox & Notes** (`/brain/*`) or **Brain → Wiki** (`/wiki/*`) or **Brain → Rapid Reader** (`/rapid-reader`) | Knowledge graphs, AI thought classification, RSVP speed-reading, Obsidian sync. |
| **Writing Tools, Fiction Generators, Storyboarding** | **Create → Writers Room** (`/writers-room`), **Story Builder** (`/story-builder`), or **FableLoom** (`/fableloom`) | Prose editing, chapter versioning, interactive branching graphs, character consistency. |
| **Comic & Series Pipelines, Script Analysis** | **Create → Series Pipeline** (`/pipeline`) or **Importer** (`/importer`) | Editorial linting, continuity bibles, voice fingerprinting, ePub/PDF compilation. |
| **Music Synthesis, Audio Generation, Tablature** | **Create → Music** (`/music/*`), **Rounds** (`/rounds`), or **SongBook** (`/songbook`) | Model renderers (Ace-Step, AudioLDM), chord charts, vocal round harmony, lyrics conditioning. |
| **Diffusion Models, Video Samplers, LoRAs** | **Create → Media Gen** (`/media/*`), **Creative Director** (`/creative-director`), or **Models** (`/models/*`) | Speed profiles, prompt conditioners, LoRA training datasets, multi-track timeline editing. |
| **Quantified Self, Health, Biometrics, Habits** | **Health → MeatSpace** (`/meatspace/*`) or **Identity → Insights** (`/insights/*`) | Biomarker tracking, 23andMe genomic analysis, chronotypes, doctor-ready PDF exports. |
| **Cognitive Drills, Flashcards, Brain Training** | **POST → Cognitive Training** (`/post/*`) | Spaced repetition, mental math, Morse code audio/keying, rhetorical exercises, executive control tests. |
| **Task Queues, Autonomous Workflows, CRON** | **Chief of Staff → Tasks & Schedule** (`/cos/*`) | Priority dispatch, approval gates, Gantt schedule timeline, learning ETAs. |
| **Terminal Multiplexers, Process Managers** | **Dev Tools → Shell & Processes** (`/shell`, `/devtools/processes`) | Web shell UX, PM2 telemetry, log streaming, autofixer repair loops. |
| **PII Protection, Password Managers, Opt-Outs** | **Identity → Privacy Center** (`/privacy/*`) | Encrypted-at-rest Vault, organization registry, data broker removal tracking. |
| **Social Media Tools, Community Platforms** | **Comms → Stacker News** (`/stacker-news`), **Messages** (`/messages/*`), or **X** (`/x`) | Community moderation, Lightning tipping, local SQLite message sync (iMessage, Signal). |
| **Remote Companion Apps, Mobile UIs** | **Infrastructure & Companion API** (`docs/COMPANION_APP_API.md`, `docs/REMOTE_DESKTOP.md`) | PortDeck iOS companion API, VNC remote desktop broker, Bonjour discovery. |

### Repo-Study Evaluation Principles:
1. **Identify the Core Surface**: Ground every recommendation in PortOS's actual code and surfaces before filing.
2. **Clean-Room Reimplementation**: Never copy code, prose, or assets from third-party repositories. Propose clean-room designs that integrate with PortOS's existing architecture.
3. **Respect Operational Constraints**: PortOS is a single-user, private-network application. Do not propose multi-tenant SaaS features, rate limiting, or cold-bootstrap LLM calls.
