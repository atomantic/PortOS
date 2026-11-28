# Repo-study mapping guide

Mapping from external repository domains to PortOS surfaces, used by repo-study tasks (`server/services/repoIntake.js`). Surface inventory: [product-surfaces.md](./product-surfaces.md).


When performing a **repo-study** task (`server/services/repoIntake.js`) or proposing new integrations, map the external repository or concept to PortOS surfaces using the following matrix:

| External Repository Domain | Target PortOS Product Surface(s) | Primary Lens & Considerations |
|---|---|---|
| **3D Scenes, WebGL, Game Engines** | **Create → 3D & Sprites** (`/3d`, `/sprites`, `/game`) or **Main → Eidoverse Worlds** (`/eidoverse`) | Visual asset pipeline, procedural geometry, Three.js shaders, low-poly rendering, and install-local PortOS world projection. |
| **Chatbots, Conversational LLMs, Assistants** | **Chief of Staff → Persistent Mind** (`/cos/mind`) or **Settings → Voice** (`/settings/voice`) or **Settings → OpenClaw** (`/openclaw`) | Context memory, MCP tool calling, speech-to-text/text-to-speech integration, barge-in support. |
| **Note-Taking, Markdown Wikis, Second Brains** | **Brain → Inbox & Notes** (`/brain/*`) or **Brain → Wiki** (`/wiki/*`) or **Brain → Rapid Reader** (`/rapid-reader`) | Knowledge graphs, AI thought classification, RSVP speed-reading, Obsidian sync. |
| **Writing Tools, Fiction Generators, Storyboarding** | **Create → Writers Room** (`/writers-room`), **Story Builder** (`/story-builder`), or **FableLoom** (`/fableloom`) | Prose editing, chapter versioning, interactive branching graphs, character consistency. |
| **Comic & Series Pipelines, Script Analysis** | **Create → Series Pipeline** (`/pipeline`) or **Importer** (`/importer`) | Editorial linting, continuity bibles, voice fingerprinting, ePub/PDF compilation. |
| **Music Synthesis, Audio Generation, Tablature** | **Create → Music** (`/music/*`), **Rounds** (`/rounds`), or **SongBook** (`/songbook`) | Model renderers (Ace-Step, AudioLDM), chord charts, vocal round harmony, lyrics conditioning. |
| **Diffusion Models, Video Samplers, LoRAs** | **Create → Media Gen** (`/media/*`), **Creative Director** (`/creative-director`), or **Models** (`/models/*`) | Speed profiles, prompt conditioners, LoRA adapter inference, multi-track timeline editing. |
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
