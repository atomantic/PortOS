# PortOS Documentation

Index of everything under `docs/`. Start with the [root README](../README.md) for the product overview and quick start.

**Something won't start?** Run `npm run doctor` — a read-only report of every install prerequisite (Node/npm floors, submodule, workspace deps, PostgreSQL + pgvector, migrations, seeded `data/`, pm2, media toolchain, cert, ports). It runs before `npm install` and prints one pasteable block; add `--json` for machine-readable output. Then see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Guides (living documents)

| Doc | Covers |
|-----|--------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design: React client, Express server, PM2 satellites, PostgreSQL + `data/` files |
| [API.md](./API.md) | REST endpoints, complete route-domain index, Socket.IO events |
| [API_TOOL_CONTRACT.md](./API_TOOL_CONTRACT.md) | Unified semantic tool, Persistent Mind, and Agent Tools MCP contract |
| [COMPANION_APP_API.md](./COMPANION_APP_API.md) | PortDeck native iOS companion client discovery and HTTP API contract |
| [REMOTE_DESKTOP.md](./REMOTE_DESKTOP.md) | PortDeck VNC broker security, host setup, and session flow |
| [FEDERATED_MEDIA_PROVIDERS.md](./FEDERATED_MEDIA_PROVIDERS.md) | Authenticated, capacity-aware peer audio provider wire contract and setup |
| [STORAGE.md](./STORAGE.md) | Storage classification contract — PostgreSQL vs filesystem, new-data-store checklist |
| [BACKUP.md](./BACKUP.md) | Filesystem snapshots + PostgreSQL dumps, restore semantics |
| [PORTS.md](./PORTS.md) | Port allocation (5553–5561) and how 5555/5553/5554 relate |
| [PM2.md](./PM2.md) | Recommended PM2 ecosystem patterns for sub-projects |
| [QUOTA-BURN.md](./QUOTA-BURN.md) | Quota-burn automation — spending subscription-backed CLI quota before expiry |
| [THREEJS_MODELS.md](./THREEJS_MODELS.md) | Three.js procedural 3D model generation and trust boundary |
| [features/music-renderer-benchmarks.md](./features/music-renderer-benchmarks.md) | Technical and full-length listening evidence for local music renderer profiles |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup (PostgreSQL required), code conventions |
| [GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md) | CI and release workflows |
| [VERSIONING.md](./VERSIONING.md) | SemVer + release process (`/do:release`) |
| [SELF_UPDATE.md](./SELF_UPDATE.md) | Fork-aware self-update flow — release polling, `FORK_SYNC_REQUIRED`, fork sync |
| [DEPS.md](./DEPS.md) | Dependency audit — every third-party package and its verdict |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common runtime issues, known issues |
| [WINDOWS_CONSOLE.md](./WINDOWS_CONSOLE.md) | Why console windows flash and steal focus on Windows, and the two fixes |
| [GOALS_OPERATIONAL.md](./GOALS_OPERATIONAL.md) | Runtime operating principles the CoS agent reads (parsed by `goalProgress.js`) |
| [METRICS.md](./METRICS.md) | The `METRICS.md` convention — how a managed app exposes its own success metrics so agents (incl. Layered Intelligence) can evaluate it against its goals |
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | Historical hardening audit (2026-02, all items resolved) |

## Feature deep dives (`features/`)

Start with the [product surface map](./features/product-surfaces.md) for a complete, user-facing inventory of the application. The focused guides below explain the features with their own operating contracts.

App management: [app-wizard](./features/app-wizard.md) · [autofixer](./features/autofixer.md) · [browser](./features/browser.md) · [error-handling](./features/error-handling.md) · [jira-sprint-manager](./features/jira-sprint-manager.md)

Chief of Staff: [chief-of-staff](./features/chief-of-staff.md) · [cos-agent-runner](./features/cos-agent-runner.md) · [cos-enhancement](./features/cos-enhancement.md) · [agent-context](./features/agent-context.md) · [agent-skills](./features/agent-skills.md) · [memory-system](./features/memory-system.md) · [claude-ollama](./features/claude-ollama.md) · [mtplx](./features/mtplx.md) · [dflash2](./features/dflash2.md) ([DSpark vs DFlash 2](./research/2026-08-19-dspark-vs-dflash2.md)) · [qwen38-rtx3090](./features/qwen38-rtx3090.md) ([3090 bring-up](./research/2026-08-21-qwen38-rtx3090-vllm.md)) · [sglang-qwen38](./features/sglang-qwen38.md) ([SGLang Hopper/Blackwell evaluation](./research/2026-08-21-sglang-qwen38-27b.md)) · [prompt-manager](./features/prompt-manager.md)

Identity & self: [digital-twin](./features/digital-twin.md) · [identity-system](./features/identity-system.md) · [soul-system](./features/soul-system.md) · [privacy-center](./features/privacy-center.md) · [post](./features/post.md) (insights design spike: [plans/2026-06-03](./plans/2026-06-03-cross-domain-insights-engine.md))

Knowledge: [brain-system](./features/brain-system.md) · [messages-security](./features/messages-security.md)

Create: [writers-room](./features/writers-room.md) · [fableloom](./features/fableloom.md) · [openworld](./features/openworld.md) · [Eidoverse Worlds integration](./features/eidoverse.md) · [sprite-export-contract](./features/sprite-export-contract.md) · [video-text-encoders](./features/video-text-encoders.md) · [video-speed-profiles](./features/video-speed-profiles.md)

Comms & voice: [openclaw-operator-chat](./features/openclaw-operator-chat.md) ([pre-build audit](./research/2026-03-31-openclaw-operator-chat-audit.md)) · [stacker-news](./features/stacker-news.md) · [voice](./features/voice.md)

## Point-in-time records

- **[plans/](./plans/README.md)** — dated design plans (`YYYY-MM-DD-<slug>.md`), archived on approval before implementation. Historical records, not living docs.
- **decisions/** — ADRs (`YYYY-MM-DD-<slug>.md`), e.g. the [Postgres-as-primary-datastore decision](./decisions/2026-06-07-postgres-as-primary-datastore.md) and what may cross the federation layer ([privacy records machine-local](./decisions/2026-08-08-privacy-records-machine-local.md), [federated visual prompts](./decisions/2026-08-20-federated-visual-prompts.md), [conditioning crosses to an allowlisted peer](./decisions/2026-08-22-federated-media-input-assets.md)), and why H3 [ships the draft-decode gates without an asset](./decisions/2026-08-30-h3-draft-decoder-asset.md).
- **research/** — dated investigation and incident write-ups (e.g. the [mflux GPU-watchdog panic](./research/2026-06-13-mflux-training-watchdog-panic.md) and the [local LLM performance audit](./research/2026-08-22-local-llm-performance-audit.md)).
- **superpowers/** — plan/spec pairs from superpowers-driven builds: `specs/<date>-<slug>-design.md` (design) + `plans/<date>-<slug>.md` (implementation plan).

## Other

- **[themes/](./themes/README.md)** — UI theme specs and the theme integration contract.
- **[examples/](./examples/README.md)** — copy-ready config examples (e.g. Claude Code → Ollama settings).
- **[`.changelog/README.md`](../.changelog/README.md)** — how `/do:release` synthesizes release notes from the commit log, and the versioned-file format.
- **media/** — screenshots and logo used by the root README.
