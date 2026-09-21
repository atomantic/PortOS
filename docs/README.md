# PortOS Documentation

Index of everything under `docs/`. Start with the [root README](../README.md) for the product overview and quick start, and [ETHOS.md](../ETHOS.md) for the project's position on autonomy, digital-mind individuality, privacy boundaries, and why consent here is architecture rather than a service.

**Something won't start?** Run `npm run doctor` — a read-only report of every install prerequisite (Node/npm floors, submodule, workspace deps, PostgreSQL + pgvector, migrations, seeded `data/`, pm2, media toolchain, cert, ports). It runs before `npm install` and prints one pasteable block; add `--json` for machine-readable output. Then see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Guides (living documents)

| Doc | Covers |
|-----|--------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design: React client, Express server, PM2 satellites, PostgreSQL + `data/` files |
| [API.md](./API.md) | REST endpoints, complete route-domain index, Socket.IO events |
| [API_TOOL_CONTRACT.md](./API_TOOL_CONTRACT.md) | Unified semantic tool, Persistent Mind, and Agent Tools MCP contract |
| [COMPANION_APP_API.md](./COMPANION_APP_API.md) | PortDeck native iOS companion client discovery and HTTP API contract |
| [SETUP.md](./SETUP.md) | First install: Tailscale, MagicDNS, trusted HTTPS, exact launch URL, and AI-provider readiness |
| [REMOTE_DESKTOP.md](./REMOTE_DESKTOP.md) | PortDeck VNC broker security, host setup, and session flow |
| [FEDERATED_MEDIA_PROVIDERS.md](./FEDERATED_MEDIA_PROVIDERS.md) | Authenticated, capacity-aware peer audio provider wire contract and setup |
| [STORAGE.md](./STORAGE.md) | Storage classification contract — PostgreSQL vs filesystem, new-data-store checklist |
| [BACKUP.md](./BACKUP.md) | Filesystem snapshots + PostgreSQL dumps, restore semantics |
| [PORTS.md](./PORTS.md) | Port allocation (5553–5561) and how 5555/5553/5554 relate |
| [INSTANCE_FEATURES.md](./INSTANCE_FEATURES.md) | Optional per-install features — registry, client-side nav gating, feature groups, reconcile-at-toggle |
| [PM2.md](./PM2.md) | Recommended PM2 ecosystem patterns for sub-projects |
| [QUOTA-BURN.md](./QUOTA-BURN.md) | Quota-burn automation — spending subscription-backed CLI quota before expiry |
| [AI_PROVIDERS.md](./AI_PROVIDERS.md) | The AI Providers page: a run composed from Harness × Method × Service × Model × Effort, its Presets / Harnesses / Services views, compatibility matrix, derived vs legacy presets, and what federates (nothing) |
| [PROVIDER_COMPOSITION.md](./PROVIDER_COMPOSITION.md) | Composite provider ids (`harness.method@service[+bootstrap]`): the grammar, per-harness enablement, bootstrap apps, how every run path resolves one, and the preset-only surfaces |
| [MODEL_ACCESS.md](./MODEL_ACCESS.md) | Scoping a provider to the models your plan entitles you to — free tiers, allow/deny globs, gateway inheritance |
| [MODEL-COMPARISON.md](./MODEL-COMPARISON.md) | Sourced provider/model/effort comparisons, cost estimates and CoS research refresh |
| [THREEJS_MODELS.md](./THREEJS_MODELS.md) | Three.js procedural 3D model generation and trust boundary |
| [features/music-renderer-benchmarks.md](./features/music-renderer-benchmarks.md) | Technical and full-length listening evidence for local music renderer profiles |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup (PostgreSQL required), code conventions |
| [CLI_REVIEW_OUTCOMES.md](./CLI_REVIEW_OUTCOMES.md) | Bounded, authenticated CLI reviewer health reports for orchestrating agents |
| [UX_DESIGN_GUIDE.md](./UX_DESIGN_GUIDE.md) | Admin workspace design specification: icon navigation, responsive layouts, disclosure, visual hierarchy, and redesign acceptance |
| [UX_DESIGN_AUDIT.md](./UX_DESIGN_AUDIT.md) | Representative UX audit and Jev/Performance pilot content maps |
| [GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md) | CI and release workflows |
| [VERSIONING.md](./VERSIONING.md) | SemVer + release process (`/do:release`) |
| [SELF_UPDATE.md](./SELF_UPDATE.md) | Fork-aware self-update flow — release polling, `FORK_SYNC_REQUIRED`, fork sync, running a customized fork, and the unattended idle-gated automatic update |
| [MANAGED_APP_UPDATES.md](./MANAGED_APP_UPDATES.md) | Safe managed-app update default and the opt-in app lifecycle contract |
| [MANAGED_APP_FORGE_ACCOUNTS.md](./MANAGED_APP_FORGE_ACCOUNTS.md) | Running managed apps under a second GitHub account — ssh `Host` aliases and the per-app `forgeAccount` pin |
| [DEPS.md](./DEPS.md) | Dependency audit — every third-party package and its verdict |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common runtime issues, known issues |
| [WINDOWS_CONSOLE.md](./WINDOWS_CONSOLE.md) | Why console windows flash and steal focus on Windows, and the two fixes |
| [GOALS_OPERATIONAL.md](./GOALS_OPERATIONAL.md) | Runtime operating principles the CoS agent reads (parsed by `goalProgress.js`) |
| [METRICS.md](./METRICS.md) | The `METRICS.md` convention — how a managed app exposes its own success metrics so agents (incl. Layered Intelligence) can evaluate it against its goals |

## Feature deep dives (`features/`)

Start with the [product surface map](./features/product-surfaces.md) for a complete, user-facing inventory of the application. The focused guides below explain the features with their own operating contracts.

App management: [app-wizard](./features/app-wizard.md) · [autofixer](./features/autofixer.md) · [browser](./features/browser.md) · [error-handling](./features/error-handling.md) · [jira-sprint-manager](./features/jira-sprint-manager.md)

Chief of Staff: [chief-of-staff](./features/chief-of-staff.md) · [cos-agent-runner](./features/cos-agent-runner.md) · [cos-enhancement](./features/cos-enhancement.md) · [self-improvement-audits](./features/self-improvement-audits.md) · [agent-context](./features/agent-context.md) · [agent-skills](./features/agent-skills.md) · [memory-system](./features/memory-system.md) · [claude-ollama](./features/claude-ollama.md) · [grok-box-local-mind](./features/grok-box-local-mind.md) · [fleet-llm-host](./features/fleet-llm-host.md) · [mtplx](./features/mtplx.md) · [slotstream](./features/slotstream.md) · [dflash2](./features/dflash2.md) ([DSpark vs DFlash 2](./research/2026-08-19-dspark-vs-dflash2.md), [Ternary Bonsai 2 27B](./research/2026-09-18-ternary-bonsai-2-27b.md)) · [qwen38-rtx3090](./features/qwen38-rtx3090.md) ([3090 bring-up](./research/2026-08-21-qwen38-rtx3090-vllm.md)) · [sglang-qwen38](./features/sglang-qwen38.md) ([SGLang Hopper/Blackwell evaluation](./research/2026-08-21-sglang-qwen38-27b.md)) · [prompt-manager](./features/prompt-manager.md)
- [Persistent Mind continuous play + local context](./features/persistent-mind-continuous-play.md) — explore/invent playbook and mind-adjustable `numCtx` clamps

Identity & self: [digital-twin](./features/digital-twin.md) · [identity-system](./features/identity-system.md) · [soul-system](./features/soul-system.md) · [privacy-center](./features/privacy-center.md) · [post](./features/post.md) (insights design spike: [plans/2026-06-03](./plans/2026-06-03-cross-domain-insights-engine.md))

Knowledge: [brain-system](./features/brain-system.md) · [untrusted messages and GitHub automation](./features/messages-security.md) · [scope adherence](./features/scope-adherence.md)

Create: [writers-room](./features/writers-room.md) · [fableloom](./features/fableloom.md) · [Eidoverse Worlds integration](./features/eidoverse.md) · [OpenWorld historical reference](./features/openworld.md) · [sprite-export-contract](./features/sprite-export-contract.md) · [video-text-encoders](./features/video-text-encoders.md) · [video-speed-profiles](./features/video-speed-profiles.md) · [video-render-batches](./features/video-render-batches.md) · [video-upscale](./features/video-upscale.md)

Comms & voice: [beeper](./features/beeper.md) · [openclaw-operator-chat](./features/openclaw-operator-chat.md) ([pre-build audit](./research/2026-03-31-openclaw-operator-chat-audit.md)) · [stacker-news](./features/stacker-news.md) · [voice](./features/voice.md)

## Point-in-time records

- **[plans/](./plans/README.md)** — dated design plans (`YYYY-MM-DD-<slug>.md`), archived on approval before implementation. Historical records, not living docs. See [provider connections and harnesses](./plans/2026-09-06-provider-connections-and-harnesses.md) for stable executable routes, migration and management flows.
- **decisions/** — ADRs (`YYYY-MM-DD-<slug>.md`), e.g. the [Postgres-as-primary-datastore decision](./decisions/2026-06-07-postgres-as-primary-datastore.md) and what may cross the federation layer ([user-controlled federation](./decisions/2026-09-19-user-controlled-federation.md), [Privacy Center storage](./decisions/2026-08-08-privacy-records-machine-local.md), [federated visual prompts](./decisions/2026-08-20-federated-visual-prompts.md), [conditioning crosses to an allowlisted peer](./decisions/2026-08-22-federated-media-input-assets.md), [AI usage metrics federate on by default](./decisions/2026-09-01-federated-usage-metrics.md), [Eidoverse guest chat](./decisions/2026-09-05-eidoverse-guest-chat.md), [numeric PortOS quality federation](./decisions/2026-09-10-portos-quality-federation.md), [federated Eidoverse foundations](./decisions/2026-09-18-federated-eidoverse-foundations.md)), why H3 [ships the draft-decode gates without an asset](./decisions/2026-08-30-h3-draft-decoder-asset.md), and why closed-set decisions run on a [local entailment model that abstains](./decisions/2026-09-18-local-jev-decision-service.md).
- **research/** — dated investigation and incident write-ups (e.g. the [mflux GPU-watchdog panic](./research/2026-06-13-mflux-training-watchdog-panic.md) and the [local LLM performance audit](./research/2026-08-22-local-llm-performance-audit.md)).
- **superpowers/** — plan/spec pairs from superpowers-driven builds: `specs/<date>-<slug>-design.md` (design) + `plans/<date>-<slug>.md` (implementation plan).

## Other

- **[themes/](./themes/README.md)** — UI theme specs and the theme integration contract.
- **[examples/](./examples/README.md)** — copy-ready config examples (e.g. Claude Code → Ollama settings).
- **[`.changelog/README.md`](../.changelog/README.md)** — how `/do:release` synthesizes release notes from the commit log, and the versioned-file format.
- **media/** — screenshots and logo used by the root README.

- [Local managed-app visitor broker](features/managed-visitors.md) — opt-in credential provisioning, versioned nonhumanoid scope and host negotiation.
