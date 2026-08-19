# PortOS Product Surface Map

PortOS is a local-first operating system for a developer's machines, work, and personal data. This map covers every major user-facing surface and points to the focused guide where one exists. It is an orientation guide, not an API reference; use [API.md](../API.md) for endpoints and [ARCHITECTURE.md](../ARCHITECTURE.md) for system design.

## Run and manage software

- **Dashboard, Apps, and Templates** — Register projects, inspect process health, launch or stop services, and scaffold a new app. See [App Wizard](./app-wizard.md).
- **Shell, processes, logs, and system health** — Work with terminal sessions, PM2 processes, action history, and host-level operational signals from the browser.
- **GitHub, JIRA, DataDog, and Loops** — Bring project status, issue planning, observability, and recurring work into DevTools. See [JIRA Sprint Manager](./jira-sprint-manager.md). Repository maintenance that is inherently per-repo (git branches, submodules) lives on the app's own detail page instead.
- **Browser control** — Connect a managed Chrome instance for automated or assisted browser work. See [Browser Management](./browser.md).
- **Settings, providers, local models, and usage** — Configure CLI/API/local AI providers, choose models, inspect quota and usage information, and manage local model runtimes.

## Delegate work to agents

- **Chief of Staff** — Submit work, schedule automations, monitor tasks, and review operational decisions. See [Chief of Staff](./chief-of-staff.md), [Agent Runner](./cos-agent-runner.md), [Agent Skills](./agent-skills.md), and [CoS Enhancement](./cos-enhancement.md).
- **Feature Agents, Review Hub, and workspace contexts** — Create durable agents for a feature area, collect approvals and alerts, and give agents the right repository context.
- **Prompt Manager, AI Runner, AI Runs, and AI Agents** — Configure reusable prompts; run a provider directly; and inspect active or past model work. See [Prompt Manager](./prompt-manager.md) and [Claude on Ollama](./claude-ollama.md).
- **Autofixer** — Detect and repair managed-process failures with controlled retries. See [Autofixer](./autofixer.md).

## Create stories, media, and music

- **Writers Room, Authors, and Story Builder** — Draft prose, manage works and versions, and develop a story through guided stages. See [Writers Room](./writers-room.md).
- **Universe Builder and Catalog** — Build a world bible, establish canon, and reuse its characters, places, objects, and lore throughout the Create suite.
- **Series Pipeline** — Plan a serial production, write and review issues, generate storyboards, and track editorial readiness.
- **Image, video, 3D, LoRA, and media libraries** — Generate or organize visual assets, models, collections, mood boards, timelines, and annotations. The [Sprite Export Contract](./sprite-export-contract.md) documents the game-sprite handoff; [OpenWorld](./openworld.md) covers the 3D operational world.
- **Creative Director, Creative Commissions, and Music Video** — Turn a brief or track into a treatment, plan, renders, and reviewable media project.
- **Music, SongBook, Rounds, and Ambient** — Create and organize artists, albums, tracks, musical rounds, song references, and ambient sound work.
- **Importer and Sharing** — Convert an outside manuscript into a PortOS project and exchange supported creative records through configured share buckets.

## Capture knowledge and model yourself

- **Brain, rapid reader, insights, tribe, and timeline** — Capture, classify, link, search, and review personal knowledge. See [Brain System](./brain-system.md) and [Memory System](./memory-system.md).
- **Wiki and messages** — Maintain curated evergreen pages alongside messages, drafts, and external account sync. See [Messages Security Model](./messages-security.md) for the message trust boundary.
- **Digital Twin, Character, Ask Yourself, Goals, and Privacy** — Build an identity model, examine its derived view, converse with it, organize life goals, and manage personal-data workflows. See [Digital Twin](./digital-twin.md), [Identity System](./identity-system.md), and [Soul System](./soul-system.md).
- **Calendar, Meatspace, and POST** — Coordinate events and reviews, log real-world activity, and run daily cognitive practice. See [POST](./post.md).

## Connect and operate PortOS

- **Comms, OpenClaw, iMessage, Stacker News, Telegram, and social agents** — Receive, prepare, route, and supervise conversations with people and external agents. Stacker News keeps account credentials encrypted, treats community input as untrusted, and requires review before external actions. See [Stacker News stewardship](./stacker-news.md) and [OpenClaw Operator Chat](./openclaw-operator-chat.md).
- **Voice Mode** — Use local speech-to-text, text-to-speech, and model-backed navigation or assistance. See [Voice Mode](./voice.md).
- **Instances, sharing, backups, and security** — Coordinate peer installations, synchronize selected records, protect data, and run on a private network. See [Backup & Restore](../BACKUP.md), [Storage](../STORAGE.md), [Ports](../PORTS.md), and the [security audit](../SECURITY_AUDIT.md).

## Find the right detail

- Use the [root README](../../README.md) for installation and the feature overview.
- Use [Troubleshooting](../TROUBLESHOOTING.md) when a local install, service, provider, or database is not working.
- Use [Contributing](../CONTRIBUTING.md) for development and test commands.
- Use [Operational Goals](../GOALS_OPERATIONAL.md) for the goals the Chief of Staff reads at runtime.
