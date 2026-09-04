# PRD.md — PortOS

Your self-hosted operating system for dev machines — a personal "everything app" for one developer.

---

## Overview

PortOS turns a local development machine into a personal operating system: a single dashboard for managing active git repos and PM2 processes, orchestrating autonomous AI agents, capturing and retrieving personal knowledge, modeling a persistent digital identity, running an end-to-end creative production studio, tracking health and longevity, and handling calendar/email/messaging — all self-hosted, all data local, reachable from any device over a private Tailscale network. It solves the fragmentation of modern life: knowledge capture, identity modeling, creative production, health tracking, AI orchestration, and communication are normally scattered across dozens of disconnected tools. Any number of PortOS installs owned by the same person can federate as a peer mesh over Tailscale — syncing knowledge and creative records, and exposing spare local-inference capacity to one another for content-generation delegation — with the Tailnet itself, not a public account system, as the trust boundary. PortOS is explicitly **not** general-purpose software — it is built for one specific user and one specific use case, on the philosophy that flat-rate AI subscriptions (Claude Max, Codex, etc.) rather than metered API billing make always-on autonomous agents economically sane. It is MIT-licensed and open to external PRs, but the project prioritizes the author's own workflow over general adoption, and may ship breaking changes without warning.

---

## Goals & Objectives

Reused verbatim (condensed to objective statements) from [GOALS.md](./GOALS.md)'s Core Goals — this PRD does not re-derive them:

1. **Centralized App Lifecycle Management** — one dashboard replaces juggling terminals/browser tabs across every active project.
2. **Autonomous AI Agent Orchestration (CoS)** — tasks are generated from goals, routed to the best-performing AI provider, and executed without human intervention, learning from outcomes over time.
3. **Personal Knowledge Management** — Brain + Memory function as a persistent, auto-classified, semantically searchable second brain.
4. **Digital Identity Modeling** — a machine-readable digital twin briefs AI agents on tone, style, and preference so they act authentically on the user's behalf.
5. **Creative Production Suite** — an end-to-end studio (writing, worldbuilding, series production, image/video generation, editing) makes creating easier than consuming.
6. **Developer Productivity Toolkit** — shell, git, browser control, and process tooling available from any device.
7. **Self-Improving Intelligence** — the system tunes its own routing/metrics from observed outcomes rather than staying static.
8. **Full Digital Autonomy** — agents can act across connected platforms (voice, Telegram, messaging, social) around the clock.
9. **Knowledge Legacy** — personal knowledge, identity, and creative output are preserved as a durable, local record. PortOS itself is the backup of record (data lives on the user's hardware and is covered by automatic snapshots — see `docs/BACKUP.md`), so per-domain backup-style exports are out of scope; download/export buttons exist only for sharing or handoff to other tools (Sharing buckets, Legacy Bundle, format-specific creative deliverables).
10. **Anywhere Access on Private Network** — every feature is reachable from any device on the user's Tailnet, with no public exposure.
11. **Health & Longevity** — health data (MeatSpace) is tracked and made actionable via mortality/longevity-aware goal scoring.
12. **Personal Productivity & Life Management** — calendar, goals, and communications are unified with the same tooling that manages digital projects.
13. **Cognitive Training & Lifelong Learning** — POST and Wiki actively strengthen how the user learns, not just record what they learned.

---

## Target Users / Personas

### The Owner-Operator (primary and only persona)
- **Needs:** a single control surface for every active project, a knowledge system that doesn't lose thoughts, an AI orchestration layer that gets smarter instead of requiring re-prompting from scratch, and a private place to model identity, health, and creative work.
- **Context:** runs PortOS across any number of their own machines — including local-inference boxes — federated as peers and reachable from phone/tablet/laptop over Tailscale. Directs AI coding agents "Rick Rubin style" (produces/curates rather than hand-writes most code) and expects the system to keep working correctly across their own forks and upgrades over time.

### Federated Peer Instance (secondary, non-human "user")
- **Needs:** version-gated sync payloads it can safely apply without corrupting its own state, capacity-aware admission when asked to perform generation work on another peer's behalf, and a trust boundary (Tailscale) it can rely on instead of implementing its own authn/authz.
- **Context:** any number of other PortOS installs owned by the same person — not a fixed pair — registered in the local peer registry, exchanging Brain/Memory/Sharing records and instance metadata, and, where explicitly enabled, acting as a queued media-generation backend for peers over Tailscale.

### External Contributor (out-of-band, low priority)
- **Needs:** a working MIT-licensed codebase to read, fork, or occasionally PR against.
- **Context:** not onboarded — no CODE_OF_CONDUCT.md exists; [CONTRIBUTING.md](./docs/CONTRIBUTING.md) documents contribution expectations, but PRs are welcome without a dedicated onboarding path, and the project explicitly does not optimize for this persona's needs over the owner-operator's.

---

## Functional Requirements

### App & Process Management

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-1 | The system MUST support full CRUD + archive/unarchive lifecycle for tracked apps. | Must | Creating, editing, archiving, and unarchiving an app via the API round-trips through the app list without data loss. |
| FR-2 | The system MUST manage PM2-backed app lifecycle actions (start/stop/restart/update/build/status/logs). | Must | Each lifecycle action returns success/failure state and streams logs for the target app within its running duration. |
| FR-3 | The system MUST detect port conflicts against the canonical `PORTS` registry before allocation. | Must | Requesting a port already claimed by another app returns a conflict, not a silent overwrite. |
| FR-4 | The system SHOULD expose configurable system-health thresholds. | Should | `PUT /api/system/health/thresholds` persists new thresholds and subsequent `GET /api/system/health` checks use them. |
| FR-59 | The system MUST provide in-app UI for the full lifecycle of every local runtime it supports and every model that runtime needs — install/uninstall the runtime, search a catalog, download a model, and remove a downloaded model — with progress surfaced live. A user MUST never be told to run a shell command to complete one of these steps. | Must | For each supported local runtime (Ollama, LM Studio, llama.cpp, MTPLX), the UI offers install, start/stop, model search, model download with byte progress, and model removal; no user-facing empty/blocked state names a terminal command as its remedy. |

### AI Agent Orchestration (CoS)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-5 | The system MUST generate tasks from goals and route them to an AI provider automatically. | Must | A newly created goal produces at least one CoS task without manual task authoring. |
| FR-6 | The system MUST support full agent lifecycle control (pause/resume/terminate/kill) and mid-run feedback injection. | Must | Pausing a running agent halts its next action; resuming continues from state; a "btw" note reaches the agent's next turn. |
| FR-7 | The system MUST isolate each spawned agent's file writes in a per-agent worktree. | Must | Two concurrently running agents never write to the same working tree; `data/cos/worktrees/<agentId>` exists per agent. |
| FR-8 | The system MUST learn provider/model-tier routing from task outcomes over time (self-tuning). | Must | Provider success-rate data observably shifts routing weight after a run of successes/failures for a given task type. |
| FR-9 | The system MUST gate scheduled/autonomous jobs on user-configured pre-run conditions before executing. | Must | A job with a gate condition that evaluates false does not spawn an agent or fire an LLM call. |
| FR-10 | The system SHOULD surface a weekly digest of CoS learning/insight trends. | Should | A digest artifact is generated on a recurring schedule summarizing task outcomes and recommendations. |

### Personal Knowledge Management (Brain & Memory)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-11 | The system MUST support capture-to-inbox with review/resolve/LLM-assisted-fix workflow for unstructured thoughts. | Must | A captured thought reaches the inbox, can be auto-classified, and can be resolved into a typed entity (person/project/idea/memory). |
| FR-12 | The system MUST provide hybrid (vector + BM25) semantic search across Memory. | Must | A search query returns results ranked by combined vector-similarity and keyword relevance, not vector-only or keyword-only. |
| FR-13 | The system MUST support a date-keyed daily log with optional Obsidian sync. | Must | A daily-log entry created in PortOS is retrievable by date and, when sync is enabled, mirrors to the configured Obsidian vault. |
| FR-14 | The system MUST reconcile Brain records across federated peers via delta-log sync. | Must | Running sync against a peer applies only records newer than the last synced cursor, not a full re-send. |
| FR-15 | The system SHOULD generate daily/weekly digests surfacing patterns across captured knowledge. | Should | A digest is produced on schedule and references at least one cross-entity pattern (e.g. recurring topic across captures). |

### Digital Identity Modeling

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-16 | The system MUST maintain a machine-readable digital-twin profile (traits, confidence scores, contradiction/completeness checks) that other features can query. | Must | A trait added via enrichment Q&A is retrievable by other services (e.g. Writers Room voice briefing) and flagged if it contradicts an existing trait. |
| FR-17 | The system MUST support multiple named personas with one marked active at a time. | Must | Switching the active persona changes which trait set is briefed to downstream AI calls. |
| FR-18 | The system MUST provide a conversational "Ask Yourself" interface grounded in identity, goals, memory, and Brain captures. | Must | A question posed to Ask Yourself returns an answer that cites or is consistent with at least one grounding source. |
| FR-19 | The system SHOULD support AI-assisted goal decomposition into phases with accept/reject per phase. | Should | Generating phases for a goal returns a phase list the user can selectively accept, and accepted phases persist as sub-goals. |
| FR-58 | The system MUST surface cross-domain insights connecting genome, health, taste, and identity data into narrative patterns and a goal scorecard. | Must | `/insights/cross-domain` renders computed correlations, and `POST /api/insights/narrative/refresh` regenerates the narrative from current source data rather than serving a static placeholder. |

### Creative Production Suite

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-20 | The system MUST support Universe Builder world-bible generation with a lockable canon canvas (characters, locations, items, factions, lore). | Must | Locking a canon entry prevents further LLM-driven overwrite of that entry on subsequent expand/merge operations. |
| FR-21 | The system MUST support Series Pipeline multi-issue/episode production (arcs, outlines, story bible, per-stage prompts). | Must | Creating a series and running its pipeline stages produces persisted arc/outline/issue artifacts in sequence. |
| FR-22 | The system MUST support Writers Room distraction-free drafting with promote-to-pipeline and versioned drafts. | Must | Promoting a Writers Room work links it into an existing or new Pipeline series without losing draft history. |
| FR-23 | The system MUST support image generation (FLUX, Z-Image, A1111, external endpoints) with enforced pixel/edge caps. | Must | A generation request exceeding `MAX_IMAGE_EDGE` (3840px) or `MAX_IMAGE_PIXELS` (8,294,400) is rejected with an explicit error, not silently downscaled or accepted. |
| FR-24 | The system MUST support video generation (text-to-video, image-to-video, audio-to-video, extend) via Creative Director orchestration. | Must | A Creative Director run progresses treatment → scene plan → render without manual intervention between stages. |
| FR-25 | The system MUST support importing external prose/screenplay/comic content into structured Universes or Pipeline series. | Must | An imported document produces a populated Universe or series draft, not just raw stored text. |
| FR-26 | The system MUST support exporting finished creative work via cloud-synced Sharing buckets to other PortOS instances. | Must | A shared universe/series is retrievable and importable from a subscribed peer instance. |
| FR-27 | The system SHOULD brief every creative-generation call with the active Digital Twin's voice/taste profile. | Should | Generated prose/treatment output reflects twin-configured tone preferences (verifiable via prompt inspection, not subjective judgment alone). |
| FR-56 | The system MUST support local music/audio generation (Music Studio) with engine setup, model management, and generation from a text description or lyrics. | Must | Submitting a description via `POST /api/music/generate` produces an audio asset using an installed model from `GET /api/music/models/:engine`; the endpoint rejects generation against an engine with no runtime installed. |
| FR-57 | The system MUST support Mood Boards for collecting visual/textual references and a Media Annotation canvas for marking up generated images before re-rendering. | Must | Creating a mood board at `/mood-boards` persists and is retrievable at `/mood-boards/:id`; opening `/media/annotate/:mediaKey` loads the annotation canvas against the referenced media asset. |

### Developer Productivity Toolkit

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-28 | The system MUST provide a web-based shell with PTY session support. | Must | A shell session opened in the browser executes commands and streams output in real time. |
| FR-29 | The system MUST provide git tooling (status/diff/commit/push/branch-compare) and submodule status/update, scoped per tracked app. | Must | Committing and pushing from the UI updates the underlying repo identically to running the equivalent CLI commands. |
| FR-30 | The system MUST provide CDP-based browser control (launch/navigate/health/downloads). | Must | A browser session launched via the API can navigate to a URL and report page state back to the caller. |

### Self-Improving Intelligence

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-31 | The system MUST self-heal corrupted learning metrics on startup rather than requiring manual repair. | Must | Boot with a deliberately corrupted metrics file completes without crashing and resets the affected metric to a safe default. |
| FR-32 | The system SHOULD generate autonomous code-quality improvement tasks from observed patterns. | Should | At least one autonomous job type produces a CoS task targeting code quality without a human-authored prompt triggering it. |

### Full Digital Autonomy (Voice, Messaging, Social)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-33 | The system MUST support a voice agent with TTS and STT (Whisper) for spoken interaction. | Must | A spoken query is transcribed, processed, and answered with synthesized speech in one round trip. |
| FR-34 | The system MUST support Telegram and OpenClaw (operator chat) as additional interaction surfaces over the same agent/task backend. | Must | A command issued via Telegram produces the same class of result (task created, question answered) as the equivalent web-UI action. |
| FR-35 | The system MUST support a unified messages inbox across email/SMS/iMessage/Signal accounts with triage rules and a review-before-send outbox. | Must | An outbound AI-drafted message sits in the outbox until explicitly approved and sent — never auto-sent without review. |
| FR-36 | The system SHOULD support multi-account social posting (X/Twitter) with a draft-review workflow. | Should | A scheduled post is held as a draft until approved, then published to the correct configured account. |

### Knowledge Legacy

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-37 | The system MUST support exporting a self-contained legacy bundle (Markdown + JSON + manifest, optional rendered PDF) from the Digital Twin. | Must | Running export produces an archive that opens and displays coherent content without requiring the live PortOS instance. |

### Anywhere Access (Tailscale, Auth, HTTPS, Federation)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-38 | The system MUST support an optional instance password gating all `/api/*` and `/data/*` routes when set, while keeping a minimal always-public route set. | Must | With a password set, an unauthenticated request to a non-allowlisted `/api/*` route is rejected; `/api/auth/status` and `/api/system/health` remain reachable. |
| FR-39 | The system MUST support opt-in HTTPS provisioning with a loopback-only HTTP mirror for local tooling. | Must | After running cert setup, `:5555` serves TLS and `:5553` remains reachable only from loopback. |
| FR-40 | The system MUST support federation with an unbounded number of peer instances (announce/connect/sync), each with its own per-peer Basic-auth credential for password-gated peers. | Must | Registering a third, fourth, or Nth peer works identically to registering the second — no fixed two-peer assumption anywhere in the peer registry (`data/instances.json`) or sync path. |
| FR-41 | The system MUST support cross-instance data sharing via export buckets with an inbox promote/dismiss workflow on the receiving side. | Must | A record pushed to a subscribed peer's sharing inbox is neither auto-applied nor lost — it requires explicit promote or dismiss. |
| FR-52 | The system MUST support delegating queued audio/music-generation jobs to a federated peer's local compute, gated behind that peer's opt-in enablement, model allowlist, and live capacity. (Image/video generation is not yet covered — see Out of Scope.) | Must | Submitting an audio/music job to a peer that is enabled, has the requested model allowlisted, and has queue headroom returns a queued job the caller can poll/cancel/download; a peer at capacity or without the model allowlisted rejects the submission rather than silently queuing it. |
| FR-53 | The system MUST let a user assign an audio/music-generation job to a specific federated peer from the web UI, choosing among currently enabled and reachable peer providers. | Must | The provider picker only lists peers the user has explicitly enabled as media providers and that currently report ready status; selecting one routes the job to that peer, not an arbitrary one. |

### Health & Longevity (MeatSpace)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-42 | The system MUST track blood work, body metrics, blood pressure, workouts, epigenetic age, and eye health as independently loggable record types. | Must | Each record type supports create and retrieve independently of the others. |
| FR-43 | The system MUST compute longevity/mortality projections (death-clock estimate, LEV) from tracked lifestyle and biomarker data. | Must | Updating a relevant biomarker changes the computed projection on next read. |
| FR-44 | The system MUST support bulk ingest of Apple Health XML exports and live metric ingest, with cross-metric correlation queries. | Must | An imported XML export populates queryable daily metrics, and a correlation query between two metrics returns a computed relationship, not raw unmerged series. |
| FR-45 | The system MUST apply the same goal-tracking/urgency-scoring engine used for digital projects to meatspace health goals. | Must | A health goal (e.g. exercise target) appears in the same goal-progress views and scoring logic as a project goal. |

### Personal Productivity & Life Management

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-46 | The system MUST support multi-account Google Calendar sync with configurable sync direction (push/discover). | Must | An event created in PortOS appears in the linked Google Calendar, and vice versa, according to the configured direction. |
| FR-47 | The system SHOULD schedule goal check-ins and work sessions with chronotype-aware timing derived from genome sleep markers. | Should | A booked work session for a goal falls within the user's configured chronotype-preferred window when data is available. |
| FR-48 | The system MUST support contact enrichment and a contact-to-Tribe (relationship CRM) pipeline. | Must | Running enrich/suggest/import on a contact produces a Tribe record linked back to the source contact. |

### Cognitive Training & Lifelong Learning (POST)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-49 | The system MUST deliver a daily self-test across mental math, wordplay, memory, verbal agility, and imagination domains. | Must | A completed daily session records a score per domain and contributes to a visible progress trend. |
| FR-50 | The system MUST support Morse code (CW/Koch method) and Rapid Reader (adjustable WPM) as specialized training modes. | Must | A Morse or Rapid Reader session completes and its result is recorded distinctly from the daily five-domain test. |
| FR-51 | The system MUST gate any bulk pre-generation of drill content behind explicit user consent naming the provider/model, per the AI Provider Usage Policy. | Must | A cold (first-run) drill cache fill never occurs without a consent modal; only single on-demand generations occur otherwise. |

---

## Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Security | Authentication MUST remain fully functional when the optional instance password is set, even though it is off by default — no code path may assume auth is permanently absent. |
| NFR-2 | Security | Peer-to-peer hops over Tailscale MAY skip TLS certificate verification (`rejectUnauthorized: false`) on the assumption that WireGuard supplies mutual auth between tailnet nodes; non-tailnet peers get no equivalent guarantee and MUST be treated as lower-trust. |
| NFR-3 | Security | All shell command execution MUST be restricted to an explicit allowlist (`server/lib/commandSecurity.js`) — no arbitrary shell invocation from user or agent input. |
| NFR-4 | Security | All route input MUST be validated via Zod schemas with explicit size/shape bounds (string length caps, numeric ranges, ID regex constraints) — no unbounded strings or arrays accepted at the API boundary. |
| NFR-5 | Reliability | On-disk data-format changes MUST ship with a migration under `scripts/migrations/`, tracked per install in `data/migrations.applied.json`, so independently-updating installs never silently corrupt on upgrade. |
| NFR-6 | Reliability | Cross-peer sync payloads MUST be version-gated (`server/lib/schemaVersions.js`) so a newer peer cannot corrupt an older one during federation. |
| NFR-7 | Reliability | Prompt-template default changes MUST bump `PROMPT_VERSIONS` and preserve the prior default in `PREVIOUS_DEFAULT_PROMPTS`, so other installs can auto-upgrade their stored prompt without losing user customization signal. |
| NFR-8 | Reliability | The self-update path MUST remain fork-aware — user-visible "is this upstream" state MUST read `remoteInfo.isUpstream`, not just the version string, and the server-side `gh repo sync` MUST NOT force-overwrite a diverged fork. |
| NFR-9 | Performance | File uploads MUST be capped per content type (e.g. 2GB for health/brain bulk imports, 200MB for timeline video, 8,294,400px for generated images) and rejected with an explicit error above the cap, not silently truncated. |
| NFR-10 | Performance | Long-running external calls (git operations, LLM provider calls, local-model inference) MUST have explicit timeout constants rather than blocking indefinitely, **except** operations the system deliberately runs as completion-signal/sentinel-driven rather than wall-clock-bounded — e.g. CoS TUI agent attachment (which stays attached past 24 hours until sentinel/exit/failure) and remote audio-generation downloads — which must not be retrofitted with a fixed timeout. |
| NFR-11 | Usability | Every user-facing view that opens or selects a specific record MUST be a deep-linkable route (`/page/sub-tab/edit`), not modal-only state, so it is shareable, bookmarkable, and reachable from ⌘K and voice. |
| NFR-12 | Usability | Every new top-level page or voice/palette action MUST register in the nav manifest (`server/lib/navManifest.js`) so it is reachable via ⌘K and the voice agent's `ui_navigate` tool. |
| NFR-13 | Compatibility | PostgreSQL (with pgvector) MUST be treated as a mandatory dependency for every install and federated peer — the file-backed memory mode MUST remain a test-only escape hatch, never a supported deployment fallback. |
| NFR-14 | Compatibility | The system MUST run correctly across independently-upgrading installs and forks — no feature may assume all peers are on the same code version. |
| NFR-15 | Cost | The system MUST be operable primarily on flat-rate AI provider subscriptions rather than requiring metered per-token billing for normal (non-power-user) operation, consistent with the project's stated cost philosophy. |
| NFR-16 | Usability | Any operation PortOS is capable of performing on the user's behalf MUST be reachable from the UI. When a state blocks a workflow (a missing binary, an empty model cache, an unprovisioned dependency), the message MUST name the in-app control that resolves it — never a command for the user to type. |

---

## Negative Requirements

| ID | Requirement | Why |
|---|---|---|
| NR-1 | The system MUST NOT fire AI provider calls from server boot/init sequences (cache warm-ups, pre-generation, startup backfills), nor silently expand a single user-requested generation into an unrequested batch. | Prevents unannounced cost/latency surprises on a fresh install or newly merged feature; the one sanctioned exception is a user-configured scheduled automation (CoS job, autopilot, cron task). |
| NR-2 | The system MUST NOT run DB-backed test suites against the production `portos` database. | A 2026-06-13/14 incident wiped real data when a test suite's write guard was insufficiently strict; the guard now keys on `NODE_ENV==='test' OR VITEST` and backstops all row-mutating statements against a non-test DB under the runner. |
| NR-3 | The system MUST NOT define a backup exclude pattern without a leading `/` anchor. | An unanchored rsync-filter pattern matches at any depth and silently drops unrelated user data — a data-loss bug class, not a style preference. |
| NR-4 | The system MUST NOT let PII or machine identity (hostnames, Tailscale node names, IPs, tokens, real names/addresses) cross the federation/peer-sync layer. | Federation payloads leave the local machine; privacy-sensitive fields must stay machine-local by design (ADR: `docs/decisions/2026-08-08-privacy-records-machine-local.md`). |
| NR-5 | The system MUST NOT add multi-user authentication, roles, or tenancy. | PortOS is architected single-user-per-install; adding this would add complexity with no benefit to the actual usage model. |
| NR-6 | The system MUST NOT add CORS restrictions, request-level rate limiting, or cross-actor concurrency defenses (mutex/atomic-write races) as protection against competing human actors within one install. | The trust model is one human per install on a private Tailnet — these defenses solve a problem PortOS doesn't have and add maintenance surface. |
| NR-7 | The system MUST NOT treat leakage of a free, non-monetary third-party API key (e.g. CivitAI) to an unintended host as a security finding requiring host-allowlisting or key-stripping. | Won't-fix precedent (#2200): worst case is quota abuse against a free service, borne by that service — no monetary loss or meaningful security consequence. Does not extend to paid/quota-billed providers or money-bearing/destructive-action keys, which retain full hardening requirements. |
| NR-8 | The system MUST NOT send an AI-drafted outbound message (email, social post) without explicit user review-and-approve, regardless of how confident the draft is. | Full digital autonomy (Goal 8) extends to task execution, not to irreversible outward-facing communication acting under the user's identity without a human gate. |
| NR-9 | The system MUST NOT instruct the user to run a shell/terminal command in order to complete a workflow PortOS can perform itself — including installing or removing a runtime, and searching for, downloading, or deleting a model. Blocked-state copy points at the in-app control, not at a command line. | PortOS is the control surface for the machine; sending the user to a terminal for one step of an otherwise-managed lifecycle is a dead end that breaks remote/mobile use (Anywhere Access) and leaves the app's own state stale. **Carve-out:** genuinely privileged one-time host setup PortOS deliberately refuses to perform (`pm2 startup`, `sudo` fan-control helpers, `gcloud auth login`) may be named as an operator step — the refusal must be deliberate and documented, not a gap in the UI. |
| NR-10 | The system MUST NOT add per-domain backup-style export endpoints (e.g. a generic "export my Brain/memories/thoughts to file" download) as a durability or backup story. | PortOS is a locally hosted app that is itself the user's backup of record — data lives on the user's hardware and is covered by automatic snapshots (`docs/BACKUP.md`). Download/export buttons exist only for sharing or handoff to other tools (Sharing buckets, Legacy Bundle, format-specific creative deliverables), never as a parallel backup mechanism. |

---

## Out of Scope

- **Multi-user support** — no auth roles or tenancy; would add complexity with no benefit to the single-user architecture.
- **Public internet deployment / public-facing hardening** — runs on a private Tailscale network only; HTTPS support exists for browser-API/cert-trust convenience, not public exposure.
- **ORM or heavyweight database tooling** — deliberate plain-SQL usage against Postgres; no query builder or ORM layer.
- **Cloud hosting** — runs on the user's own hardware; not offered as a hosted service.
- **General-purpose external-user onboarding** — no CODE_OF_CONDUCT.md; [CONTRIBUTING.md](./docs/CONTRIBUTING.md) sets contribution expectations, but the project is not structured to actively onboard outside contributors even though it accepts PRs.
- **Podcast/recording studio** — full audio-recording production tooling beyond generative music (Music Studio, FR-56, is implemented; a dedicated recording/podcast workflow is not).
- **Federated peer-to-peer sharing beyond bucket-based Sharing** — direct P2P distribution between instances is a secondary goal, not yet built.
- **Federated media-provider routing for image/video generation** — the queued-job delegation contract (FR-52/FR-53) is implemented and live for audio/music generation today; extending the same provider/consumer contract to image and video generation is tracked separately (issue #4348), not yet built.
- **User-directed assignment of a CoS task to a specific federated peer instance** — task coordination across peers is currently opportunistic only (first peer to see a synced task claims it via the existing lease mechanism); an explicit "run this task on instance X" control is a decided, ready-to-work follow-up (issue #4520), not yet implemented.
- **Per-domain backup-style exports** — PortOS is locally hosted and is itself the backup of record (automatic snapshots); exports exist only for sharing or handoff to other tools, per NR-10.

---

## Assumptions & Constraints

- Runs on Node.js ≥22.12.0; PostgreSQL (system `:5432` or Docker `:5561`) is a mandatory runtime dependency for every install.
- The user operates on a private Tailscale network; the network boundary, not application-layer auth, is the default trust boundary.
- The user maintains an arbitrary, unbounded number of federated PortOS installs (including local-inference machines) as sync peers and, where enabled, spare generation capacity — not a single fixed primary/secondary pair.
- AI provider costs are assumed to run primarily through flat-rate subscriptions (Claude Max, Codex, Google AI Pro, SuperGrok) plus local Ollama/LM Studio inference, not metered per-call billing — this shapes the "no cold-bootstrap LLM calls" policy.
- The project accepts external PRs but does not guarantee backward compatibility of its own conventions for third-party contributors; breaking changes may ship without notice, mitigated only by the mandatory migration/versioning discipline for on-disk data (NFR-5–NFR-8). Contribution expectations are documented in [CONTRIBUTING.md](./docs/CONTRIBUTING.md).
- MIT license; no funding/sponsorship model in place.
- The `server/` and `client/` sub-package `version` fields are informational only and drift independently from the root `package.json` version — no release, build, or deployment tooling reads them, so their skew is not a compatibility risk.

---

## Success Metrics

- **CoS routing improvement over time** — provider/model-tier selection should measurably shift toward higher-success-rate choices as more task outcomes are recorded. *(No numeric target evidenced in the codebase — open question.)*
- **Zero data-loss incidents from migrations or backup excludes across releases.** *(Qualitative target; no automated metric currently tracks this — open question whether to instrument it.)*
- **Federation sync convergence** — peers should not silently diverge beyond a bounded delta-log lag. *(No numeric staleness threshold currently defined — open question.)*
- **POST engagement** — sustained daily-session completion over time as a proxy for the "actively strengthening how you learn" goal. *(No target streak/percentage evidenced — open question.)*

---

## Risks & Open Questions

- **POST drill/benchmark system is mid-buildout** — cognitive-training domain coverage is still expanding; tracked in the issue tracker (#4442, #4443).
- **Image/video federated media-provider routing is unbuilt** — the audio/music delegation contract (FR-52/FR-53) is live, but extending it to image/video generation is tracked separately (#4348).
- **Explicit peer task assignment is unbuilt** — CoS task coordination across peers is opportunistic (claim-based) only today; directed "run on instance X" assignment is a decided, ready-to-work follow-up (#4520).

No other open questions remain unresolved as of this revision. Video generation pipeline reliability, the workspace package-version skew, and the absence of contributor documentation were the other items previously tracked here — video generation is now stable, the version skew was confirmed cosmetic (see Assumptions & Constraints), and [CONTRIBUTING.md](./docs/CONTRIBUTING.md) now exists.

---

See [GOALS.md](./GOALS.md) for the strategic mission and long-term vision. The tactical backlog and current work items live in the GitHub issue tracker — open issues labeled [`plan`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Aplan) (claimable) and [`future`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Afuture) (parked ideas) — this repo has no root `PLAN.md`.
